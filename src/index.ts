/**
 * pi-tools: 按需启用扩展工具
 * 1. 内置工具归 Pi，本扩展不改、不持久化。
 * 2. 扩展工具默认全开，disabledTools 是磁盘失活策略。
 * 3. enable_tool 只追加本分支的会话增量，不写回配置文件。
 * 4. 恢复会话时磁盘策略优先；旧的 enabledTools 绝对快照不能盖住外部修改。
 * 5. 工具在同一用户请求的下一助手回合生效（Pi prepareNextTurn 会刷新快照）。
 *    同一条助手消息里的并行调用物理上拿不到新 schema，所以禁止同条连调，而不是让用户再发一条。
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ACTIVATION_CONTRACT,
	activationResultText,
	activationsFromSaved,
	applySessionActivations,
	injectToolsNotice,
	lastToolsState,
	managedToolDelta,
	pruneSessionActivated,
	sameStringSet,
	toolsStateChanged,
	toolsUpdateNotice,
	type StoredToolsState,
} from "./activation.ts";
import {
	configFingerprint,
	deleteProjectConfigFile,
	formatDisplayPath,
	getGlobalConfigPath,
	hasProjectConfig,
	readScopeConfig,
	resolveEffectiveConfig,
	saveScopeConfig,
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

export type { StoredToolsState as ToolsState } from "./activation.ts";

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
 * 2. 扩展工具：主动差量失活机制（Opt-out）。无配置时全部扩展工具默认激活；
 *    仅排除列在 disabledTools 中的工具。
 * 3. 调度器 enable_tool：
 *    当且仅当 enable_tool 自身未被失活，且当前存在被失活的扩展工具时激活（0 token 冗余）；
 *    若所有扩展工具都已处于激活状态，无需激活调度器。
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

	// 2. 扩展工具：读取当前生效的 disabledTools 配置（失活名单）
	const config = resolveEffectiveConfig(cwd, trusted);
	const disabledSet = new Set(config.disabledTools ?? []);

	for (const tool of allTools) {
		if (isOnDemand(tool) && !disabledSet.has(tool.name)) {
			next.add(tool.name);
		}
	}

	// 3. 调度器：若未被失活，且存在未激活的扩展工具时启用
	if (!disabledSet.has(LOADER_TOOL_NAME)) {
		const hasInactiveExtensions = allTools.some(
			(tool) => isOnDemand(tool) && !next.has(tool.name),
		);
		if (hasInactiveExtensions) {
			next.add(LOADER_TOOL_NAME);
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
	let sessionActivated = new Set<string>();
	let allTools: ToolInfo[] = [];
	let currentCwd: string = process.cwd();
	let isProjectTrusted: boolean = true;
	let configStamp = "";
	let pendingContextNotice = "";

	function disabledNames(): Set<string> {
		return new Set(resolveEffectiveConfig(currentCwd, isProjectTrusted).disabledTools ?? []);
	}

	function computeEnabled(initialActive: string[]): Set<string> {
		allTools = pi.getAllTools();
		return applySessionActivations(
			newSessionEnabled(initialActive, allTools, currentCwd, isProjectTrusted),
			sessionActivated,
			allTools,
			disabledNames(),
		);
	}

	function persistSession() {
		const state: StoredToolsState = {
			enabledTools: Array.from(enabledTools),
			sessionActivated: Array.from(sessionActivated),
		};
		pi.appendEntry<StoredToolsState>("tools-config", state);
	}

	/** TUI / 会话恢复：整表替换。loader 执行期间也可以走这条，Pi 会在下一助手回合装载。 */
	function replaceActiveTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function syncLoader() {
		const inactive = getInactiveTools(allTools, Array.from(enabledTools));
		registerLoader(catalogFrom(inactive));
	}

	function queueToolsNotice(before: Iterable<string>, after: Iterable<string>) {
		const { enabled, disabled } = managedToolDelta(before, after, allTools);
		const notice = toolsUpdateNotice(enabled, disabled);
		if (notice) pendingContextNotice = notice;
	}

	function installEnabled(next: Set<string>, options: { persist: boolean; noticeFrom?: Iterable<string> }) {
		const previous = options.noticeFrom ?? enabledTools;
		enabledTools = next;
		sessionActivated = new Set(pruneSessionActivated(sessionActivated, enabledTools, allTools, disabledNames()));
		syncLoader();
		replaceActiveTools();
		if (options.noticeFrom) queueToolsNotice(previous, enabledTools);
		if (options.persist) persistSession();
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
		allTools = pi.getAllTools();

		const saved = lastToolsState(ctx.sessionManager.getBranch().map((entry) => ({
			type: entry.type,
			customType: "customType" in entry ? entry.customType : undefined,
			data: "data" in entry ? entry.data : undefined,
		})));
		sessionActivated = new Set(activationsFromSaved(saved));
		const next = computeEnabled(pi.getActiveTools());
		const persist = toolsStateChanged(saved, next, pruneSessionActivated(sessionActivated, next, allTools, disabledNames()));
		installEnabled(next, { persist });
		configStamp = configFingerprint(currentCwd, isProjectTrusted);
	}

	/** 外部改了 pi-tools.json：下一条消息前按磁盘重算，保留尚未被磁盘覆盖的 enable_tool 增量。 */
	function reloadConfigIfChanged() {
		const stamp = configFingerprint(currentCwd, isProjectTrusted);
		if (stamp === configStamp) return;
		configStamp = stamp;
		allTools = pi.getAllTools();
		const previous = new Set(enabledTools);
		const previousActivated = new Set(sessionActivated);
		const next = computeEnabled(pi.getActiveTools());
		const nextActivated = new Set(pruneSessionActivated(sessionActivated, next, allTools, disabledNames()));
		if (sameStringSet(previous, next) && sameStringSet(previousActivated, nextActivated)) return;
		sessionActivated = nextActivated;
		installEnabled(next, { persist: true, noticeFrom: previous });
	}

	function registerLoader(catalog: CatalogEntry[]) {
		const blurbs = catalog.map((t) => `\`${t.name}\`（${t.blurb}）`).join("、");
		const hasCatalog = catalog.length > 0;
		pi.registerTool({
			name: LOADER_TOOL_NAME,
			label: "Enable Tool",
			description: hasCatalog
				? `按精确名激活未启用的扩展工具。未激活：${blurbs}。${ACTIVATION_CONTRACT}`
				: `按精确名或任务关键词激活未启用的扩展工具。${ACTIVATION_CONTRACT}`,
			promptSnippet: "按精确名激活未启用的扩展工具",
			promptGuidelines: [ACTIVATION_CONTRACT],
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

				const added = toEnable.map((tool) => tool.name);
				for (const name of added) sessionActivated.add(name);
				// 不在这里 sendMessage(nextTurn)：那只是排到用户的下一条消息，不会开新回合。
				// Pi 会在本请求的下一助手回合用 agent.state.tools 刷新快照。
				const next = computeEnabled(pi.getActiveTools());
				installEnabled(next, { persist: true });
				const enabledNow = added.filter((name) => next.has(name));

				return {
					content: [{ type: "text", text: activationResultText(enabledNow) }],
					details: { requested: params, enabled: enabledNow },
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

			// 可被本面板管理的全部工具（非内置工具 + loader）
			const manageableTools = tools.filter((t) => isOnDemand(t) || t.name === LOADER_TOOL_NAME);

			const globalDisabledList = readScopeConfig("global", currentCwd) ?? [];
			const globalDisabledSet = new Set(globalDisabledList);
			const initialGlobalEnabled = new Set(
				manageableTools
					.filter((t) => !globalDisabledSet.has(t.name))
					.map((t) => t.name),
			);

			const projectExists = hasProjectConfig(currentCwd);
			let initialProjectEnabled: Set<string> | undefined;
			if (projectExists) {
				const projectDisabledList = readScopeConfig("project", currentCwd);
				if (projectDisabledList !== undefined) {
					const projectDisabledSet = new Set(projectDisabledList);
					initialProjectEnabled = new Set(
						manageableTools
							.filter((t) => !projectDisabledSet.has(t.name))
							.map((t) => t.name),
					);
				}
			}

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
					initialGlobalEnabled,
					initialProjectEnabled,
					onSave(result) {
						const known = new Set(manageableTools.map((tool) => tool.name));

						// 1. 将全局中未勾选（disabled）的工具收集起来作为 disabledTools 保存
						const globalDisabled = manageableTools
							.filter((tool) => !result.globalEnabled.has(tool.name))
							.map((tool) => tool.name);

						saveScopeConfig({
							scope: "global",
							cwd: currentCwd,
							disabledNames: globalDisabled,
							knownTools: known,
						});

						// 2. 保存项目配置（若未被环境变量锁定且受信任）
						if (!effective.isEnvOverridden && isProjectTrusted) {
							if (result.projectEnabled === undefined) {
								// 项目选择恢复继承全局 -> 删除项目独立配置文件
								deleteProjectConfigFile(currentCwd);
							} else {
								// 项目独立定制 -> 收集未勾选的工具作为 disabledTools
								const projectDisabled = manageableTools
									.filter((tool) => !result.projectEnabled!.has(tool.name))
									.map((tool) => tool.name);

								saveScopeConfig({
									scope: "project",
									cwd: currentCwd,
									disabledNames: projectDisabled,
									knownTools: known,
								});
							}
						}

						// 面板提交的是磁盘策略，清掉本分支增量，避免刚禁用的工具被 enable_tool 记录加回来。
						const previous = new Set(enabledTools);
						sessionActivated.clear();
						configStamp = configFingerprint(currentCwd, isProjectTrusted);
						installEnabled(computeEnabled(pi.getActiveTools()), { persist: true, noticeFrom: previous });
						ctx.ui.notify("工具配置已保存并生效", "info");
					},
				}),
			);
		},
	});

	// 面板或外部配置改动后，下一次请求塞一条一次性通知：不写 session、不改 system prompt。
	pi.on("context", (event) => {
		if (!pendingContextNotice) return;
		const notice = pendingContextNotice;
		pendingContextNotice = "";
		try {
			return { messages: injectToolsNotice(event.messages, notice) };
		} catch {
			pendingContextNotice = notice;
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
		reloadConfigIfChanged();
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
