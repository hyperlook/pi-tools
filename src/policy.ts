import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { exposureOf, exposuresEqual, isManageable, parseExposures, SEARCH_TOOL_NAME, type ToolExposures } from "./shared.ts";

export const STATE_ENTRY = "tools-exposure-policy";
export interface PolicyState {
	applied: ToolExposures;
	services: string[];
}
export interface PolicyPlan extends PolicyState {
	active: Set<string>;
	missingSearch: boolean;
	missingCodemode: boolean;
}
export function lastPolicyState(entries: readonly { type: string; customType?: string; data?: unknown }[]): PolicyState {
	let state: PolicyState = { applied: {}, services: [] };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Partial<PolicyState>;
		const applied = parseExposures(data.applied);
		if (applied && Array.isArray(data.services) && data.services.every((s) => s === SEARCH_TOOL_NAME || s === "codemode")) {
			state = { applied, services: data.services };
		}
	}
	return state;
}
/** Change only newly applied exposures; Pi owns search-loaded tools and branch restoration. */
export function planPolicy(activeNames: Iterable<string>, tools: readonly ToolInfo[], overrides: ToolExposures,
	previous: ToolExposures = {}, previousServices: readonly string[] = []): PolicyPlan {
	const active = new Set(activeNames);
	const applied = new Map(Object.entries(previous));
	let changedLazy = false;
	let changedCodemode = false;
	let hasLazy = false;
	let hasCodemode = false;
	for (const tool of tools) {
		if (!isManageable(tool)) continue;
		const target = Object.hasOwn(overrides, tool.name) ? overrides[tool.name] : undefined;
		const before = Object.hasOwn(previous, tool.name) ? previous[tool.name] : undefined;
		if (target && exposureOf(tool) !== target) {
			throw new Error(`pi-tools: exposure override for ${tool.name} did not take effect (expected ${target}, got ${exposureOf(tool)})`);
		}
		if (target !== before) {
			if (exposureOf(tool) === "direct") active.add(tool.name);
			else { active.delete(tool.name); changedLazy = true; }
			changedCodemode ||= target === "codemode";
		}
		if (target) applied.set(tool.name, target);
		else applied.delete(tool.name);
		hasLazy ||= target === "deferred" || target === "codemode";
		hasCodemode ||= target === "codemode";
	}
	const available = (name: string) => tools.some((t) => t.name === name && exposureOf(t) !== "hidden");
	// Existing orchestrators only. Do not repeatedly undo other extensions' runtime choices.
	if (hasLazy && (changedLazy || !previousServices.includes(SEARCH_TOOL_NAME)) && available(SEARCH_TOOL_NAME)) active.add(SEARCH_TOOL_NAME);
	if (hasCodemode && (changedCodemode || !previousServices.includes("codemode")) && available("codemode")) active.add("codemode");
	const services = [...new Set([...previousServices, ...[SEARCH_TOOL_NAME, "codemode"].filter(available)])];
	return { active, applied: Object.fromEntries(applied), services,
		missingSearch: hasLazy && !available(SEARCH_TOOL_NAME), missingCodemode: hasCodemode && !available("codemode") };
}
export function sameNames(a: Iterable<string>, b: Iterable<string>): boolean {
	const left = new Set(a), right = new Set(b);
	return left.size === right.size && [...left].every((name) => right.has(name));
}
export { exposuresEqual };
