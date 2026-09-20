/**
 * 按需启用工具：
 * 1. 会话开始扫描本机已注册工具，生成按需工具目录并注册 enable_tool 调度器。
 * 2. 人用 /tools：即时切换工具。非内置工具写入用户偏好；当前会话调用 pi.setActiveTools()。
 * 3. 模型用 enable_tool：当前会话增量激活工具，同样通过 pi.setActiveTools() 生效。
 * 4. Pi 0.86+ 原生支持 Transcript-aware mid-conversation updates：
 *    工具发生变动时，Pi 自动对 system prompt sections (tools/rules) 做增量 diff 并注入
 *    轻量级系统补丁消息（patch），不再全量重写 System Prompt，原生保住前缀缓存（Prompt Cache）。
 * 5. 当前会话的选择与分支严格绑定，切换分支或恢复会话自动同步。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstSentence, isBuiltin, LOADER_TOOL_NAME } from "./shared.ts";
import { createToolsPanel, sortTools } from "./tools-panel.ts";

interface ToolsState {
	enabledTools: string[];
}

interface CatalogEntry {
	name: string;
	blurb: string;
}

const QUERY_MIN_TOKEN = 3;
const QUERY_LIMIT = 5;
const PREFS_FILE = "pi-tools.json";

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
		blurb: firstSentence(tool.description).slice(0, 60).replace(/[。.]\s*$/, "").trim() || tool.name,
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
				? `按精确名激活未启用的扩展工具。按需工具列表：${blurbs}。激活后参数在下一轮生效，禁止同轮连调。`
				: "按精确名或任务关键词激活未启用的扩展工具。激活后参数在下一轮生效，禁止同轮连调。",
			promptSnippet: "按精确名激活未启用的扩展工具",
			promptGuidelines: [
				hasCatalog
					? `需要的扩展工具未激活时，先调用 enable_tool，tool_names 传精确名（${names}）。新工具下一轮生效，禁止同轮连调。`
					: "需要的扩展工具未激活时，先调用 enable_tool（精确名或 query）。新工具下一轮生效，禁止同轮连调。",
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
			const tools = sortTools(allTools.filter(isSupported));
			await ctx.ui.custom((tui, theme, kb, done) =>
				createToolsPanel({
					tui,
					theme,
					kb,
					done,
					tools,
					enabled: enabledTools,
					onToggle(id) {
						if (enabledTools.has(id)) {
							enabledTools.delete(id);
						} else {
							enabledTools.add(id);
						}
						replaceActiveTools();
						persistSession();
						persistExtensionDefault(id);
					},
				}),
			);
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
