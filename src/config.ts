import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFS_FILE = "pi-tools.json";

export type ConfigScope = "project" | "global";

export interface ConfigResolution {
	scope: ConfigScope;
	path: string;
	disabledTools: string[] | undefined;
	hasProjectConfig: boolean;
	isEnvOverridden: boolean;
}

export function formatDisplayPath(filePath: string): string {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
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

export function readConfigFile(filePath: string): string[] | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			disabledTools?: unknown;
			defaultEnabled?: unknown;
		};
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}
		if (Array.isArray(parsed.disabledTools)) {
			return parsed.disabledTools.filter(
				(name): name is string => typeof name === "string" && name.trim() !== "",
			);
		}
		return [];
	} catch {
		return undefined;
	}
}

export function writeConfigFile(filePath: string, disabledNames: string[]): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(
		filePath,
		`${JSON.stringify({ disabledTools: disabledNames }, null, 2)}\n`,
		"utf8",
	);
}

export function readScopeConfig(scope: ConfigScope, cwd: string): string[] | undefined {
	if (process.env.PI_TOOLS_CONFIG) {
		return readConfigFile(process.env.PI_TOOLS_CONFIG);
	}
	const targetPath = scope === "project" ? getProjectConfigPath(cwd) : getGlobalConfigPath();
	return readConfigFile(targetPath);
}

/**
 * 解析当前生效的配置：
 * 1. 若设置了 PI_TOOLS_CONFIG，使用环境变量路径（视为 global/override）
 * 2. 若项目受信任且存在 .pi/pi-tools.json，使用项目级配置（Project overrides Global）
 * 3. 否则回退使用全局 ~/.pi/agent/pi-tools.json
 */
export function resolveEffectiveConfig(cwd: string, isProjectTrusted: boolean): ConfigResolution {
	if (process.env.PI_TOOLS_CONFIG) {
		const envPath = process.env.PI_TOOLS_CONFIG;
		return {
			scope: "global",
			path: envPath,
			disabledTools: readConfigFile(envPath),
			hasProjectConfig: false,
			isEnvOverridden: true,
		};
	}

	const projectPath = getProjectConfigPath(cwd);
	const projectExists = existsSync(projectPath);

	if (isProjectTrusted && projectExists) {
		const projectDisabled = readConfigFile(projectPath);
		if (projectDisabled !== undefined) {
			return {
				scope: "project",
				path: projectPath,
				disabledTools: projectDisabled,
				hasProjectConfig: true,
				isEnvOverridden: false,
			};
		}
	}

	const globalPath = getGlobalConfigPath();
	return {
		scope: "global",
		path: globalPath,
		disabledTools: readConfigFile(globalPath),
		hasProjectConfig: projectExists,
		isEnvOverridden: false,
	};
}

/**
 * 磁盘策略指纹。只比较生效路径和 disabledTools 语义，
 * 格式化改动不会触发会话重载。
 */
export function configFingerprint(cwd: string, isProjectTrusted: boolean): string {
	const effective = resolveEffectiveConfig(cwd, isProjectTrusted);
	const disabled =
		effective.disabledTools === undefined
			? "<missing>"
			: effective.disabledTools.slice().sort().join("\0");
	return [
		effective.scope,
		effective.path,
		effective.hasProjectConfig ? "1" : "0",
		effective.isEnvOverridden ? "1" : "0",
		disabled,
	].join("|");
}

export function deleteProjectConfigFile(cwd: string): boolean {
	const projectPath = getProjectConfigPath(cwd);
	if (existsSync(projectPath)) {
		rmSync(projectPath, { force: true });
		return true;
	}
	return false;
}

export function saveScopeConfig(options: {
	scope: ConfigScope;
	cwd: string;
	disabledNames: string[];
	knownTools: Set<string>;
}): void {
	const { scope, cwd, disabledNames, knownTools } = options;
	let targetPath: string;
	if (process.env.PI_TOOLS_CONFIG) {
		targetPath = process.env.PI_TOOLS_CONFIG;
	} else if (scope === "project") {
		targetPath = getProjectConfigPath(cwd);
	} else {
		targetPath = getGlobalConfigPath();
	}

	const filtered = disabledNames.filter((name) => knownTools.has(name));
	writeConfigFile(targetPath, filtered);
}

/**
 * 将某个工具的开关状态持久化到目标 Scope：
 * - targetScope === "project"：写入 <cwd>/.pi/pi-tools.json
 * - targetScope === "global"：写入 ~/.pi/agent/pi-tools.json
 * 主动失活差量原则（Opt-out）：
 * 1. 仅对扩展工具与调度器生效，系统内置核心工具绝对拦截。
 * 2. 真实读取目标作用域配置（若此前无配置，则以空基底 [] 派生）。
 * 3. enabled === true 代表从失活名单中移出；enabled === false 代表加入失活名单。
 */
export function persistToolPreference(options: {
	toolName: string;
	enabled: boolean;
	targetScope: ConfigScope;
	cwd: string;
	knownTools: Set<string>;
}): void {
	const { toolName, enabled, targetScope, cwd, knownTools } = options;
	if (!knownTools.has(toolName)) return;

	let targetPath: string;
	if (process.env.PI_TOOLS_CONFIG) {
		targetPath = process.env.PI_TOOLS_CONFIG;
	} else if (targetScope === "project") {
		targetPath = getProjectConfigPath(cwd);
	} else {
		targetPath = getGlobalConfigPath();
	}

	const baseList = readConfigFile(targetPath) ?? [];
	const set = new Set(baseList);

	if (enabled) {
		set.delete(toolName);
	} else {
		set.add(toolName);
	}

	const filtered = Array.from(set).filter((name) => knownTools.has(name));
	writeConfigFile(targetPath, filtered);
}
