import type { KeybindingsManager, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ConfigScope } from "./config.ts";
import { exposureOf, firstSentence, isManageable, lockReason, MODE_LABELS, modeOf, modesEqual, nextMode, toolKind, type ToolKind, type ToolModes } from "./shared.ts";

const KIND_ORDER: Record<ToolKind, number> = { builtin: 0, service: 1, native: 2, unsupported: 3 };
const BADGES: Record<ToolKind, string> = { builtin: "[builtin]", service: "[Pi]", native: "[native]", unsupported: "[未适配]" };
export function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => KIND_ORDER[toolKind(a)] - KIND_ORDER[toolKind(b)] || a.name.localeCompare(b.name));
}
export type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "toggle" | "toggleScope" | "resetInherit" | "save" | "cancel";
export function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (data === " ") return "toggle";
	if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\r" || data === "\n") return "save";
	if (matchesKey(data, Key.tab) || data === "\t") return "toggleScope";
	if (data === "r" || data === "R") return "resetInherit";
	if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") return "cancel";
}
export interface ToolsPanelSaveResult {
	globalModes: ToolModes;
	projectModes: ToolModes | undefined;
}
export interface ToolsPanelOptions {
	tui: TUI;
	theme: Theme;
	kb: KeybindingsManager;
	done: (value: undefined) => void;
	tools: ToolInfo[];
	activeNames: ReadonlySet<string>;
	initialScope: ConfigScope;
	canUseProjectScope: boolean;
	projectDisplayPath: string;
	globalDisplayPath: string;
	isEnvOverridden?: boolean;
	initialGlobalModes: ToolModes;
	initialProjectModes: ToolModes | undefined;
	onSave: (result: ToolsPanelSaveResult) => void;
}
export function createToolsPanel(opts: ToolsPanelOptions) {
	const { tui, theme, kb, done, tools, activeNames } = opts;
	let selected = 0;
	let scope = opts.initialScope;
	const globalDraft = { ...opts.initialGlobalModes };
	let projectDraft = { ...opts.initialProjectModes };
	let customized = opts.initialProjectModes !== undefined;
	let notice = "";
	function draft(): ToolModes {
		return scope === "project" && customized ? projectDraft : globalDraft;
	}
	function dirty(): boolean {
		return !modesEqual(globalDraft, opts.initialGlobalModes) ||
			customized !== (opts.initialProjectModes !== undefined) ||
			(customized && !modesEqual(projectDraft, opts.initialProjectModes ?? {}));
	}
	return {
		invalidate() {},
		render(width: number): string[] {
			const modes = draft();
			const inherited = scope === "project" && !customized;
			const height = Math.min(tools.length, 12);
			const start = Math.max(0, Math.min(selected - Math.floor(height / 2), tools.length - height));
			const lines = [
				theme.bold(theme.fg("accent", "工具加载偏好")),
				`${scope === "global" ? "Global" : "Project"} · ${scope === "project" ? (inherited ? "继承全局" : "已定制") : "全局偏好"}${dirty() ? " · 未保存 *" : ""}`,
				theme.fg("dim", scope === "project" ? opts.projectDisplayPath : opts.globalDisplayPath),
				"",
			];
			for (let i = start; i < start + height; i++) {
				const tool = tools[i]!;
				const editable = isManageable(tool);
				const label = editable ? MODE_LABELS[modeOf(modes, tool.name)] : "只读";
				const tone = editable ? (modeOf(modes, tool.name) === "inherit" ? "muted" : "accent") : "dim";
				const badge = exposureOf(tool) === "hidden" ? "[hidden]" : BADGES[toolKind(tool)];
				const row = `${i === selected ? "→" : " "} ${badge} ${tool.name}  ${label}${inherited && editable ? " ⇡" : ""} · ${activeNames.has(tool.name) ? "已声明" : "未声明"}`;
				lines.push(theme.fg(tone, row));
			}
			if (!tools.length) lines.push(theme.fg("muted", "没有已注册的工具"));
			const tool = tools[selected];
			lines.push("", theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, 70)))));
			if (tool) {
				lines.push(theme.bold(tool.name), `Exposure: ${exposureOf(tool)} · ${tool.sourceInfo?.source ?? "扩展"}`,
					firstSentence(tool.description) || "（暂无描述）");
				const reason = lockReason(tool);
				if (reason) lines.push(theme.fg("warning", reason));
				else lines.push("跟随：不覆盖当前状态；常驻：应用时声明；按需：由 Pi 搜索加载",
					"按需不是禁用；codemode 工具仍可由脚本访问，原始 exposure 不变");
			}
			lines.push("", "↑↓/jk 浏览 · Space 跟随→常驻→按需 · Tab 作用域",
				"r 项目继承全局 · Enter 保存 · Esc/q 取消");
			if (notice) lines.push(theme.fg("warning", notice));
			return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
		},
		handleInput(data: string) {
			const action = readAction(kb, data);
			if (!action) return;
			if (action === "cancel") { done(undefined); return; }
			if (action === "save") {
				opts.onSave({ globalModes: { ...globalDraft }, projectModes: customized ? { ...projectDraft } : undefined });
				done(undefined);
				return;
			}
			if (action === "up" || action === "pageUp") selected = Math.max(0, selected - (action === "up" ? 1 : 8));
			if (action === "down" || action === "pageDown") selected = Math.max(0, Math.min(tools.length - 1, selected + (action === "down" ? 1 : 8)));
			if (action === "toggleScope") {
				if (opts.isEnvOverridden) notice = "PI_TOOLS_CONFIG 已指定唯一配置文件";
				else if (!opts.canUseProjectScope) notice = "项目未信任，不能编辑项目配置";
				else { scope = scope === "global" ? "project" : "global"; notice = ""; }
			}
			if (action === "resetInherit") {
				if (scope === "project") { customized = false; projectDraft = {}; notice = "已重置项目配置，保存后恢复继承全局"; }
			}
			if (action === "toggle") {
				const tool = tools[selected];
				if (tool && !isManageable(tool)) notice = lockReason(tool) ?? "此工具不可编辑";
				else if (tool) {
					if (scope === "project" && !customized) { projectDraft = { ...globalDraft }; customized = true; }
					const modes = draft();
					const next = nextMode(modeOf(modes, tool.name));
					if (next === "inherit") delete modes[tool.name];
					else Object.defineProperty(modes, tool.name, { value: next, writable: true, enumerable: true, configurable: true });
					notice = "";
				}
			}
			tui.requestRender();
		},
	};
}
