import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatDisplayPath,
	getProjectConfigPath,
	hasProjectConfig,
	persistToolPreference,
	readConfigFile,
	resolveEffectiveConfig,
	writeConfigFile,
} from "../src/config.ts";

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

	it("persists tool preference to project scope deriving from global if new", () => {
		const globalPath = join(globalDir, "pi-tools.json");
		writeConfigFile(globalPath, ["tool_a", "tool_b"]);

		const known = new Set(["tool_a", "tool_b", "tool_c"]);

		// Project config does not exist yet. Toggling tool_c on in project scope:
		persistToolPreference({
			toolName: "tool_c",
			enabled: true,
			targetScope: "project",
			cwd: projectDir,
			knownTools: known,
		});

		const projPath = getProjectConfigPath(projectDir);
		expect(existsSync(projPath)).toBe(true);
		expect(readConfigFile(projPath)).toEqual(["tool_a", "tool_b", "tool_c"]);

		// Global config should remain untouched
		expect(readConfigFile(globalPath)).toEqual(["tool_a", "tool_b"]);
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
});
