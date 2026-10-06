import { describe, expect, it } from "bun:test";
import type { KeybindingsManager, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { firstSentence } from "../src/shared.ts";
import { createToolsPanel, sortTools, type ToolsPanelOptions, type ToolsPanelSaveResult } from "../src/tools-panel.ts";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const kb = { matches: (data: string, action: string) => {
	if (action === "tui.select.pageUp") return matchesKey(data, Key.pageUp);
	if (action === "tui.select.pageDown") return matchesKey(data, Key.pageDown);
	return false;
} } as unknown as KeybindingsManager;
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
	it("keeps Markdown and multiline descriptions in one physical row, with no stale search text", () => {
		const search = { ...tool("tool_search", "model-only"), description: "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools may not have been provided upfront." };
		const test = setup({ tools: [tool("docs"), tool("codemode", "model-only"), search] });
		const initial = test.panel.render(80);
		test.panel.handleInput("\x1b[F");
		const searchFrame = test.panel.render(80);
		expect(searchFrame.length).toBe(initial.length);
		expect(searchFrame.some((line) => line.startsWith("Searches over deferred"))).toBe(true);
		expect(searchFrame.join("\n")).not.toContain("# Tool discovery");
		for (const line of searchFrame) expect(line).not.toMatch(/[\r\n\t\u2028\u2029]/u);
		for (const key of ["k", "k", "j", "j", "k"]) {
			test.panel.handleInput(key);
			const frame = test.panel.render(80);
			expect(frame.length).toBe(initial.length);
			expect(frame.findIndex((line) => line.includes("↑↓/jk"))).toBe(initial.findIndex((line) => line.includes("↑↓/jk")));
			if (!frame.some((line) => line.startsWith("→") && line.includes("tool_search"))) {
				expect(frame.join("\n")).not.toContain("Searches over deferred");
			}
		}
	});
	it("extracts a single sentence from headings, CRLF, tabs, and wrapped paragraphs", () => {
		expect(firstSentence("# Heading\r\n\r\nWrapped\r\nsentence\tends here. Next sentence.")).toBe("Wrapped sentence ends here.");
		expect(firstSentence("\n中文\n描述。下一句。")).toBe("中文 描述。");
		expect(firstSentence("No punctuation\nsecond line")).toBe("No punctuation second line");
		expect(firstSentence("## Heading only\n\n")).toBe("");
		expect(firstSentence(undefined)).toBe("");
	});
	it("bounds large lists, scrolls only at the edges, and pages by the visible count", () => {
		const tools = Array.from({ length: 100 }, (_, i) => tool(`tool_${String(i).padStart(3, "0")}`));
		const test = setup({ tools });
		const rows = () => test.panel.render(100).filter((line) => /^[→ ] [●○] /.test(line));
		expect(rows()).toHaveLength(12);
		expect(test.text()).toContain("1–12 / 100 · ↓ more");
		for (let i = 0; i < 11; i++) test.panel.handleInput("j");
		expect(test.text()).toContain("1–12 / 100");
		test.panel.handleInput("j");
		expect(test.text()).toContain("2–13 / 100 · ↑ more · ↓ more");
		test.panel.handleInput("\x1b[6~");
		expect(rows().find((line) => line.startsWith("→"))).toContain("tool_024");
		test.panel.handleInput("\x1b[5~");
		expect(rows().find((line) => line.startsWith("→"))).toContain("tool_012");
		test.panel.handleInput("\x1b[F");
		expect(test.text()).toContain("89–100 / 100 · ↑ more");
		expect(test.text()).not.toContain("↓ more");
		expect(rows().find((line) => line.startsWith("→"))).toContain("tool_099");
		test.panel.handleInput("j");
		expect(rows()).toHaveLength(12);
		test.panel.handleInput("\x1b[H");
		test.panel.handleInput("k");
		expect(rows()[0]).toStartWith("→ ○ tool_000");
		expect(test.text()).not.toContain("↑ more");
	});
	it("keeps separators and footer stationary while crossing and scrolling past locked tools", () => {
		const tools = sortTools([...Array.from({ length: 20 }, (_, i) => tool(`editable_${i}`)),
			...Array.from({ length: 20 }, (_, i) => tool(`locked_${i}`, "model-only"))]);
		const test = setup({ tools });
		const initial = test.panel.render(100);
		const separators = (lines: string[]) => lines.flatMap((line, i) => line.startsWith("─") ? [i] : []);
		for (let i = 0; i < tools.length; i++) {
			const frame = test.panel.render(100);
			expect(frame).toHaveLength(initial.length);
			expect(separators(frame)).toEqual(separators(initial));
			for (const index of separators(frame)) {
				expect(frame[index - 1]?.trim()).not.toBe("");
				expect(frame[index + 1]?.trim()).not.toBe("");
			}
			expect(frame.filter((line) => line.startsWith("→"))).toHaveLength(1);
			test.panel.handleInput("j");
		}
	});
	it("adapts to terminal height and resize without hiding the selected tool or footer", () => {
		const terminal = { rows: 40 };
		const test = setup({ tools: Array.from({ length: 50 }, (_, i) => tool(`tool_${i}`)),
			tui: { terminal, requestRender() {} } as TUI });
		test.panel.handleInput("\x1b[F");
		for (const height of [40, 24, 21, 18, 15, 30, 50]) {
			terminal.rows = height;
			const frame = test.panel.render(80);
			expect(frame.length).toBeLessThanOrEqual(height - 2);
			expect(frame.find((line) => line.startsWith("→"))).toContain("tool_49");
			expect(frame.at(-1)).toContain("Esc cancel");
			expect(frame.filter((line) => /^[→ ] [●○] /.test(line)).length).toBeLessThanOrEqual(12);
		}
		terminal.rows = 24;
		test.panel.handleInput("\x1b[H");
		const visible = test.panel.render(80).filter((line) => /^[→ ] [●○] /.test(line)).length;
		test.panel.handleInput("\x1b[6~");
		expect(test.panel.render(80).find((line) => line.startsWith("→"))).toContain(`tool_${visible} `);
	});
	it("keeps notice rows stable and clears stale notices when moving to another tool", () => {
		const test = setup({ tools: [tool("codemode", "model-only"), tool("docs")] });
		const initial = test.panel.render(100);
		test.panel.handleInput(" ");
		expect(test.panel.render(100)).toHaveLength(initial.length);
		expect(test.text()).toContain("Native service tools are managed by Pi");
		test.panel.handleInput("j");
		expect(test.panel.render(100)).toHaveLength(initial.length);
		expect(test.text()).not.toContain("Native service tools are managed by Pi");
	});
	it("clips long names by display columns without shifting mode and source columns", () => {
		const test = setup({ tools: [tool("中文工具".repeat(10)), tool("short")] });
		const rows = test.panel.render(80).filter((line) => /^[→ ] [●○] /.test(line));
		expect(rows[0]).toContain("...");
		expect(visibleWidth(rows[0]!.split("direct")[0]!)).toBe(visibleWidth(rows[1]!.split("direct")[0]!));
	});
	it("offers a safe resize hint on very short terminals and still permits cancellation", () => {
		const test = setup({ tui: { terminal: { rows: 10 }, requestRender() {} } as TUI });
		expect(test.text()).toContain("Enlarge terminal");
		test.panel.handleInput("q");
		expect(test.closed()).toBe(true);
		const saving = setup({ tui: { terminal: { rows: 10 }, requestRender() {} } as TUI });
		saving.panel.handleInput(" ");
		saving.panel.handleInput("\r");
		expect(saving.saved()?.globalExposures).toEqual({});
	});
	it("sorts editable extension tools before locked ones", () => {
		const sorted = sortTools([tool("old"), tool("docs", "deferred"), tool("tool_search", "model-only"), tool("read", "direct", "builtin")]);
		expect(sorted.map((t) => t.name)).toEqual(["docs", "old", "read", "tool_search"]);
	});
});
