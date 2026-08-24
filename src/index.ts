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
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
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

/** 扩展工具：可挂起、进目录、可写成新会话默认。 */
function isOnDemand(tool: ToolInfo): boolean {
	return tool.name !== LOADER_TOOL_NAME && !isBuiltin(tool);
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

	function newSessionEnabled(): Set<string> {
		const names = new Set(allTools.map((t) => t.name));
		const next = new Set<string>();
		for (const tool of allTools) {
			if (isBuiltin(tool)) next.add(tool.name);
		}
		const saved = loadDefaultEnabled();
		if (saved) {
			for (const name of saved) {
				if (names.has(name)) next.add(name);
			}
		}
		next.add(LOADER_TOOL_NAME);
		return next;
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
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
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t) => allToolNames.includes(t)));
			enabledTools.add(LOADER_TOOL_NAME);
		} else {
			enabledTools = newSessionEnabled();
		}
		replaceActiveTools();
	}

	function getInactiveTools(): ToolInfo[] {
		allTools = pi.getAllTools();
		const activeNames = pi.getActiveTools();
		return allTools.filter(
			(t) => t.name !== LOADER_TOOL_NAME && !activeNames.includes(t.name),
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

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name === LOADER_TOOL_NAME ? `${tool.name} (auto-loader)` : tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Tool Configuration")),
								theme.fg("muted", "开关当前会话。非内置的选择记成以后新会话默认；内置只影响本场。enable_tool 不能关。"),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 3, 16),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === LOADER_TOOL_NAME) {
							enabledTools.add(LOADER_TOOL_NAME);
							replaceActiveTools();
							persistSession();
							return;
						}
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						replaceActiveTools();
						persistSession();
						persistExtensionDefault(id);
					},
					() => {
						done(undefined);
					},
				);

				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
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
