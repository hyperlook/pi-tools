import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseModes, type ToolModes } from "./shared.ts";

export const PREFS_FILE = "pi-tools.json";
export type ConfigScope = "project" | "global";
export interface ConfigResolution {
	scope: ConfigScope;
	path: string;
	toolModes: ToolModes;
	hasProjectConfig: boolean;
	isEnvOverridden: boolean;
}
export function formatDisplayPath(filePath: string): string {
	const home = homedir();
	return filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
}
export function getGlobalConfigPath(): string {
	return process.env.PI_TOOLS_CONFIG || join(getAgentDir(), PREFS_FILE);
}
export function getProjectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, PREFS_FILE);
}
export function hasProjectConfig(cwd: string): boolean {
	return existsSync(getProjectConfigPath(cwd));
}
/** Only the native loading-preference format is supported; no legacy disabledTools migration. */
export function readConfigFile(filePath: string): ToolModes | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" ? parseModes(parsed.toolModes) : undefined;
	} catch {
		return undefined;
	}
}
export function writeConfigFile(filePath: string, modes: ToolModes): void {
	const normalized = parseModes(modes);
	if (!normalized) throw new Error("Invalid tool loading preferences");
	mkdirSync(dirname(filePath), { recursive: true });
	const sorted = Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(filePath, `${JSON.stringify({ toolModes: sorted }, null, 2)}\n`, "utf8");
}
export function readScopeConfig(scope: ConfigScope, cwd: string): ToolModes | undefined {
	return readConfigFile(process.env.PI_TOOLS_CONFIG ||
		(scope === "project" ? getProjectConfigPath(cwd) : getGlobalConfigPath()));
}
/** Project config replaces global config; an empty map explicitly follows the extensions. */
export function resolveEffectiveConfig(cwd: string, isProjectTrusted: boolean): ConfigResolution {
	if (process.env.PI_TOOLS_CONFIG) {
		return {
			scope: "global", path: process.env.PI_TOOLS_CONFIG,
			toolModes: readConfigFile(process.env.PI_TOOLS_CONFIG) ?? {},
			hasProjectConfig: false, isEnvOverridden: true,
		};
	}
	const projectPath = getProjectConfigPath(cwd);
	const projectModes = isProjectTrusted ? readConfigFile(projectPath) : undefined;
	if (projectModes !== undefined) {
		return { scope: "project", path: projectPath, toolModes: projectModes,
			hasProjectConfig: true, isEnvOverridden: false };
	}
	const globalPath = getGlobalConfigPath();
	return { scope: "global", path: globalPath, toolModes: readConfigFile(globalPath) ?? {},
		hasProjectConfig: hasProjectConfig(cwd), isEnvOverridden: false };
}
export function configFingerprint(cwd: string, isProjectTrusted: boolean): string {
	const config = resolveEffectiveConfig(cwd, isProjectTrusted);
	return JSON.stringify([config.path,
		Object.entries(config.toolModes).sort(([a], [b]) => a.localeCompare(b))]);
}
export function deleteProjectConfigFile(cwd: string): boolean {
	const path = getProjectConfigPath(cwd);
	if (!existsSync(path)) return false;
	rmSync(path);
	return true;
}
/** Preserve preferences for tools that are temporarily unavailable (e.g. disconnected MCP). */
export function saveScopeConfig(options: { scope: ConfigScope; cwd: string; modes: ToolModes }): void {
	const path = process.env.PI_TOOLS_CONFIG ||
		(options.scope === "project" ? getProjectConfigPath(options.cwd) : getGlobalConfigPath());
	writeConfigFile(path, options.modes);
}
