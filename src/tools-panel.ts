import type { KeybindingsManager, Theme, ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ConfigScope } from "./config.ts";
import { configuredExposure, exposureOf, exposuresEqual, firstSentence, isExposureMode, isManageable, lockReason,
	nextExposure, toolKind, type ToolExposures, type ToolKind } from "./shared.ts";

const KIND_ORDER: Record<ToolKind, number> = { builtin: 0, service: 1, extension: 2, protected: 3 };
export function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => KIND_ORDER[toolKind(a)] - KIND_ORDER[toolKind(b)] || a.name.localeCompare(b.name));
}
export type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "toggle" | "toggleScope" | "resetProject" | "resetTool" | "save" | "cancel";
export function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (data === " ") return "toggle";
	if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\r" || data === "\n") return "save";
	if (matchesKey(data, Key.tab) || data === "\t") return "toggleScope";
	if (data === "r" || data === "R") return "resetProject";
	if (data === "d" || data === "D") return "resetTool";
	if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") return "cancel";
}
export interface ToolsPanelSaveResult {
	globalExposures: ToolExposures;
	projectExposures: ToolExposures | undefined;
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
	initialProjectExposures: ToolExposures | undefined;
}
export function createToolsPanel(opts: ToolsPanelOptions) {
	const { tui, theme, kb, done, tools, activeNames } = opts;
	let selected = 0;
	let scope = opts.initialScope;
	const globalDraft = { ...opts.initialGlobalExposures };
	let projectDraft = { ...opts.initialProjectExposures };
	let customized = opts.initialProjectExposures !== undefined;
	let notice = "";
	const original = (tool: ToolInfo) => opts.originalExposures.get(tool.name) ?? exposureOf(tool);
	const draft = () => scope === "project" && customized ? projectDraft : globalDraft;
	const choice = (tool: ToolInfo) => configuredExposure(draft(), tool.name, original(tool));
	function editDraft(): ToolExposures {
		if (scope === "project" && !customized) { projectDraft = { ...globalDraft }; customized = true; }
		return draft();
	}
	function dirty(): boolean {
		return !exposuresEqual(globalDraft, opts.initialGlobalExposures) ||
			customized !== (opts.initialProjectExposures !== undefined) ||
			(customized && !exposuresEqual(projectDraft, opts.initialProjectExposures ?? {}));
	}
	return {
		invalidate() {},
		render(width: number): string[] {
			const inherited = scope === "project" && !customized;
			const height = Math.min(tools.length, 12);
			const start = Math.max(0, Math.min(selected - Math.floor(height / 2), tools.length - height));
			const lines = [
				theme.bold(theme.fg("accent", "Tool Exposure")),
				`${scope === "global" ? "Global" : "Project"} · ${scope === "project" ? (inherited ? "inherit global" : "customized") : "global overrides"}${dirty() ? " · unsaved *" : ""}`,
				theme.fg("dim", scope === "project" ? opts.projectDisplayPath : opts.globalDisplayPath),
				"",
			];
			const nameCol = Math.min(28, Math.max(0, ...tools.map((t) => t.name.length)));
			for (let i = start; i < start + height; i++) {
				const tool = tools[i]!;
				const editable = isManageable(tool);
				const pointer = i === selected ? "→" : " ";
				const dot = activeNames.has(tool.name) ? theme.fg("success", "●") : theme.fg("dim", "○");
				const nameText = tool.name.padEnd(nameCol, " ");
				const toolName = i === selected ? theme.bold(nameText) : nameText;
				let modeText: string;
				if (editable) {
					const exp = choice(tool);
					const overridden = Object.hasOwn(draft(), tool.name);
					modeText = overridden ? theme.fg("accent", `${exp} *`) : theme.fg("muted", exp);
				} else {
					modeText = theme.fg("dim", `readonly [${toolKind(tool)}]`);
				}
				lines.push(`${pointer} ${dot} ${toolName}  ${modeText}`);
			}
			if (!tools.length) lines.push(theme.fg("muted", "No registered tools found"));
			const tool = tools[selected];
			lines.push("", theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, 70)))));
			if (tool) {
				const editable = isManageable(tool);
				const isOverridden = Object.hasOwn(draft(), tool.name) && editable;
				const targetLabel = `${choice(tool)}${isOverridden ? " (override *)" : ""}`;
				lines.push(
					theme.bold(tool.name),
					`current: ${exposureOf(tool)} · original: ${original(tool)} · target: ${targetLabel}`,
					firstSentence(tool.description) || "(no description)",
				);
				const reason = lockReason(tool);
				if (reason) lines.push(theme.fg("warning", reason));
				else lines.push(
					"direct: in context · codemode: script sandbox · deferred: on-demand search",
					"* custom override (press 'd' to reset) · ● loaded in context (○ unloaded)",
				);
			}
			lines.push(
				"",
				"↑↓/jk navigate · Space cycle mode · d reset tool · Tab scope",
				"r reset project to inherit · Enter save & reload · Esc/q cancel",
			);
			if (notice) lines.push(theme.fg("warning", notice));
			return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
		},
		handleInput(data: string) {
			const action = readAction(kb, data);
			if (!action) return;
			if (action === "cancel") { done(undefined); return; }
			if (action === "save") {
				done({ globalExposures: { ...globalDraft }, projectExposures: customized ? { ...projectDraft } : undefined });
				return;
			}
			if (action === "up" || action === "pageUp") selected = Math.max(0, selected - (action === "up" ? 1 : 8));
			if (action === "down" || action === "pageDown") selected = Math.max(0, Math.min(tools.length - 1, selected + (action === "down" ? 1 : 8)));
			if (action === "toggleScope") {
				if (opts.isEnvOverridden) notice = "PI_TOOLS_CONFIG overrides config file location";
				else if (!opts.canUseProjectScope) notice = "Project untrusted; cannot edit project config";
				else { scope = scope === "global" ? "project" : "global"; notice = ""; }
			}
			if (action === "resetProject" && scope === "project") {
				customized = false; projectDraft = {}; notice = "Project config reset; will inherit global on save";
			}
			if (action === "toggle" || action === "resetTool") {
				const tool = tools[selected];
				const current = tool && choice(tool);
				if (tool && !isManageable(tool)) notice = lockReason(tool) ?? "This tool cannot be edited";
				else if (tool && isExposureMode(current)) {
					const next = nextExposure(current);
					const modes = editDraft();
					if (action === "resetTool") delete modes[tool.name];
					else Object.defineProperty(modes, tool.name, { value: next, writable: true, enumerable: true, configurable: true });
					notice = "";
				}
			}
			tui.requestRender();
		},
	};
}
