import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteProjectConfigFile,
	formatDisplayPath,
	getGlobalConfigPath,
	getProjectConfigPath,
	hasProjectConfig,
	persistToolPreference,
	readConfigFile,
	readScopeConfig,
	resolveEffectiveConfig,
	saveScopeConfig,
	writeConfigFile,
} from "../src/config.ts";
import { LOADER_TOOL_NAME } from "../src/shared.ts";

describe("config tests", () => {
	let testDir: string;
	let projectDir: string;
	let globalDir: string;
	let origAgentDir: string | undefined;
	let origToolsConfig: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(testDir, "project");
		globalDir = join(testDir, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(globalDir, { recursive: true });

		origAgentDir = process.env.PI_CODING_AGENT_DIR;
		origToolsConfig = process.env.PI_TOOLS_CONFIG;

		process.env.PI_CODING_AGENT_DIR = globalDir;
		delete process.env.PI_TOOLS_CONFIG;
	});

	afterEach(() => {
		if (origAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = origAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}

		if (origToolsConfig !== undefined) {
			process.env.PI_TOOLS_CONFIG = origToolsConfig;
		} else {
			delete process.env.PI_TOOLS_CONFIG;
		}

		rmSync(testDir, { recursive: true, force: true });
	});

	it("resolves global config when no project config exists", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search", "mcp"]);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("global");
		expect(res.disabledTools).toEqual(["web_search", "mcp"]);
		expect(res.hasProjectConfig).toBe(false);
	});

	it("overrides global config when trusted project config exists", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search", "mcp"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["custom_tool"]);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("project");
		expect(res.disabledTools).toEqual(["custom_tool"]);
		expect(res.hasProjectConfig).toBe(true);
	});

	it("ignores project config when project is not trusted", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["malicious_tool"]);

		const res = resolveEffectiveConfig(projectDir, false);
		expect(res.scope).toBe("global");
		expect(res.disabledTools).toEqual(["web_search"]);
	});

	it("prioritizes PI_TOOLS_CONFIG env var over project and global", () => {
		const envConfigFile = join(testDir, "custom-env.json");
		writeConfigFile(envConfigFile, ["env_tool"]);
		process.env.PI_TOOLS_CONFIG = envConfigFile;

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["proj_tool"]);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("global");
		expect(res.path).toBe(envConfigFile);
		expect(res.disabledTools).toEqual(["env_tool"]);
		expect(res.isEnvOverridden).toBe(true);
	});

	it("adds tool to disabledTools when disabled via persistToolPreference", () => {
		const known = new Set([LOADER_TOOL_NAME, "web_search"]);

		// Disabling web_search when no prior config existed
		persistToolPreference({
			toolName: "web_search",
			enabled: false,
			targetScope: "project",
			cwd: projectDir,
			knownTools: known,
		});

		const projPath = getProjectConfigPath(projectDir);
		expect(existsSync(projPath)).toBe(true);
		// Must record web_search in disabledTools
		expect(readConfigFile(projPath)).toEqual(["web_search"]);

		// Re-enabling web_search removes it from disabledTools
		persistToolPreference({
			toolName: "web_search",
			enabled: true,
			targetScope: "project",
			cwd: projectDir,
			knownTools: known,
		});
		expect(readConfigFile(projPath)).toEqual([]);
	});

	it("allows project to explicitly have empty disabledTools array", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search", "mcp"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, []);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("project");
		expect(res.disabledTools).toEqual([]);
		expect(res.hasProjectConfig).toBe(true);
	});

	it("gracefully falls back to global if project config is invalid json", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(projPath, "invalid-json-content{");

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("global");
		expect(res.disabledTools).toEqual(["web_search"]);
	});

	it("modifies existing project config without touching global", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["custom_tool_1"]);

		const known = new Set(["custom_tool_1", "custom_tool_2"]);

		// Disable custom_tool_2 on project
		persistToolPreference({
			toolName: "custom_tool_2",
			enabled: false,
			targetScope: "project",
			cwd: projectDir,
			knownTools: known,
		});

		expect(readConfigFile(projPath)).toEqual(["custom_tool_1", "custom_tool_2"]);
		expect(readConfigFile(globalPath)).toEqual(["web_search"]);
	});

	it("refuses to persist builtin tools that are not in knownTools", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, [LOADER_TOOL_NAME]);

		const known = new Set([LOADER_TOOL_NAME, "web_search"]);

		persistToolPreference({
			toolName: "bash",
			enabled: false,
			targetScope: "global",
			cwd: projectDir,
			knownTools: known,
		});

		expect(readConfigFile(globalPath)).toEqual([LOADER_TOOL_NAME]);
	});

	it("allows disabling enable_tool in disabledTools", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const known = new Set([LOADER_TOOL_NAME, "web_search"]);

		persistToolPreference({
			toolName: LOADER_TOOL_NAME,
			enabled: false,
			targetScope: "global",
			cwd: projectDir,
			knownTools: known,
		});

		expect(readConfigFile(globalPath)?.sort()).toEqual(["enable_tool", "web_search"]);
	});

	it("reads scope config accurately using readScopeConfig", () => {
		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["project_tool"]);

		expect(readScopeConfig("project", projectDir)).toEqual(["project_tool"]);
		expect(readScopeConfig("global", projectDir)).toBeUndefined();
	});

	it("deletes project config file when requested and returns status", () => {
		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["custom_tool"]);
		expect(existsSync(projPath)).toBe(true);

		const deleted = deleteProjectConfigFile(projectDir);
		expect(deleted).toBe(true);
		expect(existsSync(projPath)).toBe(false);

		// Deleting again returns false
		expect(deleteProjectConfigFile(projectDir)).toBe(false);
	});

	it("saves scope config with knownTools filtering applied", () => {
		const known = new Set(["tool_a", "tool_b"]);
		saveScopeConfig({
			scope: "project",
			cwd: projectDir,
			disabledNames: ["tool_a", "unknown_tool", "tool_b"],
			knownTools: known,
		});

		const projPath = getProjectConfigPath(projectDir);
		expect(readConfigFile(projPath)).toEqual(["tool_a", "tool_b"]);
	});
});
