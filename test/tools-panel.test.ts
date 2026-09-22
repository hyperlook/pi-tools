import { describe, expect, it } from "bun:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolsPanel } from "../src/tools-panel.ts";

function mockTool(name: string, isBuiltin: boolean): ToolInfo {
	return {
		name,
		description: `Description of ${name}`,
		parameters: { type: "object", properties: {} },
		sourceInfo: isBuiltin ? { source: "builtin" } : { source: "npm:test" },
		execute: async () => ({ content: [] }),
	};
}

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const mockTui = {
	requestRender: () => {},
} as any;

const mockKb = {
	matches: (data: string, action: string) => {
		if (action === "tui.select.confirm" && data === " ") return true;
		if (action === "tui.select.down" && data === "j") return true;
		return false;
	},
} as any;

describe("tools panel interactions", () => {
	const tools: ToolInfo[] = [
		mockTool("read", true),
		mockTool("bash", true),
		mockTool("web_search", false),
	];

	it("renders active vs inactive state for builtin tools with locked indicator", () => {
		// Pi has active "read", but "bash" is inactive
		const activeBuiltinTools = new Set(["read"]);
		const scopeEnabled = new Set(["web_search"]);

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeBuiltinTools,
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			getScopeEnabled: () => scopeEnabled,
			onToggle: () => {},
		});

		const lines = panel.render(100);
		const fullText = lines.join("\n");

		// read should show active 🔒
		expect(fullText).toContain("read");
		expect(fullText).toContain("active 🔒");

		// bash should show inactive 🔒
		expect(fullText).toContain("bash");
		expect(fullText).toContain("inactive 🔒");

		// web_search should show enabled
		expect(fullText).toContain("web_search");
		expect(fullText).toContain("enabled");
	});

	it("refuses to toggle builtin tool and shows friendly warning notice", () => {
		const activeBuiltinTools = new Set(["read", "bash"]);
		const toggled: string[] = [];

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeBuiltinTools,
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			getScopeEnabled: () => new Set(),
			onToggle: (id) => toggled.push(id),
		});

		// Cursor starts at index 0 ("read", a builtin tool)
		// User hits space
		panel.handleInput(" ");

		// onToggle must NOT have been called
		expect(toggled).toEqual([]);

		// Render should now display warning notice
		const lines = panel.render(100);
		const fullText = lines.join("\n");
		expect(fullText).toContain("内置核心工具 read 由官方托管，请在 settings.json 中调整");
	});

	it("successfully toggles extension tools", () => {
		const toggled: string[] = [];

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeBuiltinTools: new Set(["read"]),
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			getScopeEnabled: () => new Set(),
			onToggle: (id) => toggled.push(id),
		});

		// Move down to web_search (index 2)
		panel.handleInput("j");
		panel.handleInput("j");

		// Hit space
		panel.handleInput(" ");

		expect(toggled).toEqual(["web_search"]);
	});
});
