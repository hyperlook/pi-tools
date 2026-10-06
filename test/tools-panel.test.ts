import { describe, expect, it } from "bun:test";
import type { KeybindingsManager, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolsPanel, sortTools, type ToolsPanelOptions, type ToolsPanelSaveResult } from "../src/tools-panel.ts";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const kb = { matches: () => false } as unknown as KeybindingsManager;
const tui = { requestRender() {} } as TUI;
function tool(name: string, exposure: ToolInfo["exposure"] = "direct", source = "npm:example"): ToolInfo {
	return { name, exposure, description: `Description of ${name}`, parameters: { type: "object" }, sourceInfo: { source } };
}
function setup(overrides: Partial<ToolsPanelOptions> = {}) {
	let saved: ToolsPanelSaveResult | undefined, closed = false;
	const panel = createToolsPanel({
		tui, theme, kb, done: (result) => { saved = result; closed = true; }, tools: [tool("docs")],
		originalExposures: new Map(), activeNames: new Set(),
		initialScope: "global", canUseProjectScope: true, projectDisplayPath: ".pi/pi-tools.json",
		globalDisplayPath: "~/.pi/agent/pi-tools.json", initialGlobalExposures: {}, initialProjectExposures: {},
		...overrides,
	});
	return { panel, saved: () => saved, closed: () => closed, text: () => panel.render(160).join("\n") };
}
describe("layered exposure panel", () => {
	it("makes unconfigured direct tools editable and cycles direct, codemode, deferred", () => {
		const test = setup();
		expect(test.text()).toContain("docs  direct");
		expect(test.text()).toContain("default");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("direct → codemode");
		expect(test.text()).toContain("1 change");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("direct → deferred");
		test.panel.handleInput(" ");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "direct" });
	});
	it("steps backwards with the left arrow", () => {
		const test = setup();
		test.panel.handleInput("\x1b[D"); test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "deferred" });
	});
	it("starts from the author's exposure", () => {
		const test = setup({ tools: [tool("docs", "deferred")] });
		expect(test.text()).toContain("docs  deferred");
		test.panel.handleInput(" "); test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "direct" });
	});
	it("clears an override back to the original definition, not the overridden live value", () => {
		const test = setup({ tools: [tool("docs", "deferred")], originalExposures: new Map([["docs", "direct"]]),
			initialGlobalExposures: { docs: "deferred" } });
		expect(test.text()).toContain("clear override");
		test.panel.handleInput("d");
		expect(test.text()).toContain("deferred → direct");
		expect(test.text()).not.toContain("clear override");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({});
	});
	it("counts unsaved changes and drops them when reverted", () => {
		const test = setup();
		expect(test.text()).toContain("Enter save & reload");
		expect(test.text()).not.toContain("change)");
		test.panel.handleInput(" ");
		expect(test.saved()).toBeUndefined();
		expect(test.text()).toContain("(1 change)");
		test.panel.handleInput("d");
		expect(test.text()).not.toContain("(1 change)");
		test.panel.handleInput(" "); test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "codemode" });
		expect(test.closed()).toBe(true);
	});
	it("cancels drafts with q or Escape", () => {
		for (const key of ["q", "\x1b"]) {
			const test = setup(); test.panel.handleInput(" "); test.panel.handleInput(key);
			expect(test.saved()).toBeUndefined(); expect(test.closed()).toBe(true);
		}
	});
	it("project edits are sparse: only the touched tool is stored", () => {
		const test = setup({ initialScope: "project", initialGlobalExposures: { docs: "direct", offline: "deferred" } });
		expect(test.text()).toContain("inheriting global");
		test.panel.handleInput(" "); test.panel.handleInput("\r");
		expect(test.saved()).toEqual({ globalExposures: { docs: "direct", offline: "deferred" }, projectExposures: { docs: "codemode" } });
	});
	it("shows where each value comes from", () => {
		const tools = [tool("a"), tool("b"), tool("c")];
		const test = setup({ tools, initialScope: "project", initialGlobalExposures: { b: "deferred", c: "deferred" },
			initialProjectExposures: { c: "codemode" } });
		const rows = test.text().split("\n");
		expect(rows.find((r) => r.includes(" a "))).toMatch(/direct\s+default/);
		expect(rows.find((r) => r.includes(" b "))).toMatch(/deferred\s+global/);
		expect(rows.find((r) => r.includes(" c "))).toMatch(/codemode\s+project/);
	});
	it("global view ignores project overrides but flags the shadowing", () => {
		const test = setup({ initialGlobalExposures: { docs: "deferred" }, initialProjectExposures: { docs: "codemode" } });
		expect(test.text()).toContain("deferred");
		expect(test.text()).toContain("project: codemode");
	});
	it("clears all project overrides with r, and only offers it when there are some", () => {
		const test = setup({ initialScope: "project", initialProjectExposures: { docs: "deferred" }, initialGlobalExposures: { docs: "direct" } });
		expect(test.text()).toContain("clear all project");
		test.panel.handleInput("r");
		expect(test.text()).toContain("inheriting global");
		expect(test.text()).not.toContain("clear all project");
		test.panel.handleInput("\r");
		expect(test.saved()?.projectExposures).toEqual({});
	});
	it("edits all three ordinary exposures, but protects model-only and hidden", () => {
		for (const exposure of ["direct", "codemode", "deferred", "model-only", "hidden"] as const) {
			const test = setup({ tools: [tool("docs", exposure)] });
			test.panel.handleInput(" "); test.panel.handleInput("\r");
			expect(test.saved()?.globalExposures).toEqual({ direct: { docs: "codemode" }, codemode: { docs: "deferred" },
				deferred: { docs: "direct" }, "model-only": {}, hidden: {} }[exposure]);
		}
	});
	it("protects builtins, SDK-only tools and dispatchers, and groups them as locked", () => {
		for (const entry of [tool("read", "direct", "builtin"), tool("sdk", "direct", "sdk"),
			tool("tool_search", "model-only"), tool("codemode", "model-only")]) {
			const test = setup({ tools: [entry] }); test.panel.handleInput(" "); test.panel.handleInput("\r");
			expect(test.saved()?.globalExposures).toEqual({});
			expect(test.text()).toContain("locked");
		}
		const mixed = setup({ tools: sortTools([tool("read", "direct", "builtin"), tool("docs")]) });
		expect(mixed.text()).toContain("locked (1)");
	});
	it("locks project scope when untrusted or overridden by environment", () => {
		for (const opts of [{ canUseProjectScope: false }, { isEnvOverridden: true }]) {
			const test = setup(opts); test.panel.handleInput("\t"); expect(test.text()).toContain("[Global]");
		}
	});
	it("shows loaded state independently from exposure", () => {
		const test = setup({ initialGlobalExposures: { docs: "deferred" }, activeNames: new Set(["docs"]) });
		expect(test.text()).toContain("●");
		expect(test.text()).toContain("loaded in context");
		expect(test.text()).toContain("direct → deferred");
	});
	it("fits narrow terminal widths with Chinese and ANSI", () => {
		const ansiTheme = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[0m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[0m` } as Theme;
		const test = setup({ tools: [tool("很长的中文工具名称".repeat(4))], theme: ansiTheme });
		for (const width of [0, 1, 8, 24, 80]) for (const line of test.panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
	it("preserves unavailable-tool overrides even with an empty list", () => {
		const test = setup({ tools: [], initialGlobalExposures: { offline: "deferred" } });
		for (const key of ["j", "k", " ", "d"]) test.panel.handleInput(key);
		expect(test.text()).toContain("No registered tools found"); test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ offline: "deferred" });
	});
	it("sorts editable extension tools before locked ones", () => {
		const sorted = sortTools([tool("old"), tool("docs", "deferred"), tool("tool_search", "model-only"), tool("read", "direct", "builtin")]);
		expect(sorted.map((t) => t.name)).toEqual(["docs", "old", "read", "tool_search"]);
	});
});
