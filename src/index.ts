/** Exposure configuration UI. Pi continues to own discovery, execution and loaded branch state. */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deleteProjectConfigFile, formatDisplayPath, getGlobalConfigPath, readScopeConfig, resolveEffectiveConfig, saveScopeConfig } from "./config.ts";
import { ExposureAdapter } from "./exposure-adapter.ts";
import { exposuresEqual, lastPolicyState, planPolicy, sameNames, STATE_ENTRY, type PolicyState } from "./policy.ts";
import { isSupported } from "./shared.ts";
import { createToolsPanel, sortTools, type ToolsPanelSaveResult } from "./tools-panel.ts";

export default function toolsExtension(pi: ExtensionAPI) {
	const adapter = new ExposureAdapter();
	let state: PolicyState = { applied: {}, services: [] };
	let lastWarning = "";
	function sync(ctx: ExtensionContext) {
		const view = adapter.view(ctx);
		const active = pi.getActiveTools();
		const plan = planPolicy(active, pi.getAllTools(), view.overrides, state.applied, state.services);
		if (!sameNames(active, plan.active)) pi.setActiveTools([...plan.active]);
		const next = { applied: plan.applied, services: plan.services };
		if (!exposuresEqual(state.applied, next.applied) || !sameNames(state.services, next.services)) pi.appendEntry(STATE_ENTRY, next);
		state = next;
		const warning = [plan.missingSearch ? "tool_search 未注册：请加载 builtin:tool-search，并允许 CLI 工具筛选中的 tool_search" : "",
			plan.missingCodemode ? "codemode 未注册：脚本目录需要 builtin:codemode" : ""].filter(Boolean).join("；");
		if (warning && warning !== lastWarning) ctx.ui.notify(warning, "warning");
		lastWarning = warning;
	}
	function restore(ctx: ExtensionContext) {
		state = lastPolicyState(ctx.sessionManager.getBranch());
		sync(ctx);
	}
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") { ctx.ui.notify("/tools 只能在 TUI 模式使用", "error"); return; }
		sync(ctx);
		const trusted = ctx.isProjectTrusted();
		const effective = resolveEffectiveConfig(ctx.cwd, trusted);
		const result = await ctx.ui.custom<ToolsPanelSaveResult | undefined>((tui, theme, kb, done) => createToolsPanel({
			tui, theme, kb, done, tools: sortTools(pi.getAllTools().filter(isSupported)),
			originalExposures: adapter.view(ctx).originals,
			activeNames: new Set(pi.getActiveTools()), initialScope: effective.scope,
			canUseProjectScope: trusted, projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: formatDisplayPath(getGlobalConfigPath()), isEnvOverridden: effective.isEnvOverridden,
			initialGlobalExposures: readScopeConfig("global", ctx.cwd) ?? {},
			initialProjectExposures: !effective.isEnvOverridden && trusted ? readScopeConfig("project", ctx.cwd) : undefined,
		}));
		if (!result) return;
		saveScopeConfig({ scope: "global", cwd: ctx.cwd, exposures: result.globalExposures });
		if (!effective.isEnvOverridden && trusted) {
			if (result.projectExposures === undefined) deleteProjectConfigFile(ctx.cwd);
			else saveScopeConfig({ scope: "project", cwd: ctx.cwd, exposures: result.projectExposures });
		}
		ctx.ui.notify("Exposure 覆盖已保存，正在重载", "info");
		await ctx.reload(); // Old pi/ctx are invalid after this point. No callbacks cross the reload boundary.
	};
	adapter.install(handler);
	pi.registerCommand("tools", { description: "配置工具 Exposure：direct / codemode / deferred", handler });
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (_event, ctx) => sync(ctx));
}
