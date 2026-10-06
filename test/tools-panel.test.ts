import { describe, expect, it } from "bun:test";
import type { KeybindingsManager, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolsPanel, sortTools, type ToolsPanelOptions, type ToolsPanelSaveResult } from "../src/tools-panel.ts";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const kb = { matches: () => false } as unknown as KeybindingsManager;
const tui = { requestRender() {} } as TUI;
function tool(name: string, exposure: ToolInfo["exposure"] = "deferred", source = "npm:example"): ToolInfo {
	return { name, exposure, description: `Description of ${name}`, parameters: { type: "object" }, sourceInfo: { source } };
}
function setup(overrides: Partial<ToolsPanelOptions> = {}) {
	let saved: ToolsPanelSaveResult | undefined, closed = false;
	const panel = createToolsPanel({
		tui, theme, kb, done: () => { closed = true; }, tools: [tool("docs")], activeNames: new Set(),
		initialScope: "global", canUseProjectScope: true, projectDisplayPath: ".pi/pi-tools.json",
		globalDisplayPath: "~/.pi/agent/pi-tools.json", initialGlobalModes: {}, initialProjectModes: undefined,
		onSave: (result) => { saved = result; }, ...overrides,
	});
	return { panel, saved: () => saved, closed: () => closed, text: () => panel.render(120).join("\n") };
}
describe("three-state native preference panel", () => {
	it("cycles follow, always, on-demand, follow and removes the override", () => {
		const test = setup();
		expect(test.text()).toContain("跟随扩展");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("常驻");
		expect(test.text()).toContain("未保存 *");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("按需");
		test.panel.handleInput(" ");
		expect(test.text()).not.toContain("未保存 *");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalModes).toEqual({});
	});
	it("keeps draft edits off disk until save", () => {
		const test = setup();
		test.panel.handleInput(" ");
		expect(test.saved()).toBeUndefined();
		test.panel.handleInput("\r");
		expect(test.saved()?.globalModes).toEqual({ docs: "always" });
		expect(test.closed()).toBe(true);
	});
	it("cancels drafts with q or Escape", () => {
		for (const key of ["q", "\x1b"]) {
			const test = setup();
			test.panel.handleInput(" ");
			test.panel.handleInput(key);
			expect(test.saved()).toBeUndefined();
			expect(test.closed()).toBe(true);
		}
	});
	it("forks project preferences from global on first edit", () => {
		const test = setup({ initialScope: "project", initialGlobalModes: { docs: "always", absent: "on-demand" } });
		expect(test.text()).toContain("继承全局");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("已定制");
		test.panel.handleInput("\r");
		expect(test.saved()).toEqual({ globalModes: { docs: "always", absent: "on-demand" },
			projectModes: { docs: "on-demand", absent: "on-demand" } });
	});
	it("resets project preferences to global inheritance", () => {
		const test = setup({ initialScope: "project", initialProjectModes: { docs: "always" } });
		test.panel.handleInput("r");
		expect(test.text()).toContain("继承全局");
		test.panel.handleInput("\r");
		expect(test.saved()?.projectModes).toBeUndefined();
	});
	it("lets deferred and codemode tools be edited, but not direct or model-only tools", () => {
		for (const exposure of ["deferred", "codemode", "direct", "model-only", "hidden"] as const) {
			const test = setup({ tools: [tool("docs", exposure)] });
			test.panel.handleInput(" ");
			test.panel.handleInput("\r");
			expect(test.saved()?.globalModes).toEqual(
				exposure === "deferred" || exposure === "codemode" ? { docs: "always" } : {});
		}
	});
	it("shows why unadapted tools are readonly", () => {
		const test = setup({ tools: [tool("old", "direct")] });
		test.panel.handleInput(" ");
		expect(test.text()).toContain("需由工具所属扩展适配 deferred");
		expect(test.text()).toContain("只读");
	});
	it("does not edit builtins or native orchestrators", () => {
		for (const entry of [tool("read", "direct", "builtin"), tool("tool_search", "model-only"), tool("codemode", "model-only")]) {
			const test = setup({ tools: [entry] });
			test.panel.handleInput(" ");
			test.panel.handleInput("\r");
			expect(test.saved()?.globalModes).toEqual({});
		}
	});
	it("locks project scope for untrusted projects or an env override", () => {
		for (const opts of [{ canUseProjectScope: false }, { isEnvOverridden: true }]) {
			const test = setup(opts);
			test.panel.handleInput("\t");
			expect(test.text()).toContain("Global");
		}
	});
	it("separates configured preference from current declaration state", () => {
		const test = setup({ initialGlobalModes: { docs: "on-demand" }, activeNames: new Set(["docs"]) });
		expect(test.text()).toContain("按需 · 已声明");
	});
	it("keeps every line within narrow widths, including Chinese and ANSI", () => {
		const ansiTheme = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[0m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[0m` } as Theme;
		const test = setup({ tools: [tool("很长的中文工具名称".repeat(4))], theme: ansiTheme });
		for (const width of [0, 1, 8, 24, 80]) {
			for (const line of test.panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
	it("handles an empty list and preserves unavailable-tool preferences", () => {
		const test = setup({ tools: [], initialGlobalModes: { offline: "on-demand" } });
		for (const key of ["j", "k", " "]) test.panel.handleInput(key);
		expect(test.text()).toContain("没有已注册的工具");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalModes).toEqual({ offline: "on-demand" });
	});
	it("sorts builtins, services, native tools then unsupported tools", () => {
		const sorted = sortTools([tool("old", "direct"), tool("docs"), tool("tool_search", "model-only"), tool("read", "direct", "builtin")]);
		expect(sorted.map((t) => t.name)).toEqual(["read", "tool_search", "docs", "old"]);
	});
});
