import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectConfigPath, readConfigFile, writeConfigFile } from "../src/config.ts";
import { absorbBaseline, applyPolicy, getInactiveTools } from "../src/index.ts";
import { LOADER_TOOL_NAME } from "../src/shared.ts";

function mockTool(
	name: string,
	source: "builtin" | "extension",
	exposure: ToolExposure = "direct",
): ToolInfo {
	return {
		name,
		description: `Description of ${name}`,
		parameters: { type: "object", properties: {} },
		exposure,
		sourceInfo: source === "builtin" ? { source: "builtin" } : { source: "npm:some-ext" },
	} as ToolInfo;
}

function disabledIn(cwd: string): Set<string> {
	return new Set(readConfigFile(getProjectConfigPath(cwd)) ?? []);
}

describe("policy: baseline subtraction & upstream ownership", () => {
	let testDir: string;
	let projectDir: string;
	let globalDir: string;
	let origAgentDir: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(testDir, "project");
		globalDir = join(testDir, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(globalDir, { recursive: true });

		origAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = globalDir;
		delete process.env.PI_TOOLS_CONFIG;
	});

	afterEach(() => {
		if (origAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = origAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	const allMockTools: ToolInfo[] = [
		mockTool("read", "builtin"),
		mockTool("bash", "builtin"),
		mockTool("edit", "builtin"),
		mockTool("write", "builtin"),
		mockTool(LOADER_TOOL_NAME, "builtin"),
		mockTool("web_search", "extension"),
		mockTool("url_context", "extension"),
		mockTool("custom_tool", "extension"),
		mockTool("mcp__docs__read", "extension", "deferred"),
		mockTool("mcp__docs__write", "extension", "codemode"),
		mockTool("secret_tool", "extension", "hidden"),
	];

	const piBaseline = [
		"read",
		"bash",
		"edit",
		"write",
		"web_search",
		"url_context",
		"custom_tool",
		"mcp__docs__read",
		"mcp__docs__write",
		"secret_tool",
	];

	it("keeps Pi's own baseline untouched when nothing is disabled", () => {
		const result = applyPolicy(piBaseline, allMockTools, disabledIn(projectDir), []);

		for (const name of piBaseline) expect(result.has(name)).toBe(true);
		// 没有待命的 direct 扩展工具，调度器不占 token
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("only subtracts disabled direct extension tools, and adds the loader back for them", () => {
		writeConfigFile(getProjectConfigPath(projectDir), ["url_context"]);

		const result = applyPolicy(piBaseline, allMockTools, disabledIn(projectDir), []);

		expect(result.has("url_context")).toBe(false);
		expect(result.has("web_search")).toBe(true);
		expect(result.has("custom_tool")).toBe(true);
		expect(result.has(LOADER_TOOL_NAME)).toBe(true);
	});

	it("never re-adds tools Pi itself turned off (defaultTools / --tools / --exclude-tools)", () => {
		writeConfigFile(getProjectConfigPath(projectDir), ["web_search"]);

		// 用户在 defaultTools 里砍掉了 bash 和 web_search：Pi 的基线里就没有它们
		const baseline = ["read", "edit", "write", "url_context", "custom_tool"];
		const result = applyPolicy(baseline, allMockTools, disabledIn(projectDir), []);

		expect(result.has("bash")).toBe(false);
		expect(result.has("web_search")).toBe(false);
		expect(result.has("read")).toBe(true);
	});

	it("leaves upstream-managed exposures completely alone", () => {
		// 即便它们出现在 disabledTools 里也不收编：不是我们的池子
		writeConfigFile(getProjectConfigPath(projectDir), [
			"mcp__docs__read",
			"mcp__docs__write",
			"secret_tool",
		]);

		const result = applyPolicy(piBaseline, allMockTools, disabledIn(projectDir), []);

		expect(result.has("mcp__docs__read")).toBe(true);
		expect(result.has("mcp__docs__write")).toBe(true);
		expect(result.has("secret_tool")).toBe(true);
		// 上游工具不撑起调度器：没有待命的 direct 扩展工具
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("re-enables a subtracted tool against the frozen baseline, not the already-reduced active set", () => {
		const frozen = ["read", "bash", "edit", "write", "web_search", "url_context"];
		writeConfigFile(getProjectConfigPath(projectDir), ["url_context"]);

		const subtracted = applyPolicy(frozen, allMockTools, disabledIn(projectDir), []);
		expect(subtracted.has("url_context")).toBe(false);
		// custom_tool 从未进过 Pi 的启动集合，减法结果里也不该出现
		expect(subtracted.has("custom_tool")).toBe(false);

		writeConfigFile(getProjectConfigPath(projectDir), []);
		const restored = applyPolicy(frozen, allMockTools, disabledIn(projectDir), []);
		expect(restored.has("url_context")).toBe(true);
		expect(restored.has("custom_tool")).toBe(false);
		expect(restored.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("does not let a session delta revive a tool Pi never put in the baseline", () => {
		const frozen = ["read", "bash", "web_search"];
		const result = applyPolicy(frozen, allMockTools, new Set(["web_search"]), ["web_search", "custom_tool"]);

		expect(result.has("web_search")).toBe(true);
		expect(result.has("custom_tool")).toBe(false);
	});

	it("keeps subtracted names in the frozen baseline and absorbs only tools Pi activates later", () => {
		const frozen = absorbBaseline(undefined, ["read", "web_search", "url_context"], undefined);
		const written = new Set(["read", "web_search", LOADER_TOOL_NAME]);
		const next = absorbBaseline(frozen, ["read", "web_search", LOADER_TOOL_NAME, "late_direct"], written);

		expect(next.has("url_context")).toBe(true);
		expect(next.has("late_direct")).toBe(true);
		expect(next.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("reload unions the saved baseline with whatever Pi currently has active", () => {
		const reloaded = absorbBaseline(
			["read", "web_search", "url_context"],
			["read", "web_search", "late_direct"],
			undefined,
		);

		expect(reloaded.has("url_context")).toBe(true);
		expect(reloaded.has("late_direct")).toBe(true);
	});

	it("re-applies the branch session delta on top of the subtraction", () => {
		writeConfigFile(getProjectConfigPath(projectDir), ["url_context"]);

		const result = applyPolicy(piBaseline, allMockTools, disabledIn(projectDir), ["url_context"]);

		expect(result.has("url_context")).toBe(true);
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("respects the user disabling enable_tool itself", () => {
		writeConfigFile(getProjectConfigPath(projectDir), ["url_context", LOADER_TOOL_NAME]);

		const result = applyPolicy(piBaseline, allMockTools, disabledIn(projectDir), []);

		expect(result.has("url_context")).toBe(false);
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("getInactiveTools pool contains ONLY activatable extensions, never builtins, loader or upstream tools", () => {
		const activeNames = ["read", "bash", "edit", "write", LOADER_TOOL_NAME, "web_search"];
		const inactive = getInactiveTools(allMockTools, activeNames);

		// 上游 exposure（deferred / codemode / hidden）不归本扩展待命池
		expect(inactive.map((t) => t.name).sort()).toEqual(["custom_tool", "url_context"]);
	});

	it("getInactiveTools ignores on-demand tools Pi never included", () => {
		const inactive = getInactiveTools(allMockTools, ["read", "web_search"], ["read", "web_search", "url_context"]);
		expect(inactive.map((tool) => tool.name)).toEqual(["url_context"]);
	});
});
