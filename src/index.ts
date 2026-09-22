/**
 * pi-tools: 按需启用扩展工具（终极纯白名单方案）
 * 1. 系统内置工具归官方（Zero Blast Radius）：彻底不碰、不持久化，面板变灰只读。
 * 2. 扩展工具与调度器收敛为纯白名单：唯一字段 defaultEnabled，无配置则全关，按需在面板配置点亮。
 * 3. 安全沙箱无越权风险：调度池仅包含扩展工具，模型绝无法越权自激活内置核心工具。
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatDisplayPath,
	getGlobalConfigPath,
	persistToolPreference,
	readScopeConfig,
	resolveEffectiveConfig,
	type ConfigScope,
} from "./config.ts";
import {
	firstSentence,
	isBuiltin,
	isOnDemand,
	isSupported,
	LOADER_TOOL_NAME,
} from "./shared.ts";
import { createToolsPanel, sortTools } from "./tools-panel.ts";

export interface ToolsState {
	enabledTools: string[];
}

export interface CatalogEntry {
	name: string;
	blurb: string;
}

const QUERY_MIN_TOKEN = 3;
const QUERY_LIMIT = 5;

export function catalogFrom(tools: ToolInfo[]): CatalogEntry[] {
	return tools.filter(isOnDemand).map((tool) => ({
		name: tool.name,
		blurb: firstSentence(tool.description).slice(0, 60).replace(/[。.]\s*$/, "").trim() || tool.name,
	}));
}

/**
 * 确定新会话中应该激活的工具集合：
 * 1. 内置核心工具：严格保留 Pi 启动时原生传入且受支持的内置工具，不多加、不少减。
 * 2. 扩展工具 & 调度器：纯白名单！若配置文件存在，仅激活列在 defaultEnabled 中的工具；
 *    若无任何配置文件（被删除或未配置），白名单为空，所有扩展工具与调度器均不激活。
 */
export function newSessionEnabled(
	initialActiveTools: string[],
	allTools: ToolInfo[],
	cwd: string,
	trusted: boolean,
): Set<string> {
	const toolMap = new Map(allTools.map((t) => [t.name, t]));
	const next = new Set<string>();

	// 1. 内置工具：保留 Pi 初始激活且受支持的内置核心工具
	for (const name of initialActiveTools) {
		const tool = toolMap.get(name);
		if (tool && isBuiltin(tool) && isSupported(tool)) {
			next.add(name);
		}
	}

	// 2. 扩展工具 & 调度器：读取有效配置（纯白名单）
	const config = resolveEffectiveConfig(cwd, trusted);
	if (config.tools) {
		for (const name of config.tools) {
			const tool = toolMap.get(name);
			if (name === LOADER_TOOL_NAME) {
				next.add(LOADER_TOOL_NAME);
			} else if (tool && isOnDemand(tool)) {
				next.add(name);
			}
		}
	}

	return next;
}

/**
 * 获取可被模型动态激活的未启用工具列表。
 * 安全保障：调度池仅包含扩展工具，绝对排除内置核心工具及调度器自身。
 */
export function getInactiveTools(allTools: ToolInfo[], activeNames: string[]): ToolInfo[] {
	return allTools.filter(
		(t) => isOnDemand(t) && !activeNames.includes(t.name),
	);
}

export function matchByQuery(inactive: ToolInfo[], query: string): ToolInfo[] {
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

export default function toolsExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];
	let currentCwd: string = process.cwd();
	let isProjectTrusted: boolean = true;

	function persistSession() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	/** TUI / 会话恢复：整表替换。loader 执行期间不要走这条。 */
	function replaceActiveTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
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
		} else {
			enabledTools = newSessionEnabled(currentActive, allTools, currentCwd, isProjectTrusted);
		}
		replaceActiveTools();
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
				allTools = pi.getAllTools();
				const inactive = getInactiveTools(allTools, pi.getActiveTools());
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
				// 增量激活，保持 Pi 的 transcript-aware 缓存优化
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

			currentCwd = ctx.cwd;
			isProjectTrusted = ctx.isProjectTrusted();
			allTools = pi.getAllTools();
			const tools = sortTools(allTools.filter(isSupported));

			const effective = resolveEffectiveConfig(currentCwd, isProjectTrusted);
			const initialScope: ConfigScope = effective.scope;
			const projectDisplay = ".pi/pi-tools.json";
			const globalDisplay = formatDisplayPath(getGlobalConfigPath());

			// 当前在 Pi 中活跃的系统内置核心工具
			const activeNames = new Set(pi.getActiveTools());
			const activeBuiltinTools = new Set(
				allTools
					.filter((t) => isBuiltin(t) && activeNames.has(t.name))
					.map((t) => t.name),
			);

			const getScopeEnabled = (scope: ConfigScope): Set<string> => {
				const scopeConfig = readScopeConfig(scope, currentCwd);
				return new Set(scopeConfig ?? []);
			};

			await ctx.ui.custom((tui, theme, kb, done) =>
				createToolsPanel({
					tui,
					theme,
					kb,
					done,
					tools,
					activeBuiltinTools,
					initialScope,
					canUseProjectScope: isProjectTrusted,
					projectDisplayPath: projectDisplay,
					globalDisplayPath: globalDisplay,
					isEnvOverridden: effective.isEnvOverridden,
					getScopeEnabled,
					onToggle(id, scope) {
						const currentScopeSet = getScopeEnabled(scope);
						const nextEnabled = !currentScopeSet.has(id);
						const known = new Set(
							allTools
								.filter((tool) => isOnDemand(tool) || tool.name === LOADER_TOOL_NAME)
								.map((tool) => tool.name),
						);

						persistToolPreference({
							toolName: id,
							enabled: nextEnabled,
							targetScope: scope,
							cwd: currentCwd,
							knownTools: known,
						});

						// 若修改的正好是当前生效的作用域，同步更新会话
						const currentEffective = resolveEffectiveConfig(currentCwd, isProjectTrusted);
						if (currentEffective.scope === scope) {
							if (nextEnabled) {
								enabledTools.add(id);
							} else {
								enabledTools.delete(id);
							}
							replaceActiveTools();
							persistSession();
						}
					},
				}),
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
		allTools = pi.getAllTools();
		registerLoader(catalogFrom(allTools));
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
		restoreFromBranch(ctx);
	});
}
