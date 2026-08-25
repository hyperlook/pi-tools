/**
 * 按需启用工具：
 * 1. 会话开始扫一遍已注册工具。目录是开场快照，不是当前失活名单。
 * 2. 人用 /tools：当前会话立刻生效；非内置的开集记成以后新会话的默认。
 * 3. 模型用 enable_tool：只改当前会话，不改默认。
 * 4. 按需目录写在 enable_tool 的 description / guidelines 里，会话内字节不变。
 * 5. 当前会话的选择跟分支走。
 *
 * 不要在 before_agent_start 里按「当前未激活集合」改 system prompt：
 * 激活工具后那段会变短，前缀缓存必 miss。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ToolsState {
	enabledTools: string[];
}

interface CatalogEntry {
	name: string;
	blurb: string;
}

const LOADER_TOOL_NAME = "enable_tool";
const QUERY_MIN_TOKEN = 3;
const QUERY_LIMIT = 5;
const PREFS_FILE = "pi-tools.json";

function firstSentence(text: string | undefined): string {
	if (!text) return "";
	const match = text.match(/^.+?(?:。|\.(?:\s|$)|$)/);
	return (match?.[0] ?? text).trim();
}

function isBuiltin(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin";
}

function isSupported(toolOrName: ToolInfo | string): boolean {
	const name = typeof toolOrName === "string" ? toolOrName : toolOrName.name;
	if (name === "powershell" && process.platform !== "win32") {
		return false;
	}
	return true;
}

/** 扩展工具：可挂起、进目录、可写成新会话默认。 */
function isOnDemand(tool: ToolInfo): boolean {
	return tool.name !== LOADER_TOOL_NAME && !isBuiltin(tool) && isSupported(tool);
}

function prefsPath(): string {
	return process.env.PI_TOOLS_CONFIG || join(getAgentDir(), PREFS_FILE);
}

/** 人用 /tools 留下的「默认要开的扩展工具」。没有文件 = 还没用过 /tools。 */
function loadDefaultEnabled(): string[] | undefined {
	const path = prefsPath();
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { defaultEnabled?: unknown };
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.defaultEnabled)) {
			return undefined;
		}
		return parsed.defaultEnabled.filter((name): name is string => typeof name === "string" && name.trim() !== "");
	} catch {
		return undefined;
	}
}

function saveDefaultEnabled(names: string[]) {
	writeFileSync(
		prefsPath(),
		`${JSON.stringify({ defaultEnabled: names }, null, 2)}\n`,
		"utf8",
	);
}

function catalogFrom(tools: ToolInfo[]): CatalogEntry[] {
	return tools.filter(isOnDemand).map((tool) => ({
		name: tool.name,
		blurb: firstSentence(tool.description).slice(0, 80) || tool.name,
	}));
}

function formatToolDescription(tool: ToolInfo): string {
	if (tool.name === LOADER_TOOL_NAME) {
		return "按需工具调度器：根据任务由模型在对话中自动唤醒未激活的扩展工具。";
	}
	const desc = tool.description ? firstSentence(tool.description) : "";
	return desc || "（该工具暂无详细描述）";
}

function formatToolSource(tool: ToolInfo): string {
	if (tool.name === LOADER_TOOL_NAME) {
		return "按需调度器 (核心常驻)";
	}
	if (isBuiltin(tool)) {
		return "内置核心工具";
	}
	const raw = tool.sourceInfo?.source || "";
	if (raw.startsWith("npm:")) {
		return raw.slice(4);
	}
	if (raw.includes("/")) {
		const parts = raw.split("/").filter(Boolean);
		return parts[parts.length - 1] || raw;
	}
	return raw || "扩展插件";
}

function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => {
		const orderA = isBuiltin(a) ? 0 : a.name === LOADER_TOOL_NAME ? 1 : 2;
		const orderB = isBuiltin(b) ? 0 : b.name === LOADER_TOOL_NAME ? 1 : 2;
		if (orderA !== orderB) return orderA - orderB;
		return a.name.localeCompare(b.name);
	});
}

export default function toolsExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	function persistSession() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	/** 只把人刚拨的那一个扩展工具写入默认，不把模型 enable_tool 的结果带进去。 */
	function persistExtensionDefault(id: string) {
		const known = new Set(allTools.filter(isOnDemand).map((tool) => tool.name));
		if (!known.has(id)) return;
		const current = new Set(loadDefaultEnabled() ?? []);
		if (enabledTools.has(id)) current.add(id);
		else current.delete(id);
		saveDefaultEnabled(Array.from(current).filter((name) => known.has(name)));
	}

	/** TUI / 会话恢复：整表替换。loader 执行期间不要走这条。 */
	function replaceActiveTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function newSessionEnabled(initialActiveTools: string[]): Set<string> {
		const toolMap = new Map(allTools.map((t) => [t.name, t]));
		const next = new Set<string>();

		// 1. 内置工具：只保留 Pi 启动时初始激活且当前平台支持的工具（如 read, bash, edit, write 或用户 settings.json defaultTools）
		for (const name of initialActiveTools) {
			const tool = toolMap.get(name);
			if (tool && isBuiltin(tool) && isSupported(tool)) {
				next.add(name);
			}
		}

		// 容错兜底：若初始状态没有任何内置工具，保证最基本的读写与终端工具
		if (next.size === 0) {
			const standardBuiltins = ["read", "bash", "edit", "write"];
			for (const name of standardBuiltins) {
				const tool = toolMap.get(name);
				if (tool && isSupported(tool)) next.add(name);
			}
		}

		// 2. 扩展工具：默认只加载 pi-tools.json 中保存的用户偏好
		const saved = loadDefaultEnabled();
		if (saved) {
			for (const name of saved) {
				const tool = toolMap.get(name);
				if (tool && isOnDemand(tool)) {
					next.add(name);
				}
			}
		}

		// 3. 调度器常驻
		next.add(LOADER_TOOL_NAME);
		return next;
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const currentActive = pi.getActiveTools();
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			const allToolNames = new Set(allTools.map((t) => t.name));
			enabledTools = new Set(
				savedTools.filter((t) => allToolNames.has(t) && isSupported(t)),
			);
			enabledTools.add(LOADER_TOOL_NAME);
		} else {
			enabledTools = newSessionEnabled(currentActive);
		}
		replaceActiveTools();
	}

	function getInactiveTools(): ToolInfo[] {
		allTools = pi.getAllTools();
		const activeNames = pi.getActiveTools();
		return allTools.filter(
			(t) => t.name !== LOADER_TOOL_NAME && !activeNames.includes(t.name) && isSupported(t),
		);
	}

	function matchByQuery(inactive: ToolInfo[], query: string): ToolInfo[] {
		const tokens = query
			.toLowerCase()
			.split(/[\s,._-]+/)
			.filter((tok) => tok.length >= QUERY_MIN_TOKEN);
		if (tokens.length === 0) return [];

		return inactive
			.map((tool) => {
				const searchable = `${tool.name} ${tool.description || ""}`.toLowerCase();
				const score = tokens.reduce(
					(sum, tok) => sum + (searchable.includes(tok) ? 1 : 0),
					0,
				);
				return { tool, score };
			})
			.filter((row) => row.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, QUERY_LIMIT)
			.map((row) => row.tool);
	}

	function registerLoader(catalog: CatalogEntry[]) {
		const names = catalog.map((t) => t.name).join("、");
		const blurbs = catalog.map((t) => `\`${t.name}\`（${t.blurb}）`).join("、");
		const hasCatalog = catalog.length > 0;
		pi.registerTool({
			name: LOADER_TOOL_NAME,
			label: "Enable Tool",
			description: hasCatalog
				? `按精确名或任务关键词激活未启用的工具。按需工具：${blurbs}。激活后完整参数 schema 只在下一轮模型请求可用，不要在同一条 assistant 消息里调用它们。`
				: "按精确名或任务关键词激活当前未启用的工具。激活后完整参数 schema 只在下一轮模型请求可用，不要在同一条 assistant 消息里调用它们。",
			promptSnippet: "按精确名激活未启用的工具",
			promptGuidelines: [
				hasCatalog
					? `需要的工具如果未激活，先调用 enable_tool，tool_names 传精确名（${names}）。新工具只在下一轮请求可用，禁止与 enable_tool 同轮并行调用。`
					: "需要的工具如果未激活，先调用 enable_tool（精确名或 query）。新工具只在下一轮请求可用，禁止与 enable_tool 同轮并行调用。",
			],
			parameters: Type.Object({
				tool_names: Type.Optional(Type.Array(Type.String(), {
					description: "Exact names of inactive tools to activate",
				})),
				query: Type.Optional(Type.String({
					description: "Task description/keyword if exact tool name is not known",
				})),
			}),
			async execute(_toolCallId, params) {
				const inactive = getInactiveTools();
				const toEnable: ToolInfo[] = [];

				if (params.tool_names && params.tool_names.length > 0) {
					for (const name of params.tool_names) {
						const found = inactive.find((t) => t.name.toLowerCase() === name.toLowerCase());
						if (found && !toEnable.includes(found)) {
							toEnable.push(found);
						}
					}
				}

				if (params.query) {
					for (const tool of matchByQuery(inactive, params.query)) {
						if (!toEnable.includes(tool)) toEnable.push(tool);
					}
				}

				if (toEnable.length === 0) {
					const available = inactive
						.map((t) => `${t.name}: ${firstSentence(t.description).slice(0, 60)}`)
						.join("; ") || "none";
					return {
						content: [{
							type: "text",
							text: `No matching inactive tools found. Inactive tools available: [${available}].`,
						}],
						details: { requested: params, enabled: [] },
					};
				}

				const active = pi.getActiveTools();
				const added = toEnable
					.map((t) => t.name)
					.filter((name) => !active.includes(name));
				for (const name of added) enabledTools.add(name);
				// 必须纯增量，Pi 才走 deferred loading / 前缀缓存。
				pi.setActiveTools([...new Set([...active, ...added])]);
				persistSession();

				const enabledList = added.join(", ");
				return {
					content: [{
						type: "text",
						text: `Successfully enabled tool(s): ${enabledList}. Their parameter schemas will be available on the next model request. Do not call them in this same assistant message.`,
					}],
					details: { requested: params, enabled: added },
				};
			},
		});
	}

	registerLoader([]);

	pi.registerCommand("tools", {
		description: "打开面板查看、启用或停用工具",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools 只能在 TUI 模式使用", "error");
				return;
			}

			allTools = pi.getAllTools();
			const availableTools = sortTools(allTools.filter(isSupported));
			const totalItems = availableTools.length;
			let selectedIndex = 0;
			const maxVisible = Math.max(10, Math.min(totalItems, 16));

			await ctx.ui.custom((tui, theme, _kb, done) => {
				return {
					render(width: number) {
						const lines: string[] = [];

						// 1. 标题与说明（固定 3 行）
						lines.push(theme.fg("accent", theme.bold("Tool Configuration")));
						lines.push(theme.fg("muted", "开关当前会话。非内置选择存为以后默认，内置只影响本场。"));
						lines.push("");

						// 2. 列表项滚动可视窗口（固定 maxVisible 行）
						const visibleCount = Math.min(totalItems, maxVisible);
						const startIndex = Math.max(
							0,
							Math.min(selectedIndex - Math.floor(visibleCount / 2), totalItems - visibleCount),
						);
						const endIndex = startIndex + visibleCount;

						const maxNameLen = Math.min(
							26,
							Math.max(16, ...availableTools.map((t) => visibleWidth(t.name))),
						);

						for (let i = startIndex; i < endIndex; i++) {
							const tool = availableTools[i];
							if (!tool) continue;

							const isSelected = i === selectedIndex;
							const isLoader = tool.name === LOADER_TOOL_NAME;
							const isAct = enabledTools.has(tool.name);

							const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
							const dot = isLoader
								? theme.fg("accent", "● ")
								: isAct
									? theme.fg("success", "● ")
									: theme.fg("dim", "○ ");

							const nameWidth = visibleWidth(tool.name);
							const pad = " ".repeat(Math.max(0, maxNameLen - nameWidth + 2));
							const nameText = isSelected
								? theme.bold(theme.fg("accent", tool.name))
								: tool.name;

							let badgeText: string;
							if (isLoader) {
								badgeText = theme.fg("accent", "[core]   ");
							} else if (isBuiltin(tool)) {
								badgeText = theme.fg("muted", "[builtin]");
							} else {
								badgeText = theme.fg("warning", "[user]   ");
							}

							let statusText: string;
							if (isLoader) {
								statusText = theme.fg("accent", "always on");
							} else if (isAct) {
								statusText = theme.fg("success", "enabled  ");
							} else {
								statusText = theme.fg("dim", "disabled ");
							}

							const row = `${cursor}${dot}${nameText}${pad} ${badgeText}  ${statusText}`;
							lines.push(truncateToWidth(row, width));
						}

						// 补齐空白行（保证列表区域行数固定）
						for (let k = visibleCount; k < maxVisible; k++) {
							lines.push("");
						}

						// 3. 滚动进度指示行（固定 1 行）
						if (totalItems > maxVisible) {
							lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${totalItems})`));
						} else {
							lines.push("");
						}

						// 4. 分割线（固定 1 行）
						lines.push(theme.fg("dim", "─".repeat(Math.min(width, 70))));

						// 5. 详情描述与来源卡片（固定 2 行）
						const currentTool = availableTools[selectedIndex];
						if (currentTool) {
							const desc = formatToolDescription(currentTool);
							const src = formatToolSource(currentTool);
							lines.push(truncateToWidth(`  说明: ${theme.fg("accent", desc)}`, width));
							lines.push(truncateToWidth(`  来源: ${theme.fg("muted", src)}`, width));
						} else {
							lines.push("");
							lines.push("");
						}

						// 6. 空行（固定 1 行）
						lines.push("");

						// 7. 底部操作提示（固定 1 行）
						lines.push(
							truncateToWidth(
								theme.fg("muted", "  ↑/↓: 移动光标  ·  Space/Enter: 切换状态  ·  Esc: 保存退出"),
								width,
							),
						);

						return lines;
					},
					invalidate() {},
					handleInput(data: string) {
						const kb = getKeybindings();
						if (kb.matches(data, "tui.select.up") || data === "k" || data === "\u001b[A") {
							if (totalItems === 0) return;
							selectedIndex = selectedIndex === 0 ? totalItems - 1 : selectedIndex - 1;
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.down") || data === "j" || data === "\u001b[B") {
							if (totalItems === 0) return;
							selectedIndex = selectedIndex === totalItems - 1 ? 0 : selectedIndex + 1;
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.pageUp")) {
							selectedIndex = Math.max(0, selectedIndex - 8);
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.pageDown")) {
							selectedIndex = Math.min(totalItems - 1, selectedIndex + 8);
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
							const tool = availableTools[selectedIndex];
							if (tool && tool.name !== LOADER_TOOL_NAME) {
								const id = tool.name;
								if (enabledTools.has(id)) {
									enabledTools.delete(id);
								} else {
									enabledTools.add(id);
								}
								replaceActiveTools();
								persistSession();
								persistExtensionDefault(id);
							}
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "\u001b") {
							done(undefined);
						}
					},
				};
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		allTools = pi.getAllTools();
		registerLoader(catalogFrom(allTools));
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
