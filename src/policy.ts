import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { exposureOf, isManageable, modeOf, parseModes, SEARCH_TOOL_NAME, type ToolModes } from "./shared.ts";

export const STATE_ENTRY = "tools-loading-policy";
/** Only policy application is persisted. Pi owns the active tools and search-loaded branch state. */
export interface PolicyState {
	appliedModes: ToolModes;
	knownTools: Record<string, ToolExposure>;
}
export interface PolicyPlan {
	active: Set<string>;
	state: PolicyState;
	missingSearch: boolean;
}
const EXPOSURES = ["direct", "model-only", "deferred", "codemode", "hidden"];
export function lastPolicyState(entries: readonly { type: string; customType?: string; data?: unknown }[]): PolicyState | undefined {
	let state: PolicyState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as { appliedModes?: unknown; knownTools?: unknown };
		const modes = parseModes(data.appliedModes);
		if (!modes || !data.knownTools || typeof data.knownTools !== "object" || Array.isArray(data.knownTools)) continue;
		const known = Object.entries(data.knownTools);
		if (known.some(([, exposure]) => !EXPOSURES.includes(exposure))) continue;
		state = { appliedModes: modes, knownTools: Object.fromEntries(known) as Record<string, ToolExposure> };
	}
	return state;
}

/**
 * Apply preference transitions to the live set, never rebuild it from a frozen baseline.
 * Unchanged on-demand preferences must not unload tools found by native tool_search.
 * Unchanged always preferences must not undo another extension's runtime deactivation.
 * Returning to inherit releases control; it does not rewind Pi's current loadout.
 */
export function planPolicy(
	activeNames: Iterable<string>,
	tools: readonly ToolInfo[],
	modes: ToolModes,
	previous?: PolicyState,
): PolicyPlan {
	const active = new Set(activeNames);
	const appliedModes = new Map(Object.entries(previous?.appliedModes ?? {}));
	const knownTools = new Map(Object.entries(previous?.knownTools ?? {}));
	let appliedOnDemand = false;
	let hasOnDemand = false;
	for (const tool of tools) {
		const exposure = exposureOf(tool);
		if (isManageable(tool)) {
			const mode = modeOf(modes, tool.name);
			const changed = mode !== modeOf(previous?.appliedModes ?? {}, tool.name) ||
				knownTools.get(tool.name) !== exposure;
			if (mode === "on-demand") {
				hasOnDemand = true;
				if (changed) { active.delete(tool.name); appliedOnDemand = true; }
			} else if (mode === "always" && changed) {
				active.add(tool.name);
			}
			if (mode === "inherit") appliedModes.delete(tool.name);
			else appliedModes.set(tool.name, mode);
		}
		knownTools.set(tool.name, exposure);
	}
	const search = tools.find((tool) => tool.name === SEARCH_TOOL_NAME && exposureOf(tool) !== "hidden");
	// Enable the host's existing discovery tool only when applying an explicit on-demand preference.
	// A later registration is also handled; we never register a replacement tool or revive excluded tools.
	if (search && hasOnDemand && (appliedOnDemand || previous?.knownTools[SEARCH_TOOL_NAME] !== exposureOf(search))) {
		active.add(SEARCH_TOOL_NAME);
	}
	return { active, state: { appliedModes: Object.fromEntries(appliedModes), knownTools: Object.fromEntries(knownTools) },
		missingSearch: hasOnDemand && !search };
}
export function sameNames(a: Iterable<string>, b: Iterable<string>): boolean {
	const left = new Set(a), right = new Set(b);
	return left.size === right.size && [...left].every((name) => right.has(name));
}
export function stateEqual(a: PolicyState | undefined, b: PolicyState): boolean {
	const canonical = (state: PolicyState | undefined) => state && JSON.stringify([
		Object.entries(state.appliedModes).sort(([a], [b]) => a.localeCompare(b)),
		Object.entries(state.knownTools).sort(([a], [b]) => a.localeCompare(b)),
	]);
	return canonical(a) === canonical(b);
}
