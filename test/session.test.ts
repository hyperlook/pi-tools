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

	it("strictly respects Pi builtin tools and pure allowlist (read-only sandbox scenario)", () => {
		const initialActive = ["read"];

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["url_context"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Must contain read and url_context ONLY
		expect(Array.from(result).sort()).toEqual(["read", "url_context"]);
		expect(result.has("bash")).toBe(false);
		expect(result.has("edit")).toBe(false);
		expect(result.has("write")).toBe(false);
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("pure allowlist: preserves Pi builtins but activates NO extensions or loader when config file is deleted/absent", () => {
		const initialActive = ["read", "bash", "edit", "write"];

		// No config file exists (user deleted it)
		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		// Builtin tools strictly preserved
		expect(result.has("read")).toBe(true);
		expect(result.has("bash")).toBe(true);
		expect(result.has("edit")).toBe(true);
		expect(result.has("write")).toBe(true);

		// When config is missing/deleted, pure allowlist means ZERO extensions/loader active!
		expect(result.has(LOADER_TOOL_NAME)).toBe(false);
		expect(result.has("web_search")).toBe(false);
		expect(result.has("url_context")).toBe(false);
	});

	it("activates enable_tool when explicitly present in defaultEnabled", () => {
		const initialActive = ["read", "bash", "edit", "write"];

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, [LOADER_TOOL_NAME]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		expect(result.has("read")).toBe(true);
		expect(result.has(LOADER_TOOL_NAME)).toBe(true);
		expect(result.has("web_search")).toBe(false);
	});

	it("does not restore builtin tools if Pi natively disabled all of them", () => {
		const initialActive: string[] = [];

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["web_search"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		expect(Array.from(result)).toEqual(["web_search"]);
	});

	it("prioritizes project config over global config for extension allowlist", () => {
		const initialActive = ["read", "bash"];

		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, [LOADER_TOOL_NAME, "web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, [LOADER_TOOL_NAME, "custom_tool"]);

		const result = newSessionEnabled(initialActive, allMockTools, projectDir, true);

		expect(result.has("read")).toBe(true);
		expect(result.has("bash")).toBe(true);
		expect(result.has(LOADER_TOOL_NAME)).toBe(true);
		expect(result.has("custom_tool")).toBe(true);
		expect(result.has("web_search")).toBe(false);
	});

	it("guarantees getInactiveTools dispatcher pool contains ONLY extensions, NEVER builtins or loader", () => {
		const activeNames = ["read"];

		const inactive = getInactiveTools(allMockTools, activeNames);
		const inactiveNames = inactive.map((t) => t.name);

		expect(inactiveNames).toContain("web_search");
		expect(inactiveNames).toContain("url_context");
		expect(inactiveNames).toContain("custom_tool");

		expect(inactiveNames).not.toContain("bash");
		expect(inactiveNames).not.toContain("edit");
		expect(inactiveNames).not.toContain("write");
		expect(inactiveNames).not.toContain("read");

		expect(inactiveNames).not.toContain(LOADER_TOOL_NAME);
	});
});
