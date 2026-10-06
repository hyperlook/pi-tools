import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseExposures, type ToolExposures } from "./shared.ts";

export const PREFS_FILE = "pi-tools.json";
export type ConfigScope = "project" | "global";
export interface ConfigResolution {
	scope: ConfigScope;
	path: string;
	toolExposures: ToolExposures;
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
/** Only exposure overrides are read; old loading-policy formats are not migrated. */
export function readConfigFile(filePath: string): ToolExposures | undefined {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" ? parseExposures(parsed.toolExposures) : undefined;
	} catch {
		return undefined;
	}
}
export function writeConfigFile(filePath: string, exposures: ToolExposures): void {
	const normalized = parseExposures(exposures);
	if (!normalized) throw new Error("Invalid tool exposure overrides");
	mkdirSync(dirname(filePath), { recursive: true });
	const sorted = Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(filePath, `${JSON.stringify({ toolExposures: sorted }, null, 2)}\n`, "utf8");
}
export function readScopeConfig(scope: ConfigScope, cwd: string): ToolExposures | undefined {
	return readConfigFile(process.env.PI_TOOLS_CONFIG ||
		(scope === "project" ? getProjectConfigPath(cwd) : getGlobalConfigPath()));
}
/** Layers resolve per tool: author default → global → trusted project. Project holds sparse overrides only. */
export function resolveEffectiveConfig(cwd: string, trusted: boolean): ConfigResolution {
	if (process.env.PI_TOOLS_CONFIG) {
		return { scope: "global", path: process.env.PI_TOOLS_CONFIG,
			toolExposures: readConfigFile(process.env.PI_TOOLS_CONFIG) ?? {}, isEnvOverridden: true };
	}
	const projectPath = getProjectConfigPath(cwd);
	const project = trusted ? readConfigFile(projectPath) : undefined;
	const path = getGlobalConfigPath();
	const global = readConfigFile(path) ?? {};
	if (project !== undefined) {
		return { scope: "project", path: projectPath, toolExposures: { ...global, ...project }, isEnvOverridden: false };
	}
	return { scope: "global", path, toolExposures: global, isEnvOverridden: false };
}
export function deleteProjectConfigFile(cwd: string): void {
	rmSync(getProjectConfigPath(cwd), { force: true });
}
/** Unavailable-tool entries are intentionally preserved. */
export function saveScopeConfig(options: { scope: ConfigScope; cwd: string; exposures: ToolExposures }): void {
	const path = process.env.PI_TOOLS_CONFIG ||
		(options.scope === "project" ? getProjectConfigPath(options.cwd) : getGlobalConfigPath());
	writeConfigFile(path, options.exposures);
}
