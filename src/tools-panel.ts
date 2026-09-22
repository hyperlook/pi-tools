import type { KeybindingsManager, Theme, ThemeColor, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ConfigScope } from "./config.ts";
import { firstSentence, isBuiltin, toolKind, type ToolKind } from "./shared.ts";

const KIND_ORDER: Record<ToolKind, number> = { builtin: 0, loader: 1, user: 2 };
const KIND_BADGE: Record<ToolKind, string> = {
	loader: "[core]",
	builtin: "[builtin]",
	user: "[user]",
};

const LIST_MIN = 10;
const LIST_MAX = 16;
const NAME_MIN = 16;
const NAME_MAX = 26;
const PAGE_SIZE = 8;
const DIVIDER_MAX = 70;
const BADGE_COL = Math.max(...Object.values(KIND_BADGE).map((badge) => visibleWidth(badge)));

export function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => {
		const delta = KIND_ORDER[toolKind(a)] - KIND_ORDER[toolKind(b)];
		return delta !== 0 ? delta : a.name.localeCompare(b.name);
	});
}

function formatToolDescription(tool: ToolInfo): string {
	if (toolKind(tool) === "loader") {
		return "按需工具调度器：根据任务由模型在对话中自动激活未启用的扩展工具。";
	}
	const desc = tool.description ? firstSentence(tool.description) : "";
	return desc || "（该工具暂无详细描述）";
}

function formatToolSource(tool: ToolInfo): string {
	switch (toolKind(tool)) {
		case "loader":
			return "按需调度器 (白名单控制 · 可持久化配置)";
		case "builtin":
			return "内置核心工具 (Pi 官方 settings.json 托管 · 本面板只读)";
		default: {
			const raw = tool.sourceInfo?.source || "";
			if (raw.startsWith("npm:")) return raw.slice(4);
			if (raw.includes("/")) {
				const parts = raw.split("/").filter(Boolean);
				return parts[parts.length - 1] || raw;
			}
			return raw || "扩展插件";
		}
	}
}

function padEndVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function windowStart(selected: number, total: number, visible: number): number {
	if (total <= visible) return 0;
	return Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
}

function rowView(
	theme: Theme,
	tool: ToolInfo,
	selected: boolean,
	isBuiltinTool: boolean,
	isActive: boolean,
) {
	const kind = toolKind(tool);

	if (isBuiltinTool) {
		const dot = theme.fg(isActive ? "muted" : "dim", isActive ? "● " : "○ ");
		const name = selected
			? theme.bold(theme.fg("muted", tool.name))
			: theme.fg("muted", tool.name);
		const badge = theme.fg("dim", KIND_BADGE[kind]);
		const statusText = isActive ? "active 🔒" : "inactive 🔒";
		const status = theme.fg(isActive ? "muted" : "dim", statusText);
		return {
			cursor: selected ? theme.fg("dim", "→ ") : "  ",
			dot,
			name,
			badge,
			status,
		};
	}

	const statusTone: ThemeColor = isActive ? "success" : "dim";
	const kindTone: ThemeColor = kind === "loader" ? "accent" : "warning";
	return {
		cursor: selected ? theme.fg("accent", "→ ") : "  ",
		dot: theme.fg(statusTone, isActive ? "● " : "○ "),
		name: selected ? theme.bold(theme.fg("accent", tool.name)) : tool.name,
		badge: theme.fg(kindTone, KIND_BADGE[kind]),
		status: theme.fg(statusTone, isActive ? "enabled" : "disabled"),
	};
}

type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "toggle" | "toggleScope" | "quit";

function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (kb.matches(data, "tui.select.confirm") || data === " ") return "toggle";
	if (matchesKey(data, Key.tab) || data === "\t") return "toggleScope";
	if (kb.matches(data, "tui.select.cancel") || data === "q") return "quit";
}

export interface ToolsPanelOptions {
	tui: TUI;
	theme: Theme;
	kb: KeybindingsManager;
	done: (value: undefined) => void;
	tools: ToolInfo[];
	activeBuiltinTools: Set<string>;
	initialScope: ConfigScope;
	canUseProjectScope: boolean;
	projectDisplayPath: string;
	globalDisplayPath: string;
	isEnvOverridden?: boolean;
	getScopeEnabled: (scope: ConfigScope) => Set<string>;
	onToggle: (id: string, scope: ConfigScope) => void;
}

export function createToolsPanel(opts: ToolsPanelOptions) {
	const {
		tui,
		theme,
		kb,
		done,
		tools,
		activeBuiltinTools,
		initialScope,
		canUseProjectScope,
		projectDisplayPath,
		globalDisplayPath,
		isEnvOverridden,
		getScopeEnabled,
		onToggle,
	} = opts;

	const total = tools.length;
	const listH = Math.max(LIST_MIN, Math.min(total, LIST_MAX));
	const nameCol = Math.min(NAME_MAX, Math.max(NAME_MIN, ...tools.map((tool) => visibleWidth(tool.name))));
	let selected = 0;
	let currentScope: ConfigScope = initialScope;
	let warningNotice: string | undefined;

	return {
		render(width: number) {
			const scopeEnabled = getScopeEnabled(currentScope);
			const visible = Math.min(total, listH);
			const start = windowStart(selected, total, visible);
			const list: string[] = [];
			for (let i = start; i < start + visible; i++) {
				const tool = tools[i];
				if (!tool) continue;
				const isBuiltinTool = isBuiltin(tool);
				const isActive = isBuiltinTool
					? activeBuiltinTools.has(tool.name)
					: scopeEnabled.has(tool.name);

				const row = rowView(theme, tool, i === selected, isBuiltinTool, isActive);
				list.push(truncateToWidth(
					`${row.cursor}${row.dot}${padEndVisible(row.name, nameCol + 2)} ${padEndVisible(row.badge, BADGE_COL)}  ${row.status}`,
					width,
				));
			}
			while (list.length < listH) list.push("");

			const current = tools[selected];
			const isBuiltinTool = current ? isBuiltin(current) : false;
			const isBuiltinActive = isBuiltinTool && current ? activeBuiltinTools.has(current.name) : false;
			const targetDisplay = currentScope === "project" ? projectDisplayPath : globalDisplayPath;

			let noticeLine: string;
			if (warningNotice) {
				noticeLine = theme.fg("warning", `  ⚠️  ${warningNotice}`);
			} else if (isBuiltinTool) {
				noticeLine = isBuiltinActive
					? theme.fg("muted", "  状态: 已由 Pi 官方启用（锁定只读 · 需在 settings.json defaultTools 中调整）")
					: theme.fg("dim", "  状态: 未被 Pi 官方启用（锁定只读 · 需在 settings.json defaultTools 中添加）");
			} else {
				noticeLine = theme.fg("dim", `  提示: 开关将写入当前白名单配置 (${targetDisplay})`);
			}

			const detail = current
				? [
					truncateToWidth(`  说明: ${theme.fg("accent", formatToolDescription(current))}`, width),
					truncateToWidth(`  来源: ${theme.fg("muted", formatToolSource(current))}`, width),
					truncateToWidth(noticeLine, width),
				]
				: ["", "", ""];

			let scopeTag: string;
			let scopeDesc: string;

			if (isEnvOverridden) {
				scopeTag = theme.fg("warning", `[Env: ${globalDisplayPath}]`);
				scopeDesc = "当前由 PI_TOOLS_CONFIG 环境变量直接接管配置";
			} else if (currentScope === "project") {
				scopeTag = theme.fg("accent", theme.bold(`[Project: ${projectDisplayPath}]`));
				scopeDesc = `白名单写入当前项目 · 按 Tab 切为全局 (${globalDisplayPath})`;
			} else {
				scopeTag = theme.fg("muted", theme.bold(`[Global: ${globalDisplayPath}]`));
				scopeDesc = canUseProjectScope
					? `白名单写入全局默认 · 按 Tab 切为项目 (${projectDisplayPath})`
					: "白名单写入全局默认（当前项目未受信任，不可使用项目级配置）";
			}

			const headerLine = truncateToWidth(
				`${theme.fg("accent", theme.bold("Tool Configuration"))}  ${scopeTag}`,
				width,
			);
			const subLine = truncateToWidth(theme.fg("muted", scopeDesc), width);

			const footerHints = isEnvOverridden || !canUseProjectScope
				? "  ↑/↓: 移动光标  ·  Space/Enter: 切换扩展工具  ·  Esc: 保存退出"
				: "  ↑/↓: 移动光标  ·  Space/Enter: 切换扩展工具  ·  Tab: 切换作用域  ·  Esc: 保存退出";

			return [
				headerLine,
				subLine,
				"",
				...list,
				total > listH ? theme.fg("dim", `  (${selected + 1}/${total})`) : "",
				theme.fg("dim", "─".repeat(Math.min(width, DIVIDER_MAX))),
				...detail,
				"",
				truncateToWidth(theme.fg("muted", footerHints), width),
			];
		},
		invalidate() {},
		handleInput(data: string) {
			const action = readAction(kb, data);
			if (!action) return;
			if (action === "quit") {
				done(undefined);
				return;
			}

			if (action === "toggleScope") {
				warningNotice = undefined;
				if (!isEnvOverridden && canUseProjectScope) {
					currentScope = currentScope === "global" ? "project" : "global";
					tui.requestRender();
				}
				return;
			}

			if (total === 0) return;

			if (action === "up") {
				warningNotice = undefined;
				selected = selected === 0 ? total - 1 : selected - 1;
			} else if (action === "down") {
				warningNotice = undefined;
				selected = selected === total - 1 ? 0 : selected + 1;
			} else if (action === "pageUp") {
				warningNotice = undefined;
				selected = Math.max(0, selected - PAGE_SIZE);
			} else if (action === "pageDown") {
				warningNotice = undefined;
				selected = Math.min(total - 1, selected + PAGE_SIZE);
			} else if (action === "toggle") {
				const tool = tools[selected];
				if (tool) {
					if (isBuiltin(tool)) {
						warningNotice = `内置核心工具 ${tool.name} 由官方托管，请在 settings.json 中调整`;
					} else {
						warningNotice = undefined;
						onToggle(tool.name, currentScope);
					}
				}
			}
			tui.requestRender();
		},
	};
}
