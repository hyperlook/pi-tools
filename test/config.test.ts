import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFingerprint, deleteProjectConfigFile, getGlobalConfigPath, getProjectConfigPath,
	readConfigFile, readScopeConfig, resolveEffectiveConfig, saveScopeConfig, writeConfigFile } from "../src/config.ts";

describe("native preference config", () => {
	let dir: string, cwd: string, global: string;
	let originalAgent: string | undefined, originalOverride: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-tools-config-"));
		cwd = join(dir, "project");
		mkdirSync(cwd);
		originalAgent = process.env.PI_CODING_AGENT_DIR;
		originalOverride = process.env.PI_TOOLS_CONFIG;
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		delete process.env.PI_TOOLS_CONFIG;
		global = getGlobalConfigPath();
	});
	afterEach(() => {
		if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgent;
		if (originalOverride === undefined) delete process.env.PI_TOOLS_CONFIG;
		else process.env.PI_TOOLS_CONFIG = originalOverride;
		rmSync(dir, { recursive: true, force: true });
	});
	it("defaults to following extensions without config", () => {
		expect(resolveEffectiveConfig(cwd, true).toolModes).toEqual({});
		expect(resolveEffectiveConfig(cwd, true).scope).toBe("global");
	});
	it("reads global preferences", () => {
		writeConfigFile(global, { docs: "on-demand" });
		expect(resolveEffectiveConfig(cwd, true).toolModes).toEqual({ docs: "on-demand" });
	});
	it("trusted project replaces the global map, including with an empty map", () => {
		writeConfigFile(global, { docs: "always" });
		writeConfigFile(getProjectConfigPath(cwd), {});
		expect(resolveEffectiveConfig(cwd, true).scope).toBe("project");
		expect(resolveEffectiveConfig(cwd, true).toolModes).toEqual({});
	});
	it("does not read untrusted project preferences", () => {
		writeConfigFile(global, { docs: "always" });
		writeConfigFile(getProjectConfigPath(cwd), { docs: "on-demand" });
		expect(resolveEffectiveConfig(cwd, false).toolModes).toEqual({ docs: "always" });
	});
	it("uses the environment path exclusively for reads and writes", () => {
		process.env.PI_TOOLS_CONFIG = join(dir, "override.json");
		writeConfigFile(global, { docs: "always" });
		saveScopeConfig({ scope: "project", cwd, modes: { docs: "on-demand" } });
		expect(resolveEffectiveConfig(cwd, true).isEnvOverridden).toBe(true);
		expect(readScopeConfig("global", cwd)).toEqual({ docs: "on-demand" });
		expect(readConfigFile(global)).toEqual({ docs: "always" });
		expect(existsSync(getProjectConfigPath(cwd))).toBe(false);
	});
	it("falls back to global for malformed project config", () => {
		writeConfigFile(global, { docs: "always" });
		writeConfigFile(getProjectConfigPath(cwd), {});
		writeFileSync(getProjectConfigPath(cwd), '{"toolModes":{"docs":"disabled"}}');
		expect(resolveEffectiveConfig(cwd, true).scope).toBe("global");
		writeFileSync(getProjectConfigPath(cwd), '{broken');
		expect(readScopeConfig("project", cwd)).toBeUndefined();
	});
	it("does not migrate legacy disabledTools files", () => {
		writeConfigFile(global, {});
		writeFileSync(global, '{"disabledTools":["docs","enable_tool"]}');
		expect(readConfigFile(global)).toBeUndefined();
		expect(resolveEffectiveConfig(cwd, true).toolModes).toEqual({});
	});
	it("normalizes explicit inherit entries and ignores map ordering in fingerprints", () => {
		writeConfigFile(global, {});
		writeFileSync(global, '{"toolModes":{"z":"always","a":"on-demand","docs":"inherit"}}');
		const first = configFingerprint(cwd, true);
		expect(readConfigFile(global)).toEqual({ z: "always", a: "on-demand" });
		writeConfigFile(global, { a: "on-demand", z: "always" });
		expect(configFingerprint(cwd, true)).toBe(first);
		writeConfigFile(global, { a: "always", z: "always" });
		expect(configFingerprint(cwd, true)).not.toBe(first);
	});
	it("preserves preferences for temporarily unavailable tools", () => {
		saveScopeConfig({ scope: "global", cwd, modes: { disconnected_mcp: "on-demand", docs: "always" } });
		expect(readConfigFile(global)).toEqual({ disconnected_mcp: "on-demand", docs: "always" });
	});
	it("resetting project restores global inheritance", () => {
		writeConfigFile(global, { docs: "always" });
		writeConfigFile(getProjectConfigPath(cwd), { docs: "on-demand" });
		expect(deleteProjectConfigFile(cwd)).toBe(true);
		expect(deleteProjectConfigFile(cwd)).toBe(false);
		expect(resolveEffectiveConfig(cwd, true).toolModes).toEqual({ docs: "always" });
	});
	it("validates maps and supports arbitrary tool names safely", () => {
		writeConfigFile(global, JSON.parse('{"__proto__":"on-demand"}'));
		expect(Object.hasOwn(readConfigFile(global)!, "__proto__")).toBe(true);
		writeFileSync(global, '{"toolModes":[]}');
		expect(readConfigFile(global)).toBeUndefined();
		expect(() => writeConfigFile(global, { docs: "invalid" } as any)).toThrow();
	});
});
