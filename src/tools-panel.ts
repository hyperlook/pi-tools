import type { KeybindingsManager, Theme, ThemeColor, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { firstSentence, toolKind, type ToolKind } from "./shared.ts";

const KIND_ORDER: Record<ToolKind, number> = { builtin: 0, loader: 1, user: 2 };
const KIND_BADGE: Record<ToolKind, string> = {
	loader: "[core]",
	builtin: "[builtin]",
	user: "[user]",
};
const KIND_TONE: Record<ToolKind, ThemeColor> = {
	loader: "accent",
	builtin: "muted",
	user: "warning",
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
		return "按需工具调度器：根据任务由模型在对话中自动唤醒未激活的扩展工具。";
	}
	const desc = tool.description ? firstSentence(tool.description) : "";
	return desc || "（该工具暂无详细描述）";
}

function formatToolSource(tool: ToolInfo): string {
	switch (toolKind(tool)) {
		case "loader":
			return "按需调度器 (核心常驻)";
		case "builtin":
			return "内置核心工具";
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

function rowView(theme: Theme, tool: ToolInfo, selected: boolean, enabled: boolean) {
	const kind = toolKind(tool);
	const on = kind === "loader" || enabled;
	const statusTone: ThemeColor = kind === "loader" ? "accent" : on ? "success" : "dim";
	return {
		cursor: selected ? theme.fg("accent", "→ ") : "  ",
		dot: theme.fg(statusTone, on ? "● " : "○ "),
		name: selected ? theme.bold(theme.fg("accent", tool.name)) : tool.name,
		badge: theme.fg(KIND_TONE[kind], KIND_BADGE[kind]),
		status: theme.fg(statusTone, kind === "loader" ? "always on" : on ? "enabled" : "disabled"),
	};
}

type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "toggle" | "quit";

function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (kb.matches(data, "tui.select.confirm") || data === " ") return "toggle";
	if (kb.matches(data, "tui.select.cancel") || data === "q") return "quit";
}

export function createToolsPanel(opts: {
	tui: TUI;
	theme: Theme;
	kb: KeybindingsManager;
	done: (value: undefined) => void;
	tools: ToolInfo[];
	enabled: Set<string>;
	onToggle: (id: string) => void;
}) {
	const { tui, theme, kb, done, tools, enabled, onToggle } = opts;
	const total = tools.length;
	const listH = Math.max(LIST_MIN, Math.min(total, LIST_MAX));
	const nameCol = Math.min(NAME_MAX, Math.max(NAME_MIN, ...tools.map((tool) => visibleWidth(tool.name))));
	let selected = 0;

	return {
		render(width: number) {
			const visible = Math.min(total, listH);
			const start = windowStart(selected, total, visible);
			const list: string[] = [];
			for (let i = start; i < start + visible; i++) {
				const tool = tools[i];
				if (!tool) continue;
				const row = rowView(theme, tool, i === selected, enabled.has(tool.name));
				list.push(truncateToWidth(
					`${row.cursor}${row.dot}${padEndVisible(row.name, nameCol + 2)} ${padEndVisible(row.badge, BADGE_COL)}  ${row.status}`,
					width,
				));
			}
			while (list.length < listH) list.push("");

			const current = tools[selected];
			const detail = current
				? [
					truncateToWidth(`  说明: ${theme.fg("accent", formatToolDescription(current))}`, width),
					truncateToWidth(`  来源: ${theme.fg("muted", formatToolSource(current))}`, width),
				]
				: ["", ""];

			return [
				theme.fg("accent", theme.bold("Tool Configuration")),
				theme.fg("muted", "开关当前会话。非内置选择存为以后默认，内置只影响本场。"),
				"",
				...list,
				total > listH ? theme.fg("dim", `  (${selected + 1}/${total})`) : "",
				theme.fg("dim", "─".repeat(Math.min(width, DIVIDER_MAX))),
				...detail,
				"",
				truncateToWidth(
					theme.fg("muted", "  ↑/↓: 移动光标  ·  Space/Enter: 切换状态  ·  Esc: 保存退出"),
					width,
				),
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
			if (total === 0) return;

			if (action === "up") selected = selected === 0 ? total - 1 : selected - 1;
			else if (action === "down") selected = selected === total - 1 ? 0 : selected + 1;
			else if (action === "pageUp") selected = Math.max(0, selected - PAGE_SIZE);
			else if (action === "pageDown") selected = Math.min(total - 1, selected + PAGE_SIZE);
			else if (action === "toggle") {
				const tool = tools[selected];
				if (tool && toolKind(tool) !== "loader") onToggle(tool.name);
			}
			tui.requestRender();
		},
	};
}
