/**
 * Native loading-preference UI. No tool registration, search implementation or legacy adapter.
 * Pi owns execution, exposure, and the branch's search-loaded tools.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deleteProjectConfigFile, formatDisplayPath, getGlobalConfigPath, readScopeConfig, resolveEffectiveConfig, saveScopeConfig } from "./config.ts";
import { lastPolicyState, planPolicy, sameNames, STATE_ENTRY, stateEqual, type PolicyState } from "./policy.ts";
import { isSupported } from "./shared.ts";
import { createToolsPanel, sortTools } from "./tools-panel.ts";

export default function toolsExtension(pi: ExtensionAPI) {
	let state: PolicyState | undefined;
	let warnedMissingSearch = false;
	function sync(ctx: ExtensionContext) {
		const config = resolveEffectiveConfig(ctx.cwd, ctx.isProjectTrusted());
		const active = pi.getActiveTools();
		const plan = planPolicy(active, pi.getAllTools(), config.toolModes, state);
		if (!sameNames(active, plan.active)) pi.setActiveTools([...plan.active]);
		if (!stateEqual(state, plan.state)) pi.appendEntry<PolicyState>(STATE_ENTRY, plan.state);
		state = plan.state;
		if (plan.missingSearch && !warnedMissingSearch) {
			ctx.ui.notify("按需偏好已应用，但原生 tool_search 未注册。请加载 builtin:tool-search，并确保 CLI 工具筛选允许 tool_search。", "warning");
		}
		warnedMissingSearch = plan.missingSearch;
	}
	function restore(ctx: ExtensionContext) {
		state = lastPolicyState(ctx.sessionManager.getBranch().map((entry) => ({
			type: entry.type,
			customType: "customType" in entry ? entry.customType : undefined,
			data: "data" in entry ? entry.data : undefined,
		})));
		sync(ctx);
	}
	pi.registerCommand("tools", {
		description: "配置工具加载偏好：跟随扩展、常驻或原生按需加载",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/tools 只能在 TUI 模式使用", "error"); return; }
			sync(ctx);
			const trusted = ctx.isProjectTrusted();
			const effective = resolveEffectiveConfig(ctx.cwd, trusted);
			await ctx.ui.custom((tui, theme, kb, done) => createToolsPanel({
				tui, theme, kb, done,
				tools: sortTools(pi.getAllTools().filter(isSupported)),
				activeNames: new Set(pi.getActiveTools()),
				initialScope: effective.scope,
				canUseProjectScope: trusted,
				projectDisplayPath: ".pi/pi-tools.json",
				globalDisplayPath: formatDisplayPath(getGlobalConfigPath()),
				isEnvOverridden: effective.isEnvOverridden,
				initialGlobalModes: readScopeConfig("global", ctx.cwd) ?? {},
				initialProjectModes: !effective.isEnvOverridden && trusted ? readScopeConfig("project", ctx.cwd) : undefined,
				onSave(result) {
					saveScopeConfig({ scope: "global", cwd: ctx.cwd, modes: result.globalModes });
					if (!effective.isEnvOverridden && trusted) {
						if (result.projectModes === undefined) deleteProjectConfigFile(ctx.cwd);
						else saveScopeConfig({ scope: "project", cwd: ctx.cwd, modes: result.projectModes });
					}
					sync(ctx);
					ctx.ui.notify("工具加载偏好已保存并生效", "info");
				},
			}));
		},
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (_event, ctx) => sync(ctx));
}
