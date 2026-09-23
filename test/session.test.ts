import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectConfigPath, writeConfigFile } from "../src/config.ts";
import { getInactiveTools, newSessionEnabled } from "../src/index.ts";
import { LOADER_TOOL_NAME } from "../src/shared.ts";

function mockTool(name: string, source: "builtin" | "extension"): ToolInfo {
	return {
		name,
		description: `Description of ${name}`,
		parameters: { type: "object", properties: {} },
		sourceInfo: source === "builtin" ? { source: "builtin" } : { source: "npm:some-ext" },
		execute: async () => ({ content: [] }),
	};
}

describe("session enabled & sandbox tests", () => {
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
	];

	it("strictly respects Pi builtin tools and excludes disabled extension tools", () => {
		const initialActive = ["read", "bash", "edit", "write"];

		// Explicitly disable url_context
		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["url_context"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Builtin tools strictly preserved
		expect(result.has("read")).toBe(true);
		expect(result.has("bash")).toBe(true);
		expect(result.has("edit")).toBe(true);
		expect(result.has("write")).toBe(true);

		// url_context is disabled
		expect(result.has("url_context")).toBe(false);
		// Other extensions remain active
		expect(result.has("web_search")).toBe(true);
		expect(result.has("custom_tool")).toBe(true);
		// Since url_context is inactive, enable_tool is automatically enabled for on-demand dispatch
		expect(result.has(LOADER_TOOL_NAME)).toBe(true);
	});

	it("zero disruption: activates ALL extensions by default when no config file exists (new user experience)", () => {
		const initialActive = ["read", "bash", "edit", "write"];

		// No config file exists (fresh install)
		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Builtins active
		expect(result.has("read")).toBe(true);
		expect(result.has("bash")).toBe(true);
		expect(result.has("edit")).toBe(true);
		expect(result.has("write")).toBe(true);

		// All user extensions active! No tools broken for fresh users!
		expect(result.has("web_search")).toBe(true);
		expect(result.has("url_context")).toBe(true);
		expect(result.has("custom_tool")).toBe(true);

		// Because all extensions are already active, enable_tool does not need to consume prompt tokens
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("respects user decision to disable enable_tool itself", () => {
		const initialActive = ["read", "bash", "edit", "write"];

		// User disables url_context AND enable_tool
		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["url_context", LOADER_TOOL_NAME]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		expect(result.has("read")).toBe(true);
		expect(result.has("url_context")).toBe(false);
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("does not restore builtin tools if Pi natively disabled all of them", () => {
		const initialActive: string[] = [];

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["web_search"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Native builtins were empty, must remain empty
		expect(result.has("read")).toBe(false);
		expect(result.has("bash")).toBe(false);

		// web_search was disabled, other extensions enabled
		expect(result.has("web_search")).toBe(false);
		expect(result.has("url_context")).toBe(true);
		expect(result.has("custom_tool")).toBe(true);
	});

	it("prioritizes project config over global config for extension disabled list", () => {
		const initialActive = ["read", "bash"];

		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["url_context"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Project config disables url_context, not web_search
		expect(result.has("web_search")).toBe(true);
		expect(result.has("url_context")).toBe(false);
	});

	it("guarantees getInactiveTools dispatcher pool contains ONLY extensions, NEVER builtins or loader", () => {
		const activeNames = ["read", "bash", "edit", "write", LOADER_TOOL_NAME, "web_search"];
		const inactive = getInactiveTools(allMockTools, activeNames);

		// Should only contain url_context and custom_tool
		expect(inactive.map((t) => t.name).sort()).toEqual(["custom_tool", "url_context"]);
		expect(inactive.some((t) => t.name === "read")).toBe(false);
		expect(inactive.some((t) => t.name === "bash")).toBe(false);
		expect(inactive.some((t) => t.name === LOADER_TOOL_NAME)).toBe(false);
	});
});
