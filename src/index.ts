/**
 * pi-tools: 按需启用扩展工具
 * 1. 内置工具归 Pi（defaultTools / --tools），本扩展不改、不持久化。
 * 2. exposure 为 deferred / codemode / hidden 的工具归上游（tool_search / codemode 脚本），本扩展一律不碰。
 * 3. 本扩展只做减法：冻结 Pi 的启动集合，再从里面收编 direct 扩展工具。disabledTools 是磁盘失活策略。
 *    重新启用必须相对这份冻结集合，不能相对已经减过的 active。
 * 4. enable_tool 只追加本分支的会话增量，不写回配置文件。
 * 5. 恢复会话时磁盘策略优先；旧的 enabledTools 绝对快照不能盖住外部修改。
 * 6. 工具在同一用户请求的下一助手回合生效（Pi prepareNextTurn 会刷新快照）。
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
 * 在 Pi 自己的启动集合上做减法，得到本会话应激活的工具集合。
 *
 * baseline 必须是 Pi 愿意激活的集合（defaultTools / --tools / --exclude-tools / 注册即激活），
 * 不能是本扩展 setActiveTools 之后的 active：那份已经减过，重新启用会加不回来。
 * 本扩展只把「基线里的可声明扩展工具 ∩ disabledTools」拿掉，再补回仍在基线内的会话增量。
 * 因此 Pi 或用户显式关掉、从未进过基线的工具不会被拉回来。
 */
export function applyPolicy(
	baseline: Iterable<string>,
	allTools: readonly ToolInfo[],
	disabled: ReadonlySet<string>,
	sessionActivated: Iterable<string>,
): Set<string> {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const willing = new Set(baseline);
	const next = new Set(willing);
	for (const name of disabled) {
		const tool = byName.get(name);
		if (tool && isOnDemand(tool)) next.delete(name);
	}
	const delta = [...sessionActivated].filter((name) => willing.has(name));
	return applySessionActivations(next, delta, allTools, disabled, willing);
}

/**
 * 维护 Pi 的愿意集合。
 * 第一次观察且我们还没写过 active：当前 active 就是 Pi 的启动集合。
 * 之后只并入「不是我们写进去」的名字（迟到注册、tool_search 加载）。
 * 我们减掉的名字留在已冻结的集合里，这样磁盘重新启用还能加回来。
 */
export function absorbBaseline(
	baseline: Iterable<string> | undefined,
	active: Iterable<string>,
	writtenByUs: Iterable<string> | undefined,
): Set<string> {
	const next = new Set(baseline ?? []);
	const written = writtenByUs ? new Set(writtenByUs) : undefined;
	if (baseline === undefined && !written) {
		for (const name of active) next.add(name);
		return next;
	}
	for (const name of active) {
		if (!written || !written.has(name)) next.add(name);
	}
	return next;
}

/**
 * 获取可被模型动态激活的未启用工具列表。
 * 安全保障：调度池仅包含扩展工具，绝对排除内置核心工具及调度器自身。
 */
export function getInactiveTools(
	allTools: readonly ToolInfo[],
	activeNames: readonly string[],
	baseline?: Iterable<string>,
): ToolInfo[] {
	const willing = baseline ? new Set(baseline) : undefined;
	const active = new Set(activeNames);
	return allTools.filter(
		(tool) => isOnDemand(tool) && !active.has(tool.name) && (!willing || willing.has(tool.name)),
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
	let loaderDescription = "";
	/** Pi 愿意激活的名字。第一次 setActiveTools 之前冻结，之后只并入 Pi 后来自己激活的工具。 */
	let piBaseline: Set<string> | undefined;
	/** 我们上一次写进 setActiveTools 的名字。用来区分「Pi 后来激活的」和「我们减掉的」。 */
	let writtenActive: Set<string> | undefined;

	function disabledNames(): Set<string> {
		return new Set(resolveEffectiveConfig(currentCwd, isProjectTrusted).disabledTools ?? []);
	}

	function ensureBaseline(): Set<string> {
		piBaseline = absorbBaseline(piBaseline, pi.getActiveTools(), writtenActive);
		return piBaseline;
	}

	function seedBaseline(saved: StoredToolsState | undefined, reload: boolean) {
		const active = pi.getActiveTools();
		if (piBaseline) {
			piBaseline = absorbBaseline(piBaseline, active, writtenActive);
			return;
		}
		// /reload 会新建扩展实例，此时 active 已是我们减过的集合。用上次持久化的基线找回来。
		if (reload && saved?.piBaseline && saved.piBaseline.length > 0) {
			piBaseline = absorbBaseline(saved.piBaseline, active, undefined);
			return;
		}
		piBaseline = absorbBaseline(undefined, active, writtenActive);
	}

	function computeEnabled(baseline: Iterable<string>): Set<string> {
		allTools = pi.getAllTools();
		return applyPolicy(baseline, allTools, disabledNames(), sessionActivated);
	}

	function persistSession() {
		const state: StoredToolsState = {
			enabledTools: Array.from(enabledTools),
			sessionActivated: Array.from(sessionActivated),
			piBaseline: piBaseline ? Array.from(piBaseline) : undefined,
		};
		pi.appendEntry<StoredToolsState>("tools-config", state);
	}

	/** TUI / 会话恢复：整表替换。loader 执行期间也可以走这条，Pi 会在下一助手回合装载。 */
	function replaceActiveTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function syncLoader() {
		const inactive = getInactiveTools(allTools, Array.from(enabledTools), piBaseline);
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
		// 先记下我们要写的集合，避免 setActiveTools 触发的后续观察把这次写入当成 Pi 的新决定。
		writtenActive = new Set(enabledTools);
		replaceActiveTools();
		if (options.noticeFrom) queueToolsNotice(previous, enabledTools);
		if (options.persist) persistSession();
	}

	function restoreFromBranch(ctx: ExtensionContext, reload = false) {
		currentCwd = ctx.cwd;
		isProjectTrusted = ctx.isProjectTrusted();
		allTools = pi.getAllTools();

		const saved = lastToolsState(ctx.sessionManager.getBranch().map((entry) => ({
			type: entry.type,
			customType: "customType" in entry ? entry.customType : undefined,
			data: "data" in entry ? entry.data : undefined,
		})));
		sessionActivated = new Set(activationsFromSaved(saved));
		seedBaseline(saved, reload);
		const next = computeEnabled(piBaseline!);
		const activated = pruneSessionActivated(sessionActivated, next, allTools, disabledNames());
		// 没有持久化过基线时写一条，否则 /reload 只能看到已经减过的 active。
		const persist = toolsStateChanged(saved, next, activated, piBaseline) || !saved?.piBaseline;
		installEnabled(next, { persist });
		configStamp = configFingerprint(currentCwd, isProjectTrusted);
	}

	/** 外部改了 pi-tools.json，或 Pi 迟到激活了工具：下一条消息前按冻结基线重算。 */
	function reloadConfigIfChanged() {
		const stamp = configFingerprint(currentCwd, isProjectTrusted);
		const before = piBaseline ? new Set(piBaseline) : undefined;
		const baseline = ensureBaseline();
		const baselineChanged = !before || !sameStringSet(before, baseline);
		if (stamp === configStamp && !baselineChanged) return;
		configStamp = stamp;
		allTools = pi.getAllTools();
		const previous = new Set(enabledTools);
		const previousActivated = new Set(sessionActivated);
		const next = computeEnabled(baseline);
		const nextActivated = new Set(pruneSessionActivated(sessionActivated, next, allTools, disabledNames()));
		const live = new Set(pi.getActiveTools());
		// live 比 enabledTools 多出来的名字，是 Pi 在我们上次写入之后激活的（例如迟到的 direct MCP）。
		if (
			sameStringSet(previous, next) &&
			sameStringSet(previousActivated, nextActivated) &&
			sameStringSet(live, next)
		) return;
		sessionActivated = nextActivated;
		installEnabled(next, { persist: true, noticeFrom: previous });
	}

	function registerLoader(catalog: CatalogEntry[]) {
		const blurbs = catalog.map((t) => `\`${t.name}\`（${t.blurb}）`).join("、");
		const hasCatalog = catalog.length > 0;
		const description = hasCatalog
			? `按精确名激活未启用的扩展工具。未激活：${blurbs}。${ACTIVATION_CONTRACT}`
			: `按精确名或任务关键词激活未启用的扩展工具。${ACTIVATION_CONTRACT}`;
		// 重注册会触发 Pi 重建整个工具注册表与 system prompt，目录没变就不动。
		if (description === loaderDescription) return;
		loaderDescription = description;
		pi.registerTool({
			name: LOADER_TOOL_NAME,
			label: "Enable Tool",
			description,
			// 纯调度器：模型直接调用，不需要被 codemode 脚本嵌套调用。
			exposure: "model-only",
			// 是否常驻完全由 applySessionActivations 决定，不靠注册即激活。
			defaultActive: false,
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
				const baseline = ensureBaseline();
				const inactive = getInactiveTools(allTools, pi.getActiveTools(), baseline);
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
				const next = computeEnabled(baseline);
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
			const baseline = ensureBaseline();
			const tools = sortTools(allTools.filter(isSupported));

			const effective = resolveEffectiveConfig(currentCwd, isProjectTrusted);
			const initialScope: ConfigScope = effective.scope;
			const projectDisplay = ".pi/pi-tools.json";
			const globalDisplay = formatDisplayPath(getGlobalConfigPath());

			// 当前在 Pi 中活跃的工具（锁定行用它显示真实状态）
			const activeNames = new Set(pi.getActiveTools());

			// 只管理基线里的 direct 扩展工具和调度器。Pi 没放进来的不进草稿，避免显示成已启用。
			const manageableTools = tools.filter(
				(tool) => tool.name === LOADER_TOOL_NAME || (isOnDemand(tool) && baseline.has(tool.name)),
			);

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
					activeNames,
					baselineNames: baseline,
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
						installEnabled(computeEnabled(ensureBaseline()), { persist: true, noticeFrom: previous });
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

	pi.on("session_start", async (event, ctx) => {
		restoreFromBranch(ctx, event.reason === "reload");
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
