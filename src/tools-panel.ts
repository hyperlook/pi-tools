import type { KeybindingsManager, Theme, ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ConfigScope } from "./config.ts";
import { configuredExposure, exposureOf, firstSentence, isExposureMode, isManageable, lockReason,
	nextExposure, prevExposure, toolKind, type ToolExposures, type ToolKind } from "./shared.ts";

/** Editable extension tools first; locked tools (builtin, services, protected) are grouped after them. */
const KIND_ORDER: Record<ToolKind, number> = { extension: 0, builtin: 1, service: 2, protected: 3 };
export function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => KIND_ORDER[toolKind(a)] - KIND_ORDER[toolKind(b)] || a.name.localeCompare(b.name));
}
const MODE_HINTS: Record<string, string> = {
	direct: "direct: always in context, callable by name",
	codemode: "codemode: hidden from context, callable from the script sandbox",
	deferred: "deferred: hidden until found via tool_search",
};

export type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "first" | "last" | "next" | "prev" | "toggleScope" | "resetProject" | "resetTool" | "save" | "cancel";
export function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (matchesKey(data, Key.home)) return "first";
	if (matchesKey(data, Key.end)) return "last";
	if (data === " ") return "next";
	if (matchesKey(data, Key.right)) return "next";
	if (matchesKey(data, Key.left)) return "prev";
	if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\r" || data === "\n") return "save";
	if (matchesKey(data, Key.tab) || data === "\t") return "toggleScope";
	if (data === "r" || data === "R") return "resetProject";
	if (data === "d" || data === "D") return "resetTool";
	if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") return "cancel";
}
export interface ToolsPanelSaveResult {
	globalExposures: ToolExposures;
	projectExposures: ToolExposures;
}
export interface ToolsPanelOptions {
	tui: TUI;
	theme: Theme;
	kb: KeybindingsManager;
	done: (value: ToolsPanelSaveResult | undefined) => void;
	tools: ToolInfo[];
	originalExposures: ReadonlyMap<string, ToolExposure>;
	activeNames: ReadonlySet<string>;
	initialScope: ConfigScope;
	canUseProjectScope: boolean;
	projectDisplayPath: string;
	globalDisplayPath: string;
	isEnvOverridden?: boolean;
	initialGlobalExposures: ToolExposures;
	initialProjectExposures: ToolExposures;
}
type Source = "default" | "global" | "project";
function changedCount(a: ToolExposures, b: ToolExposures): number {
	return new Set([...Object.keys(a), ...Object.keys(b)]).size -
		Object.keys(a).filter((name) => Object.hasOwn(b, name) && a[name] === b[name]).length;
}
function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}
export function createToolsPanel(opts: ToolsPanelOptions) {
	const { tui, theme, kb, done, tools, activeNames } = opts;
	let selected = 0;
	let start = 0;
	let scope = opts.initialScope;
	const drafts: Record<ConfigScope, ToolExposures> = { global: { ...opts.initialGlobalExposures }, project: { ...opts.initialProjectExposures } };
	let notice = "";
	const original = (tool: ToolInfo) => opts.originalExposures.get(tool.name) ?? exposureOf(tool);
	/** Effective value as seen from the layer being edited, plus the layer that supplies it. */
	function resolve(tool: ToolInfo): { mode: ToolExposure; source: Source } {
		let mode = original(tool), source: Source = "default";
		for (const layer of ["global", "project"] as const) {
			if (layer === "project" && scope === "global") break;
			if (Object.hasOwn(drafts[layer], tool.name)) { mode = configuredExposure(drafts[layer], tool.name, mode); source = layer; }
		}
		return { mode, source };
	}
	const hasOwn = (tool: ToolInfo) => Object.hasOwn(drafts[scope], tool.name);
	const shadowed = (tool: ToolInfo) => scope === "global" && Object.hasOwn(drafts.project, tool.name);
	const changes = () => changedCount(drafts.global, opts.initialGlobalExposures) + changedCount(drafts.project, opts.initialProjectExposures);
	const singleLine = (text: string) => text.replace(/\s+/gu, " ").trim();
	const nameWidth = tools.reduce((max, tool) => Math.max(max, visibleWidth(singleLine(tool.name))), 0);
	function layout() {
		const rows = tui.terminal?.rows ?? 30;
		const compact = rows < 22;
		// Reserve two rows for the host UI. All non-list regions have stable heights.
		const fixedRows = compact ? 10 : 12;
		return { compact, tooShort: rows < 15, height: Math.min(12, Math.max(1, rows - 2 - fixedRows)) };
	}
	const accent = (text: string) => theme.fg("accent", text);
	const dim = (text: string) => theme.fg("dim", text);
	return {
		invalidate() {},
		render(width: number): string[] {
			const projectEmpty = !Object.keys(drafts.project).length;
			const { compact, tooShort, height: pageSize } = layout();
			const fit = (line: string) => truncateToWidth(singleLine(line), Math.max(0, width));
			if (tooShort) return [theme.bold(accent("Tool Exposure")), "Enlarge terminal to at least 15 rows", "Enter save & reload · Esc cancel"].map(fit);
			const height = Math.min(Math.max(1, tools.length), pageSize);
			// Scroll only at the viewport edges; moving within it leaves the list stationary.
			start = Math.max(0, Math.min(start, selected, Math.max(0, tools.length - height)));
			if (selected >= start + height) start = selected - height + 1;
			const tab = (name: ConfigScope, label: string) => scope === name ? theme.bold(accent(`[${label}]`)) : dim(` ${label} `);
			const barWidth = Math.max(0, width);
			const rule = (label = "") => {
				const prefix = truncateToWidth(label ? `─ ${label} ` : "", barWidth);
				return dim(prefix + "─".repeat(Math.max(0, barWidth - visibleWidth(prefix))));
			};
			const lines = [
				theme.bold(accent("Tool Exposure")),
				`${tab("global", "Global")} ${tab("project", "Project")}${opts.isEnvOverridden ? dim("  PI_TOOLS_CONFIG in use") : !opts.canUseProjectScope ? dim("  project untrusted") : ""}`,
				...(!compact ? [dim(scope === "project" ? `${opts.projectDisplayPath}${projectEmpty ? " · no overrides, inheriting global" : ""}` : opts.globalDisplayPath), ""] : []),
			];
			const nameCol = Math.min(28, Math.max(4, nameWidth), Math.max(4, width - 40));
			const modeCol = 22;
			lines.push(dim(`    ${"tool".padEnd(nameCol)}  ${"mode".padEnd(modeCol)}  source`));
			lines.push(rule());
			for (let i = start; i < Math.min(tools.length, start + height); i++) {
				const tool = tools[i]!;
				const dot = activeNames.has(tool.name) ? theme.fg("success", "●") : dim("○");
				const clippedName = truncateToWidth(singleLine(tool.name), nameCol);
				const nameText = clippedName + " ".repeat(Math.max(0, nameCol - visibleWidth(clippedName)));
				const name = i === selected ? theme.bold(nameText) : nameText;
				let modeText: string, sourceText: string;
				if (isManageable(tool)) {
					const { mode, source } = resolve(tool);
					const now = exposureOf(tool);
					const pending = !shadowed(tool) && now !== mode;
					const label = (pending ? `${now} → ${mode}` : mode).padEnd(modeCol);
					modeText = pending ? theme.fg("warning", label) : source === "default" ? theme.fg("muted", label) : accent(label);
					sourceText = dim(shadowed(tool) ? `global · project: ${drafts.project[tool.name]}` : source);
				} else {
					modeText = dim(String(exposureOf(tool)).padEnd(modeCol));
					sourceText = dim(`${toolKind(tool)} ⊘`);
				}
				lines.push(`${i === selected ? "→" : " "} ${dot} ${name}  ${modeText}  ${sourceText}`);
			}
			if (!tools.length) lines.push(theme.fg("muted", "No registered tools found"));
			const tool = tools[selected];
			const end = Math.min(tools.length, start + height);
			lines.push(rule(tools.length ? `${selected + 1} / ${tools.length}${start > 0 ? " · ↑ more" : ""}${end < tools.length ? " · ↓ more" : ""}` : "0 tools"));
			// Each detail owns exactly one physical terminal row, including locked/empty states.
			const details = ["", ""];
			if (tool) {
				const reason = lockReason(tool);
				const { mode } = resolve(tool);
				details[0] = firstSentence(tool.description) || "(no description)";
				details[1] = reason ? theme.fg("warning", reason) : dim(MODE_HINTS[mode] ?? "");
			}
			lines.push(...details);
			const n = changes();
			const selectedTool = tool && isManageable(tool) ? tool : undefined;
			const fmt = (keys: (string[] | false)[]) => keys.filter((k): k is string[] => !!k)
				.map(([k, v]) => `${accent(k!)} ${dim(v!)}`).join(dim(" · "));
			lines.push(
				notice ? theme.fg("warning", notice) : fmt([
					!!selectedTool && ["←→/Space", "change mode"],
					!!selectedTool && hasOwn(selectedTool) && ["d", "clear override"],
					scope === "project" && !projectEmpty && ["r", "clear all project overrides"],
				]),
				fmt([["↑↓/jk", "move"], ["PgUp/PgDn", "page"], ["Home/End", "first/last"]]),
				fmt([["Tab", `scope → ${scope === "global" ? "project" : "global"}`],
					["Enter", `save & reload${n ? ` (${plural(n, "change")})` : ""}`], ["Esc", "cancel"]]));
			// Do not collapse layout padding; only normalize embedded row-breaking characters.
			return lines.map((line) => truncateToWidth(line.replace(/[\r\n\t\u2028\u2029]+/gu, " "), Math.max(0, width)));
		},
		handleInput(data: string) {
			const action = readAction(kb, data);
			if (!action) return;
			if (action === "cancel") { done(undefined); return; }
			if (action === "save") { done({ globalExposures: { ...drafts.global }, projectExposures: { ...drafts.project } }); return; }
			if (layout().tooShort) return; // Never edit a selection that cannot be seen.
			notice = "";
			const pageSize = layout().height;
			if (action === "up" || action === "pageUp") selected = Math.max(0, selected - (action === "up" ? 1 : pageSize));
			if (action === "down" || action === "pageDown") selected = Math.max(0, Math.min(tools.length - 1, selected + (action === "down" ? 1 : pageSize)));
			if (action === "first") selected = 0;
			if (action === "last") selected = Math.max(0, tools.length - 1);
			if (action === "toggleScope") {
				if (opts.isEnvOverridden) notice = "PI_TOOLS_CONFIG overrides config file location";
				else if (!opts.canUseProjectScope) notice = "Project untrusted; cannot edit project config";
				else { scope = scope === "global" ? "project" : "global"; notice = ""; }
			}
			if (action === "resetProject" && scope === "project") {
				drafts.project = {}; notice = "Project overrides cleared; inheriting global";
			}
			if (action === "next" || action === "prev" || action === "resetTool") {
				const tool = tools[selected];
				if (tool && !isManageable(tool)) notice = lockReason(tool) ?? "This tool cannot be edited";
				else if (tool) {
					const { mode } = resolve(tool);
					const layer = drafts[scope];
					if (action === "resetTool") delete layer[tool.name];
					else if (isExposureMode(mode)) {
						const value = action === "next" ? nextExposure(mode) : prevExposure(mode);
						Object.defineProperty(layer, tool.name, { value, writable: true, enumerable: true, configurable: true });
					}
					notice = "";
				}
			}
			tui.requestRender();
		},
	};
}
