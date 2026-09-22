import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatDisplayPath,
	getGlobalConfigPath,
	getProjectConfigPath,
	hasProjectConfig,
	persistToolPreference,
	readConfigFile,
	readScopeConfig,
	resolveEffectiveConfig,
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
		expect(res.tools).toEqual(["web_search", "mcp"]);
		expect(res.hasProjectConfig).toBe(false);
	});

	it("overrides global config when trusted project config exists", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search", "mcp"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["custom_tool"]);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("project");
		expect(res.tools).toEqual(["custom_tool"]);
		expect(res.hasProjectConfig).toBe(true);
	});

	it("ignores project config when project is not trusted", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["malicious_tool"]);

		const res = resolveEffectiveConfig(projectDir, false);
		expect(res.scope).toBe("global");
		expect(res.tools).toEqual(["web_search"]);
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
		expect(res.tools).toEqual(["env_tool"]);
		expect(res.isEnvOverridden).toBe(true);
	});

	it("creates pure allowlist without injecting surprise tools when no config exists", () => {
		const known = new Set([LOADER_TOOL_NAME, "web_search"]);

		// Neither project nor global config exists
		persistToolPreference({
			toolName: "web_search",
			enabled: true,
			targetScope: "project",
			cwd: projectDir,
			knownTools: known,
		});

		const projPath = getProjectConfigPath(projectDir);
		expect(existsSync(projPath)).toBe(true);
		// Must only contain web_search, never magically auto-enable enable_tool
		expect(readConfigFile(projPath)).toEqual(["web_search"]);
	});

	it("allows project to explicitly disable all extension tools with empty array", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search", "mcp"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, []);

		const res = resolveEffectiveConfig(projectDir, true);
		expect(res.scope).toBe("project");
		expect(res.tools).toEqual([]);
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
		expect(res.tools).toEqual(["web_search"]);
	});

	it("modifies existing project config without touching global", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["web_search"]);

		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["custom_tool_1"]);

		const known = new Set(["custom_tool_1", "custom_tool_2"]);

		persistToolPreference({
			toolName: "custom_tool_2",
			enabled: true,
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

	it("allows disabling enable_tool in defaultEnabled", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, [LOADER_TOOL_NAME, "web_search"]);

		const known = new Set([LOADER_TOOL_NAME, "web_search"]);

		persistToolPreference({
			toolName: LOADER_TOOL_NAME,
			enabled: false,
			targetScope: "global",
			cwd: projectDir,
			knownTools: known,
		});

		expect(readConfigFile(globalPath)).toEqual(["web_search"]);
	});

	it("reads scope config accurately using readScopeConfig", () => {
		const projPath = getProjectConfigPath(projectDir);
		writeConfigFile(projPath, ["project_tool"]);

		expect(readScopeConfig("project", projectDir)).toEqual(["project_tool"]);
		expect(readScopeConfig("global", projectDir)).toBeUndefined();
	});
});
