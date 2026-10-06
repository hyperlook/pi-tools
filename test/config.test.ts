import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteProjectConfigFile, getGlobalConfigPath, getProjectConfigPath,
	readConfigFile, readScopeConfig, resolveEffectiveConfig, saveScopeConfig, writeConfigFile } from "../src/config.ts";

describe("exposure override config", () => {
	let dir: string, cwd: string, global: string;
	let originalAgent: string | undefined, originalOverride: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-tools-config-"));
		cwd = join(dir, "project"); mkdirSync(cwd);
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
	it("has no implicit overrides", () => {
		expect(resolveEffectiveConfig(cwd, true).toolExposures).toEqual({});
		expect(resolveEffectiveConfig(cwd, true).scope).toBe("global");
	});
	it("reads all three native exposure values", () => {
		writeConfigFile(global, { old: "deferred", docs: "direct", image: "codemode" });
		expect(resolveEffectiveConfig(cwd, true).toolExposures).toEqual({ old: "deferred", docs: "direct", image: "codemode" });
	});
	it("trusted project replaces the global map, including with an empty map", () => {
		writeConfigFile(global, { docs: "direct" });
		writeConfigFile(getProjectConfigPath(cwd), {});
		expect(resolveEffectiveConfig(cwd, true).scope).toBe("project");
		expect(resolveEffectiveConfig(cwd, true).toolExposures).toEqual({});
	});
	it("never reads untrusted project overrides", () => {
		writeConfigFile(global, { docs: "direct" });
		writeConfigFile(getProjectConfigPath(cwd), { docs: "deferred" });
		expect(resolveEffectiveConfig(cwd, false).toolExposures).toEqual({ docs: "direct" });
	});
	it("uses the environment path exclusively for reads and writes", () => {
		writeConfigFile(global, { docs: "direct" });
		process.env.PI_TOOLS_CONFIG = join(dir, "override.json");
		saveScopeConfig({ scope: "project", cwd, exposures: { docs: "deferred" } });
		expect(resolveEffectiveConfig(cwd, true).isEnvOverridden).toBe(true);
		expect(readScopeConfig("global", cwd)).toEqual({ docs: "deferred" });
		expect(readConfigFile(global)).toEqual({ docs: "direct" });
		expect(existsSync(getProjectConfigPath(cwd))).toBe(false);
	});
	it("rejects invalid exposure values and malformed files", () => {
		writeConfigFile(global, { docs: "direct" });
		writeConfigFile(getProjectConfigPath(cwd), {});
		for (const data of ['{"toolExposures":{"docs":"hidden"}}', '{broken', '{"toolExposures":[]}']) {
			writeFileSync(getProjectConfigPath(cwd), data);
			expect(readScopeConfig("project", cwd)).toBeUndefined();
			expect(resolveEffectiveConfig(cwd, true).scope).toBe("global");
		}
		expect(() => writeConfigFile(global, { docs: "invalid" } as any)).toThrow();
	});
	it("does not migrate any old loading-policy format", () => {
		writeConfigFile(global, {});
		for (const data of ['{"disabledTools":["docs"]}', '{"toolModes":{"docs":"on-demand"}}']) {
			writeFileSync(global, data);
			expect(readConfigFile(global)).toBeUndefined();
			expect(resolveEffectiveConfig(cwd, true).toolExposures).toEqual({});
		}
	});
	it("preserves unavailable tools and sorts saved entries", () => {
		saveScopeConfig({ scope: "global", cwd, exposures: { z: "deferred", a: "direct" } });
		expect(Object.keys(readConfigFile(global)!)).toEqual(["a", "z"]);
	});
	it("resetting project restores global inheritance", () => {
		writeConfigFile(global, { docs: "direct" });
		writeConfigFile(getProjectConfigPath(cwd), { docs: "deferred" });
		deleteProjectConfigFile(cwd); deleteProjectConfigFile(cwd);
		expect(resolveEffectiveConfig(cwd, true).toolExposures).toEqual({ docs: "direct" });
	});
	it("treats prototype keys as tool names", () => {
		writeConfigFile(global, JSON.parse('{"__proto__":"deferred","constructor":"codemode"}'));
		expect(Object.hasOwn(readConfigFile(global)!, "__proto__")).toBe(true);
		expect(readConfigFile(global)!.constructor).toBe("codemode");
	});
});
