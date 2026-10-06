import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import toolsExtension from "../src/index.ts";
import { readConfigFile, writeConfigFile } from "../src/config.ts";
import { isSupported, type ToolModes } from "../src/shared.ts";
import { sortTools } from "../src/tools-panel.ts";

// Set PI_TOOLS_TEST_HOST to another installed Pi's dist/index.js to run the same SDK tests there.
const sdk = await import(process.env.PI_TOOLS_TEST_HOST ?? "@earendil-works/pi-coding-agent");
let dir: string, configPath: string;
let originalConfig: string | undefined, originalOffline: string | undefined;
const sessions: any[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-tools-sdk-"));
	configPath = join(dir, "pi-tools.json");
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
async function setup(modes: ToolModes, options: any = {}) {
	writeConfigFile(configPath, modes);
	let api: any, ctx: any;
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"),
		modelsPath: null, modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
	const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ["read", "bash", "docs"] });
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [sdk.createToolSearchExtension(), (pi: any) => {
			api = pi;
			toolsExtension({ ...pi,
				registerCommand(name: string, command: any) { commands.set(name, command); return pi.registerCommand(name, command); },
				on(event: string, handler: Function) {
					handlers.set(event, handler);
					return pi.on(event, (e: any, context: any) => { ctx = context; return handler(e, context); });
				},
			} as any);
		}],
	});
	await resourceLoader.reload();
	function mock(name: string, exposure: string) {
		return { name, label: name, description: `${name} documentation lookup`, exposure, parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) };
	}
	const { session, extensionsResult } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
		resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory(dir),
		customTools: [mock("docs", "deferred"), mock("images", "codemode"), mock("legacy", "direct")], ...options });
	sessions.push(session);
	expect(extensionsResult.errors).toEqual([]);
	await session.bindExtensions({ onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
	return { session, api: () => api, context: () => ctx, commands,
		sync: () => handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx) };
}

describe("real SDK integration, without model requests", () => {
	it("registers no tools and lets native tool_search load non-MCP deferred tools", async () => {
		const { session, sync } = await setup({ docs: "on-demand" });
		expect(session.getAllTools().some((t: any) => t.name === "enable_tool")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("docs");
		expect(session.getActiveToolNames()).toContain("tool_search");
		const result = await session.getToolDefinition("tool_search").execute("search", { query: "docs", limit: 1 });
		expect(result.details.loaded).toEqual(["docs"]);
		expect(session.getActiveToolNames()).toContain("docs");
		await sync();
		expect(session.getActiveToolNames()).toContain("docs");
		await session.reload();
		expect(session.getActiveToolNames()).toContain("docs");
		expect(session.getAllTools().some((t: any) => t.name === "enable_tool")).toBe(false);
	});
	it("applies file changes without restoring externally deactivated tools", async () => {
		const { session, api, sync } = await setup({ docs: "always", images: "on-demand" });
		api().setActiveTools(session.getActiveToolNames().filter((name: string) => !["bash", "docs"].includes(name)));
		writeConfigFile(configPath, { docs: "always", images: "always" });
		await sync();
		expect(session.getActiveToolNames()).toContain("images");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).not.toContain("docs");
		await session.reload();
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).not.toContain("docs");
	});
	it("respects CLI exclusions and never adapts direct tools", async () => {
		const { session } = await setup({ docs: "always", legacy: "on-demand" }, { excludeTools: ["docs"] });
		expect(session.getAllTools().some((t: any) => t.name === "docs")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("docs");
		expect(session.getActiveToolNames()).toContain("legacy");
		expect(session.getAllTools().find((t: any) => t.name === "legacy").exposure).toBe("direct");
	});
	it("saves a real command's panel draft and applies it through the SDK", async () => {
		const { session, context, commands } = await setup({});
		const docsIndex = sortTools(session.getAllTools().filter(isSupported)).findIndex((t) => t.name === "docs");
		const ctx = context();
		await commands.get("tools").handler("", { ...ctx, mode: "tui", ui: { ...ctx.ui,
			notify() {},
			async custom(factory: Function) {
				const panel = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text },
					{ matches: () => false }, () => {});
				for (let i = 0; i < docsIndex; i++) panel.handleInput("j");
				panel.handleInput(" "); // inherit -> always
				panel.handleInput(" "); // always -> on-demand
				panel.handleInput("\r");
			},
		} });
		expect(readConfigFile(configPath)).toEqual({ docs: "on-demand" });
		expect(session.getActiveToolNames()).not.toContain("docs");
		expect(session.getActiveToolNames()).toContain("tool_search");
	});
	it("leaves branch tool restoration to Pi on actual tree navigation", async () => {
		const { session } = await setup({ docs: "on-demand" });
		const manager = session.sessionManager;
		const declarations = session.getAllTools().filter((t: any) => session.getActiveToolNames().includes(t.name));
		const unloaded = manager.appendMessage({ role: "system", content: "test checkpoint", toolsAdded: declarations, timestamp: Date.now() });
		await session.getToolDefinition("tool_search").execute("search", { query: "docs", limit: 1 });
		const loaded = manager.appendMessage({ role: "system", content: "", toolsAdded: [session.getAllTools().find((t: any) => t.name === "docs")], timestamp: Date.now() });
		await session.navigateTree(unloaded);
		expect(session.getActiveToolNames()).not.toContain("docs");
		await session.navigateTree(loaded);
		expect(session.getActiveToolNames()).toContain("docs");
	});
});
