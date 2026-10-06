import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { readConfigFile, writeConfigFile } from "../src/config.ts";
import { isSupported, type ToolExposures } from "../src/shared.ts";
import { sortTools } from "../src/tools-panel.ts";

// Real file loading is important: jiti must share the HOST's ExtensionRunner, including on /reload.
const sdk = await import(process.env.PI_TOOLS_TEST_HOST ?? "@earendil-works/pi-coding-agent");
let dir: string, configPath: string;
let originalConfig: string | undefined, originalOffline: string | undefined;
const sessions: any[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-tools-sdk-"));
	configPath = join(dir, "pi-tools.json");
	// Stage the shipped src without repository devDependencies, as a normal package installation does.
	cpSync(resolve("src"), join(dir, "extension"), { recursive: true });
	originalConfig = process.env.PI_TOOLS_CONFIG;
	originalOffline = process.env.PI_OFFLINE;
	process.env.PI_TOOLS_CONFIG = configPath;
	process.env.PI_OFFLINE = "1";
});
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	if (originalConfig === undefined) delete process.env.PI_TOOLS_CONFIG;
	else process.env.PI_TOOLS_CONFIG = originalConfig;
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	rmSync(dir, { recursive: true, force: true });
});
async function setup(exposures: ToolExposures, options: any = {}) {
	writeConfigFile(configPath, exposures);
	let api: any, ctx: any;
	let enabled = options.enabled !== false;
	const definitions = new Map<string, any>();
	const errors: any[] = [];
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"),
		modelsPath: null, modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
	const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ["read", "bash", "docs"] });
	const extensionPath = process.env.PI_TOOLS_TEST_SOURCE ?? join(dir, "extension", "index.ts");
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionsOverride: (base: any) => ({ ...base,
			extensions: enabled ? base.extensions : base.extensions.filter((e: any) => e.path !== extensionPath) }),
		additionalExtensionPaths: [extensionPath],
		extensionFactories: [sdk.createToolSearchExtension(), sdk.createCodemodeExtension(), (pi: any) => {
			api = pi;
			if (options.commandCollision) pi.registerCommand("tools", { description: "Other tools command", handler() {} });
			for (const [name, exposure] of [["legacy", undefined], ["docs", "deferred"], ["images", "codemode"],
				["locked", "model-only"], ["withdrawn", "hidden"]]) {
				const definition = mock(name!, exposure);
				definitions.set(name!, definition);
				pi.registerTool(definition);
			}
			pi.on("session_start", (_e: any, context: any) => { ctx = context; });
		}],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
		resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory(dir),
		customTools: [mock("sdk_only", undefined)], ...options.sessionOptions });
	sessions.push(session);
	expect(extensionsResult.errors).toEqual([]);
	await session.bindExtensions({ onError: (error: any) => { errors.push(error); } });
	expect(errors).toEqual([]);
	return { session, definitions, errors, resourceLoader, api: () => api, context: () => ctx,
		disable: () => { enabled = false; },
		sync: () => session._extensionRunner.emitBeforeAgentStart("test", undefined, {}) };
}
function mock(name: string, exposure: string | undefined) {
	return { name, label: name, description: `${name} documentation lookup`, exposure, parameters: Type.Object({}),
		annotations: { readOnlyHint: true }, namespace: { name: "test", description: "Test tools", instructions: "preserve" },
		renderCall: () => undefined, renderResult: () => undefined,
		execute: async () => ({ content: [{ type: "text", text: `original ${name} executor` }], details: undefined }) };
}
const exposure = (session: any, name: string) => session.getAllTools().find((t: any) => t.name === name)?.exposure;

describe("actual extension loading, without model requests", () => {
	it("overlays a tool with missing exposure, and native search loads its original executor", async () => {
		const { session, definitions, sync, errors } = await setup({ legacy: "deferred" });
		expect(exposure(session, "legacy")).toBe("deferred");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		expect(session.getActiveToolNames()).toContain("tool_search");
		const source = definitions.get("legacy");
		const effective = session.getToolDefinition("legacy");
		expect(source.exposure).toBeUndefined();
		for (const key of ["execute", "parameters", "renderCall", "renderResult", "namespace", "annotations"]) {
			expect(effective[key]).toBe(source[key]);
		}
		const result = await session.getToolDefinition("tool_search").execute("search", { query: "legacy", limit: 1 });
		expect(result.details.loaded).toEqual(["legacy"]);
		expect((await effective.execute("test", {})).content[0].text).toBe("original legacy executor");
		await sync();
		await session.reload();
		expect(session.getActiveToolNames()).toContain("legacy");
		expect(errors).toEqual([]);
		expect(session.getAllTools().some((t: any) => t.name === "enable_tool")).toBe(false);
	});
	it("does not apply file edits until reload, then changes actual exposure in all three directions", async () => {
		const { session, sync, errors } = await setup({ legacy: "deferred" });
		writeConfigFile(configPath, { legacy: "codemode" });
		await sync();
		expect(exposure(session, "legacy")).toBe("deferred");
		await session.reload();
		expect(exposure(session, "legacy")).toBe("codemode");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		expect(session.getActiveToolNames()).toContain("codemode");
		writeConfigFile(configPath, { legacy: "direct" });
		await session.reload();
		expect(exposure(session, "legacy")).toBe("direct");
		expect(session.getActiveToolNames()).toContain("legacy");
		writeConfigFile(configPath, { legacy: "deferred" });
		await session.reload();
		expect(exposure(session, "legacy")).toBe("deferred");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		expect(errors).toEqual([]);
	});
	it("distinguishes codemode's directory from deferred's search-only exposure", async () => {
		const { session, api } = await setup({ legacy: "codemode", docs: "deferred" });
		const run = (code: string) => session.getToolDefinition("codemode").execute("script", { code }, undefined, undefined,
			session._extensionRunner.createToolContext("script"));
		const directory = session.agent.state.tools.find((t: any) => t.name === "codemode").description;
		expect(directory).toContain("legacy");
		expect(directory).not.toContain("docs documentation lookup");
		// Fixture for a model-issued parent call: nested calls must still go through Pi's permission pipeline.
		session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "script", name: "codemode", arguments: {} }],
			api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: Date.now(), stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const call = await run('text(await tools.legacy({}));');
		expect(JSON.stringify(call)).toContain("original legacy executor");
		api().on("tool_call", (event: any) => event.toolName === "legacy" ? { block: true, reason: "permission denied by owner" } : undefined);
		const denied = await run('text(await tools.legacy({}));');
		expect(JSON.stringify(denied)).toContain("permission denied by owner");
		expect(JSON.stringify(denied)).not.toContain("original legacy executor");
	});
	it("does not restore unrelated or externally deactivated tools on reload", async () => {
		const { session, api, errors } = await setup({ legacy: "direct", docs: "deferred" });
		api().setActiveTools(session.getActiveToolNames().filter((name: string) => !["bash", "legacy"].includes(name)));
		writeConfigFile(configPath, { legacy: "direct", docs: "deferred", images: "direct" });
		await session.reload();
		expect(session.getActiveToolNames()).toContain("images");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		expect(errors).toEqual([]);
	});
	it("respects CLI exclusions and protects model-only, hidden, builtins, SDK and dispatchers", async () => {
		const { session } = await setup({ legacy: "deferred", locked: "deferred", withdrawn: "direct", read: "deferred",
			tool_search: "direct", codemode: "direct", sdk_only: "deferred" }, { sessionOptions: { excludeTools: ["legacy"] } });
		expect(exposure(session, "legacy")).toBeUndefined();
		for (const [name, expected] of [["locked", "model-only"], ["withdrawn", "hidden"], ["read", "direct"],
			["tool_search", "model-only"], ["codemode", "model-only"], ["sdk_only", "direct"]]) expect(exposure(session, name!)).toBe(expected);
	});
	it("applies overlays to late registrations without changing author definitions", async () => {
		const { session, api, sync, errors } = await setup({ late: "deferred" });
		const late = mock("late", undefined);
		api().registerTool(late);
		await sync();
		expect(exposure(session, "late")).toBe("deferred");
		expect(late.exposure).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("late");
		expect(session.getActiveToolNames()).toContain("tool_search");
		expect(errors).toEqual([]);
	});
	it("does not override an owner's runtime withdrawal or model-only conversion", async () => {
		const { session, api, sync, errors } = await setup({ legacy: "deferred" });
		api().registerTool(mock("legacy", "hidden"));
		await sync();
		expect(exposure(session, "legacy")).toBe("hidden");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		api().registerTool(mock("legacy", "model-only"));
		await sync();
		expect(exposure(session, "legacy")).toBe("model-only");
		expect(errors).toEqual([]);
	});
	it("removing an override restores the tool author's exposure", async () => {
		const { session } = await setup({ legacy: "deferred", docs: "direct" });
		writeConfigFile(configPath, {});
		await session.reload();
		expect(exposure(session, "legacy")).toBe("direct");
		expect(exposure(session, "docs")).toBe("deferred");
		expect(session.getActiveToolNames()).toContain("legacy");
		expect(session.getActiveToolNames()).not.toContain("docs");
	});
	it("disabled pi-tools is a passthrough, even with its process-wide hook still installed", async () => {
		const { session, disable, errors } = await setup({ legacy: "deferred" });
		disable();
		await session.reload();
		expect(session._extensionRunner.getCommand("tools")).toBeUndefined();
		expect(exposure(session, "legacy")).toBe("direct");
		expect(session.getActiveToolNames()).toContain("legacy");
		expect(errors).toEqual([]);
	});
	it("dispatches by handler identity even when /tools is namespaced by a command collision", async () => {
		const { session } = await setup({ legacy: "deferred" }, { commandCollision: true });
		expect(session._extensionRunner.getCommand("tools")).toBeUndefined();
		expect(exposure(session, "legacy")).toBe("deferred");
	});
	it("isolates enabled and disabled sessions in the same process", async () => {
		const first = await setup({ legacy: "deferred" });
		const second = await setup({ legacy: "codemode" }, { enabled: false });
		expect(exposure(first.session, "legacy")).toBe("deferred");
		expect(exposure(second.session, "legacy")).toBe("direct");
		first.api().registerTool(mock("another", undefined)); // Registry rebuild still uses the first runner's frozen overrides.
		expect(exposure(first.session, "legacy")).toBe("deferred");
	});
	it("saves the direct tool's panel draft, closes the modal, then reloads", async () => {
		const { session, context, errors } = await setup({});
		const index = sortTools(session.getAllTools().filter(isSupported)).findIndex((t) => t.name === "legacy");
		const ctx = context();
		let closed = false;
		await session._extensionRunner.getCommand("tools").handler("", { ...ctx, mode: "tui",
			reload: async () => { expect(closed).toBe(true); await session.reload(); },
			ui: { ...ctx.ui, notify() {}, async custom(factory: Function) {
				let result: any;
				const panel = factory({ requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s },
					{ matches: () => false }, (value: any) => { closed = true; result = value; });
				for (let i = 0; i < index; i++) panel.handleInput("j");
				panel.handleInput(" "); panel.handleInput(" "); panel.handleInput("\r");
				return result;
			} },
		});
		expect(readConfigFile(configPath)).toEqual({ legacy: "deferred" });
		expect(exposure(session, "legacy")).toBe("deferred");
		expect(session.getActiveToolNames()).not.toContain("legacy");
		expect(errors).toEqual([]);
	});
	it("leaves native search-loaded branch restoration to Pi", async () => {
		const { session, errors } = await setup({ legacy: "deferred" });
		const manager = session.sessionManager;
		const declarations = session.getAllTools().filter((t: any) => session.getActiveToolNames().includes(t.name));
		const unloaded = manager.appendMessage({ role: "system", content: "checkpoint", toolsAdded: declarations, timestamp: Date.now() });
		await session.getToolDefinition("tool_search").execute("search", { query: "legacy", limit: 1 });
		const loaded = manager.appendMessage({ role: "system", content: "", toolsAdded: [session.getAllTools().find((t: any) => t.name === "legacy")], timestamp: Date.now() });
		await session.navigateTree(unloaded);
		expect(session.getActiveToolNames()).not.toContain("legacy");
		await session.navigateTree(loaded);
		expect(session.getActiveToolNames()).toContain("legacy");
		expect(errors).toEqual([]);
	});
});
