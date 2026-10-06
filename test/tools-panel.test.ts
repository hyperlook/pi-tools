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
		globalDisplayPath: "~/.pi/agent/pi-tools.json", initialGlobalExposures: {}, initialProjectExposures: undefined,
		...overrides,
	});
	return { panel, saved: () => saved, closed: () => closed, text: () => panel.render(160).join("\n") };
}
describe("three native exposure choices", () => {
	it("makes unconfigured direct tools editable and cycles direct, codemode, deferred", () => {
		const test = setup();
		expect(test.text()).toContain("docs  direct");
		expect(test.text()).not.toContain("只读");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("docs  codemode *");
		test.panel.handleInput(" ");
		expect(test.text()).toContain("docs  deferred *");
		test.panel.handleInput(" ");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "direct" });
	});
	it("starts from the author's exposure, not a synthetic inherit state", () => {
		const test = setup({ tools: [tool("docs", "deferred")] });
		expect(test.text()).toContain("docs  deferred");
		test.panel.handleInput(" "); test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({ docs: "direct" });
	});
	it("can reset to the original definition rather than the already-overridden effective exposure", () => {
		const test = setup({ tools: [tool("docs", "deferred")], originalExposures: new Map([["docs", "direct"]]),
			initialGlobalExposures: { docs: "deferred" } });
		test.panel.handleInput("d");
		expect(test.text()).toContain("target: direct");
		expect(test.text()).toContain("current: deferred");
		test.panel.handleInput("\r");
		expect(test.saved()?.globalExposures).toEqual({});
	});
	it("keeps changes in a draft until completion", () => {
		const test = setup();
		test.panel.handleInput(" ");
		expect(test.saved()).toBeUndefined();
		expect(test.text()).toContain("unsaved *");
		test.panel.handleInput("d");
		expect(test.text()).not.toContain("unsaved *");
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
	it("forks project overrides from global on the first edit", () => {
		const test = setup({ initialScope: "project", initialGlobalExposures: { docs: "direct", offline: "deferred" } });
		expect(test.text()).toContain("inherit global");
		test.panel.handleInput(" "); test.panel.handleInput("\r");
		expect(test.saved()).toEqual({ globalExposures: { docs: "direct", offline: "deferred" },
			projectExposures: { docs: "codemode", offline: "deferred" } });
	});
	it("resets project overrides to global inheritance", () => {
		const test = setup({ initialScope: "project", initialProjectExposures: { docs: "direct" } });
		test.panel.handleInput("r"); expect(test.text()).toContain("inherit global"); test.panel.handleInput("\r");
		expect(test.saved()?.projectExposures).toBeUndefined();
	});
	it("edits all three ordinary exposures, but protects model-only and hidden", () => {
		for (const exposure of ["direct", "codemode", "deferred", "model-only", "hidden"] as const) {
			const test = setup({ tools: [tool("docs", exposure)] });
			test.panel.handleInput(" "); test.panel.handleInput("\r");
			expect(test.saved()?.globalExposures).toEqual({ direct: { docs: "codemode" }, codemode: { docs: "deferred" },
				deferred: { docs: "direct" }, "model-only": {}, hidden: {} }[exposure]);
		}
	});
	it("protects builtins, SDK-only tools and dispatchers", () => {
		for (const entry of [tool("read", "direct", "builtin"), tool("sdk", "direct", "sdk"),
			tool("tool_search", "model-only"), tool("codemode", "model-only")]) {
			const test = setup({ tools: [entry] }); test.panel.handleInput(" "); test.panel.handleInput("\r");
			expect(test.saved()?.globalExposures).toEqual({});
			expect(test.text()).toContain("readonly");
		}
	});
	it("locks project scope when untrusted or overridden by environment", () => {
		for (const opts of [{ canUseProjectScope: false }, { isEnvOverridden: true }]) {
			const test = setup(opts); test.panel.handleInput("\t"); expect(test.text()).toContain("Global");
		}
	});
	it("shows declaration status independently from exposure", () => {
		const test = setup({ initialGlobalExposures: { docs: "deferred" }, activeNames: new Set(["docs"]) });
		expect(test.text()).toContain("●");
		expect(test.text()).toContain("deferred *");
		expect(test.text()).toContain("Enter save & reload");
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
	it("sorts direct and native tools together after builtin and service tools", () => {
		const sorted = sortTools([tool("old"), tool("docs", "deferred"), tool("tool_search", "model-only"), tool("read", "direct", "builtin")]);
		expect(sorted.map((t) => t.name)).toEqual(["read", "tool_search", "docs", "old"]);
	});
});
