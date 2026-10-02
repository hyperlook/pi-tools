import { describe, expect, it } from "bun:test";
import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolsPanel, type ToolsPanelSaveResult } from "../src/tools-panel.ts";

function mockTool(name: string, isBuiltin: boolean, exposure: ToolExposure = "direct"): ToolInfo {
	return {
		name,
		description: `Description of ${name}`,
		parameters: { type: "object", properties: {} },
		exposure,
		sourceInfo: isBuiltin ? { source: "builtin" } : { source: "npm:test" },
	} as ToolInfo;
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
		if (action === "tui.select.confirm" && data === "\r") return true;
		if (action === "tui.select.down" && data === "j") return true;
		if (action === "tui.select.cancel" && data === "q") return true;
		return false;
	},
} as any;

describe("tools panel interactions (Draft & Commit model)", () => {
	const tools: ToolInfo[] = [
		mockTool("read", true),
		mockTool("bash", true),
		mockTool("mcp__docs__read", false, "deferred"),
		mockTool("web_search", false),
		mockTool("url_context", false),
	];

	it("renders active vs inactive state for builtin tools with locked indicator", () => {
		const activeNames = new Set(["read"]);
		const initialGlobalEnabled = new Set(["web_search"]);

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeNames,
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled,
			initialProjectEnabled: undefined, // 继承全局
			onSave: () => {},
		});

		const lines = panel.render(100);
		const fullText = lines.join("\n");

		expect(fullText).toContain("read");
		expect(fullText).toContain("active ⊘");

		expect(fullText).toContain("bash");
		expect(fullText).toContain("inactive ⊘");

		// web_search 继承自全局，应显示 enabled 且带 ⇡ 标识
		expect(fullText).toContain("web_search");
		expect(fullText).toContain("enabled ⇡");
		expect(fullText).toContain("继承全局");
	});

	it("locks upstream-managed exposures and explains who owns them", () => {
		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeNames: new Set(["read", "mcp__docs__read"]),
			initialScope: "global",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: new Set(["web_search", "url_context"]),
			initialProjectEnabled: undefined,
			onSave: () => {},
		});

		expect(panel.render(100).join("\n")).toContain("[upstream]");

		// 光标移到 deferred 工具（index 2），空格应被拒绝并说明上游归属
		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput(" ");
		expect(panel.render(100).join("\n")).toContain("exposure=deferred，由 tool_search / codemode 托管");
	});

	it("locks tools Pi left out of its baseline and refuses to pull them back", () => {
		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeNames: new Set(["read", "bash"]),
			baselineNames: new Set(["read", "bash", "url_context"]),
			initialScope: "global",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: new Set(["web_search", "url_context"]),
			initialProjectEnabled: undefined,
			onSave: () => {},
		});

		// read, bash, deferred, web_search：光标移到不在基线里的 web_search
		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput("j");
		expect(panel.render(100).join("\n")).toContain("Pi 未纳入启动集合");

		panel.handleInput(" ");
		expect(panel.render(100).join("\n")).toContain("web_search 不在 Pi 的启动集合里，本面板不能拉回");
	});

	it("refuses to toggle builtin tool and shows friendly warning notice", () => {
		const activeNames = new Set(["read", "bash"]);
		let saved: ToolsPanelSaveResult | undefined;

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {},
			tools,
			activeNames,
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: new Set(),
			initialProjectEnabled: undefined,
			onSave: (res) => {
				saved = res;
			},
		});

		// Cursor is at index 0 ("read", builtin tool)
		panel.handleInput(" ");

		// No save triggered, warning rendered
		expect(saved).toBeUndefined();
		const lines = panel.render(100);
		const fullText = lines.join("\n");
		expect(fullText).toContain("内置核心工具 read 由 defaultTools 托管，请在 settings.json 中调整");
	});

	it("forks project config from global baseline on edit and saves on Enter", () => {
		let saved: ToolsPanelSaveResult | undefined;
		let closed = false;

		// 全局开启了 web_search 和 url_context
		const initialGlobal = new Set(["web_search", "url_context"]);

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {
				closed = true;
			},
			tools,
			activeNames: new Set(["read"]),
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: initialGlobal,
			initialProjectEnabled: undefined, // 初始继承全局
			onSave: (res) => {
				saved = res;
			},
		});

		// 光标移到 web_search (index 3)
		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput("j");

		// 按空格关闭 web_search
		panel.handleInput(" ");

		// 此时尚未落盘，未调用 onSave
		expect(saved).toBeUndefined();
		expect(closed).toBe(false);

		// 查看渲染：已经派生，不再显示 (继承)，且 web_search 变为 disabled
		const textBeforeSave = panel.render(100).join("\n");
		expect(textBeforeSave).toContain("已定制");
		expect(textBeforeSave).toContain("未保存 *");

		// 按回车确认保存
		panel.handleInput("\r");

		expect(closed).toBe(true);
		expect(saved).toBeDefined();
		// 项目独立配置应该被派生生成：包含了保留的 url_context，排除了关掉的 web_search
		expect(Array.from(saved!.projectEnabled ?? [])).toEqual(["url_context"]);
		// 全局配置原封不动
		expect(Array.from(saved!.globalEnabled).sort()).toEqual(["url_context", "web_search"]);
	});

	it("discards draft edits and does not call onSave when canceled with Esc/q", () => {
		let saved: ToolsPanelSaveResult | undefined;
		let closed = false;

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {
				closed = true;
			},
			tools,
			activeNames: new Set(["read"]),
			initialScope: "global",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: new Set(["web_search"]),
			initialProjectEnabled: undefined,
			onSave: (res) => {
				saved = res;
			},
		});

		// 光标移到 web_search (index 3)
		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput("j");

		// 按空格关闭 web_search
		panel.handleInput(" ");

		// 按 q / Esc 取消退出
		panel.handleInput("q");

		expect(closed).toBe(true);
		expect(saved).toBeUndefined();
	});

	it("allows resetting project config to inherit global using r key", () => {
		let saved: ToolsPanelSaveResult | undefined;
		let closed = false;

		const panel = createToolsPanel({
			tui: mockTui,
			theme: mockTheme,
			kb: mockKb,
			done: () => {
				closed = true;
			},
			tools,
			activeNames: new Set(["read"]),
			initialScope: "project",
			canUseProjectScope: true,
			projectDisplayPath: ".pi/pi-tools.json",
			globalDisplayPath: "~/.pi/agent/pi-tools.json",
			initialGlobalEnabled: new Set(["web_search"]),
			initialProjectEnabled: new Set(["url_context"]), // 已有独立定制
			onSave: (res) => {
				saved = res;
			},
		});

		// 处于定制态
		expect(panel.render(100).join("\n")).toContain("已定制");

		// 按 r 恢复继承全局
		panel.handleInput("r");

		// 检查渲染状态变为继承全局
		const textAfterReset = panel.render(100).join("\n");
		expect(textAfterReset).toContain("继承全局");
		expect(textAfterReset).toContain("已重置项目配置，恢复继承全局");

		// 回车保存
		panel.handleInput("\r");

		expect(closed).toBe(true);
		expect(saved).toBeDefined();
		// projectEnabled 应该为 undefined，表示恢复继承全局（将删除 .pi/pi-tools.json）
		expect(saved!.projectEnabled).toBeUndefined();
	});
});
