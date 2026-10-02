import type { KeybindingsManager, Theme, ThemeColor, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ConfigScope } from "./config.ts";
import { firstSentence, isBuiltin, isLocked, isOnDemand, isUpstreamManaged, toolKind, type ToolKind } from "./shared.ts";

const KIND_ORDER: Record<ToolKind, number> = { builtin: 0, upstream: 1, loader: 2, user: 3 };
const KIND_BADGE: Record<ToolKind, string> = {
	loader: "[core]",
	builtin: "[builtin]",
	upstream: "[upstream]",
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
			return "按需调度器 (direct 扩展工具的待命池 · 可持久化配置)";
		case "builtin":
			return "内置核心工具 (Pi 官方 defaultTools 托管 · 本面板只读)";
		case "upstream":
			return `上游托管 (${exposureLabel(tool)} · ${upstreamOwner(tool)} · 本面板只读)`;
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

function exposureLabel(tool: ToolInfo): string {
	return tool.exposure ?? "direct";
}

function upstreamOwner(tool: ToolInfo): string {
	return exposureLabel(tool) === "hidden" ? "已注册但不可达" : "tool_search / codemode 接管";
}

function outsideBaseline(tool: ToolInfo, baselineNames: ReadonlySet<string> | undefined): boolean {
	return !!baselineNames && isOnDemand(tool) && !baselineNames.has(tool.name);
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
	locked: boolean,
	isActive: boolean,
	isInherited: boolean,
) {
	const kind = toolKind(tool);

	if (locked) {
		const dot = theme.fg(isActive ? "muted" : "dim", isActive ? "● " : "○ ");
		const name = selected
			? theme.bold(theme.fg("muted", tool.name))
			: theme.fg("muted", tool.name);
		const badge = theme.fg("dim", KIND_BADGE[kind]);
		const statusText = isActive ? "active" : "inactive";
		const lockIcon = theme.fg("dim", " ⊘");
		const status = `${theme.fg(isActive ? "muted" : "dim", statusText)}${lockIcon}`;
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
	const baseStatus = isActive ? "enabled" : "disabled";
	const inheritIcon = isInherited ? theme.fg("dim", " ⇡") : "";

	return {
		cursor: selected ? theme.fg("accent", "→ ") : "  ",
		dot: theme.fg(statusTone, isActive ? "● " : "○ "),
		name: selected ? theme.bold(theme.fg("accent", tool.name)) : tool.name,
		badge: theme.fg(kindTone, KIND_BADGE[kind]),
		status: `${theme.fg(statusTone, baseStatus)}${inheritIcon}`,
	};
}

export type PanelAction =
	| "up"
	| "down"
	| "pageUp"
	| "pageDown"
	| "toggle"
	| "toggleScope"
	| "resetInherit"
	| "save"
	| "cancel";

export function readAction(kb: KeybindingsManager, data: string): PanelAction | undefined {
	if (kb.matches(data, "tui.select.up") || data === "k") return "up";
	if (kb.matches(data, "tui.select.down") || data === "j") return "down";
	if (kb.matches(data, "tui.select.pageUp")) return "pageUp";
	if (kb.matches(data, "tui.select.pageDown")) return "pageDown";
	if (data === " ") return "toggle";
	if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
		return "save";
	}
	if (matchesKey(data, Key.tab) || data === "\t") return "toggleScope";
	if (data === "r" || data === "R") return "resetInherit";
	if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") {
		return "cancel";
	}
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
}

export interface ToolsPanelSaveResult {
	globalEnabled: Set<string>;
	projectEnabled: Set<string> | undefined; // undefined 代表项目继承全局
}

export interface ToolsPanelOptions {
	tui: TUI;
	theme: Theme;
	kb: KeybindingsManager;
	done: (value: undefined) => void;
	tools: ToolInfo[];
	/** Pi 当前实际激活的工具名，锁定行用它显示真实状态。 */
	activeNames: Set<string>;
	/** Pi 愿意激活的名字。不在其中的 direct 扩展工具只读，面板不能拉回。省略则视为全部在基线内。 */
	baselineNames?: ReadonlySet<string>;
	initialScope: ConfigScope;
	canUseProjectScope: boolean;
	projectDisplayPath: string;
	globalDisplayPath: string;
	isEnvOverridden?: boolean;
	initialGlobalEnabled: Set<string>;
	initialProjectEnabled: Set<string> | undefined; // undefined 表示项目未配置，继承全局
	onSave: (result: ToolsPanelSaveResult) => void;
}

export function createToolsPanel(opts: ToolsPanelOptions) {
	const {
		tui,
		theme,
		kb,
		done,
		tools,
		activeNames,
		baselineNames,
		initialScope,
		canUseProjectScope,
		projectDisplayPath,
		globalDisplayPath,
		isEnvOverridden,
		initialGlobalEnabled,
		initialProjectEnabled,
		onSave,
	} = opts;

	const total = tools.length;
	const listH = Math.max(LIST_MIN, Math.min(total, LIST_MAX));
	const nameCol = Math.min(NAME_MAX, Math.max(NAME_MIN, ...tools.map((tool) => visibleWidth(tool.name))));
	let selected = 0;
	let currentScope: ConfigScope = initialScope;

	// 草稿状态机
	const globalDraft = new Set(initialGlobalEnabled);
	let projectCustomized = initialProjectEnabled !== undefined;
	let projectDraft = new Set(initialProjectEnabled ?? initialGlobalEnabled);

	// 用于对比未保存修改（isDirty）
	const origGlobal = new Set(initialGlobalEnabled);
	const origProjectCustomized = initialProjectEnabled !== undefined;
	const origProject = new Set(initialProjectEnabled ?? initialGlobalEnabled);

	let noticeNotice: { text: string; tone: "warning" | "accent" | "muted" } | undefined;

	function isDirty(): boolean {
		if (!setsEqual(globalDraft, origGlobal)) return true;
		if (projectCustomized !== origProjectCustomized) return true;
		if (projectCustomized && !setsEqual(projectDraft, origProject)) return true;
		return false;
	}

	function getActiveSet(): { enabled: Set<string>; isInherited: boolean } {
		if (currentScope === "global") {
			return { enabled: globalDraft, isInherited: false };
		}
		if (projectCustomized) {
			return { enabled: projectDraft, isInherited: false };
		}
		return { enabled: globalDraft, isInherited: true };
	}

	return {
		render(width: number) {
			const { enabled: activeSet, isInherited } = getActiveSet();
			const visible = Math.min(total, listH);
			const start = windowStart(selected, total, visible);
			const list: string[] = [];
			for (let i = start; i < start + visible; i++) {
				const tool = tools[i];
				if (!tool) continue;
				const locked = isLocked(tool) || outsideBaseline(tool, baselineNames);
				const isActive = locked
					? activeNames.has(tool.name)
					: activeSet.has(tool.name);

				const row = rowView(
					theme,
					tool,
					i === selected,
					locked,
					isActive,
					!locked && isInherited,
				);
				list.push(truncateToWidth(
					`${row.cursor}${row.dot}${padEndVisible(row.name, nameCol + 2)} ${padEndVisible(row.badge, BADGE_COL)}  ${row.status}`,
					width,
				));
			}
			while (list.length < listH) list.push("");

			const current = tools[selected];
			const excluded = current ? outsideBaseline(current, baselineNames) : false;
			const locked = current ? isLocked(current) || excluded : false;
			const lockedActive = locked && current ? activeNames.has(current.name) : false;

			let noticeLine: string;
			if (noticeNotice) {
				noticeLine = theme.fg(noticeNotice.tone, `  ${noticeNotice.tone === "warning" ? "⚠️  " : "✓  "}${noticeNotice.text}`);
			} else if (!current) {
				noticeLine = "";
			} else if (isBuiltin(current)) {
				noticeLine = lockedActive
					? theme.fg("muted", "  状态: 系统内置核心工具（⊘ 只读锁定 · 需在 settings.json defaultTools 中调整）")
					: theme.fg("dim", "  状态: 系统内置核心工具（⊘ 未被 Pi 启用 · 需在 settings.json defaultTools 中添加）");
			} else if (isUpstreamManaged(current)) {
				noticeLine = theme.fg("dim", `  状态: exposure=${exposureLabel(current)} · ${upstreamOwner(current)}，不进入待命池`);
			} else if (excluded) {
				noticeLine = theme.fg("dim", "  状态: Pi 未纳入启动集合（defaultTools / --tools / --exclude-tools · 本面板不能拉回）");
			} else if (currentScope === "project") {
				if (!projectCustomized) {
					noticeLine = theme.fg("dim", `  提示: 标记 ⇡ 为继承全局 · 空格切换将以此为基底派生项目配置 (${projectDisplayPath})`);
				} else {
					noticeLine = theme.fg("dim", `  提示: 空格切换将修改项目配置 (${projectDisplayPath}) · 按 r 恢复继承全局`);
				}
			} else {
				noticeLine = theme.fg("dim", `  提示: 空格切换将修改全局默认配置 (${globalDisplayPath})`);
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
				if (projectCustomized) {
					scopeTag = theme.fg("accent", theme.bold(`[Project: 已定制 (${projectDisplayPath})]`));
					scopeDesc = `白名单写入当前项目 · 按 r 恢复继承全局 · 按 Tab 切为全局 (${globalDisplayPath})`;
				} else {
					scopeTag = theme.fg("accent", theme.bold(`[Project: 继承全局 (${globalDisplayPath})]`));
					scopeDesc = `当前项目继承全局配置 · 空格微调将自动派生项目独立配置 · 按 Tab 切为全局`;
				}
			} else {
				scopeTag = theme.fg("muted", theme.bold(`[Global: 全局默认 (${globalDisplayPath})]`));
				scopeDesc = canUseProjectScope
					? `白名单写入全局默认 · 按 Tab 切为项目配置 (${projectDisplayPath})`
					: "白名单写入全局默认（当前项目未受信任，不可使用项目级配置）";
			}

			const dirtyBadge = isDirty() ? theme.fg("warning", " [未保存 *]") : "";
			const headerLine = truncateToWidth(
				`${theme.fg("accent", theme.bold("Tool Configuration"))}  ${scopeTag}${dirtyBadge}`,
				width,
			);
			const subLine = truncateToWidth(theme.fg("muted", scopeDesc), width);

			let footerHints: string;
			if (isEnvOverridden || !canUseProjectScope) {
				footerHints = "  ↑/↓: 移动光标  ·  Space: 切换  ·  Enter: 保存生效  ·  Esc: 取消";
			} else if (currentScope === "project" && projectCustomized) {
				footerHints = "  ↑/↓: 移动光标  ·  Space: 切换  ·  Tab: 切换作用域  ·  r: 恢复继承全局  ·  Enter: 保存生效  ·  Esc: 取消";
			} else if (currentScope === "project" && !projectCustomized) {
				footerHints = "  ↑/↓: 移动光标  ·  Space: 切换(派生项目配置)  ·  Tab: 切换作用域  ·  Enter: 保存生效  ·  Esc: 取消";
			} else {
				footerHints = "  ↑/↓: 移动光标  ·  Space: 切换  ·  Tab: 切换作用域  ·  Enter: 保存生效  ·  Esc: 取消";
			}

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

			if (action === "cancel") {
				done(undefined);
				return;
			}

			if (action === "save") {
				onSave({
					globalEnabled: globalDraft,
					projectEnabled: projectCustomized ? projectDraft : undefined,
				});
				done(undefined);
				return;
			}

			if (action === "toggleScope") {
				noticeNotice = undefined;
				if (!isEnvOverridden && canUseProjectScope) {
					currentScope = currentScope === "global" ? "project" : "global";
					tui.requestRender();
				}
				return;
			}

			if (action === "resetInherit") {
				if (currentScope === "project" && !isEnvOverridden && canUseProjectScope) {
					if (projectCustomized) {
						projectCustomized = false;
						projectDraft = new Set(globalDraft);
						noticeNotice = { text: "已重置项目配置，恢复继承全局", tone: "accent" };
						tui.requestRender();
						return;
					}
				}
			}

			if (total === 0) return;

			if (action === "up") {
				noticeNotice = undefined;
				selected = selected === 0 ? total - 1 : selected - 1;
			} else if (action === "down") {
				noticeNotice = undefined;
				selected = selected === total - 1 ? 0 : selected + 1;
			} else if (action === "pageUp") {
				noticeNotice = undefined;
				selected = Math.max(0, selected - PAGE_SIZE);
			} else if (action === "pageDown") {
				noticeNotice = undefined;
				selected = Math.min(total - 1, selected + PAGE_SIZE);
			} else if (action === "toggle") {
				const tool = tools[selected];
				if (tool) {
					if (outsideBaseline(tool, baselineNames)) {
						noticeNotice = { text: `${tool.name} 不在 Pi 的启动集合里，本面板不能拉回`, tone: "warning" };
					} else if (isLocked(tool)) {
						noticeNotice = isBuiltin(tool)
							? { text: `内置核心工具 ${tool.name} 由 defaultTools 托管，请在 settings.json 中调整`, tone: "warning" }
							: {
								text: exposureLabel(tool) === "hidden"
									? `${tool.name} 的 exposure=hidden，已注册但不可达，不进入待命池`
									: `${tool.name} 的 exposure=${exposureLabel(tool)}，由 tool_search / codemode 托管`,
								tone: "warning",
							};
					} else {
						noticeNotice = undefined;
						if (currentScope === "global") {
							if (globalDraft.has(tool.name)) {
								globalDraft.delete(tool.name);
							} else {
								globalDraft.add(tool.name);
							}
							// 若项目当前处于继承全局状态，项目的继承基准草稿同步联动
							if (!projectCustomized) {
								projectDraft = new Set(globalDraft);
							}
						} else {
							// 项目作用域
							if (!projectCustomized) {
								// 继承态首次触发修改 -> 自动派生 Fork！
								projectCustomized = true;
								projectDraft = new Set(globalDraft);
								if (projectDraft.has(tool.name)) {
									projectDraft.delete(tool.name);
								} else {
									projectDraft.add(tool.name);
								}
								noticeNotice = {
									text: "已基于全局配置派生项目独立配置草稿，按 r 可重置恢复继承",
									tone: "accent",
								};
							} else {
								// 已是项目独立配置
								if (projectDraft.has(tool.name)) {
									projectDraft.delete(tool.name);
								} else {
									projectDraft.add(tool.name);
								}
							}
						}
					}
				}
			}
			tui.requestRender();
		},
	};
}
