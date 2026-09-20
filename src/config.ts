import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFS_FILE = "pi-tools.json";

export type ConfigScope = "project" | "global";

export interface ConfigResolution {
	scope: ConfigScope;
	path: string;
	tools: string[] | undefined;
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
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { defaultEnabled?: unknown };
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.defaultEnabled)) {
			return undefined;
		}
		return parsed.defaultEnabled.filter((name): name is string => typeof name === "string" && name.trim() !== "");
	} catch {
		return undefined;
	}
}

export function writeConfigFile(filePath: string, names: string[]): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(
		filePath,
		`${JSON.stringify({ defaultEnabled: names }, null, 2)}\n`,
		"utf8",
	);
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
			tools: readConfigFile(envPath),
			hasProjectConfig: false,
			isEnvOverridden: true,
		};
	}

	const projectPath = getProjectConfigPath(cwd);
	const projectExists = existsSync(projectPath);

	if (isProjectTrusted && projectExists) {
		const projectTools = readConfigFile(projectPath);
		if (projectTools !== undefined) {
			return {
				scope: "project",
				path: projectPath,
				tools: projectTools,
				hasProjectConfig: true,
				isEnvOverridden: false,
			};
		}
	}

	const globalPath = getGlobalConfigPath();
	return {
		scope: "global",
		path: globalPath,
		tools: readConfigFile(globalPath),
		hasProjectConfig: projectExists,
		isEnvOverridden: false,
	};
}

/**
 * 将某个工具的开关状态持久化到目标 Scope：
 * - targetScope === "project"：写入 <cwd>/.pi/pi-tools.json。若此前无项目配置，以全局配置为基底派生。
 * - targetScope === "global"：写入全局配置。
 * 遵循原则：仅根据人类刚拨动的这一个工具变更，避免将模型临时唤醒的工具连带持久化。
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
	let baseList: string[] | undefined;

	if (process.env.PI_TOOLS_CONFIG) {
		targetPath = process.env.PI_TOOLS_CONFIG;
		baseList = readConfigFile(targetPath) ?? [];
	} else if (targetScope === "project") {
		targetPath = getProjectConfigPath(cwd);
		// 项目优先读取自身；若首次建立项目配置，以全局配置为初始基底派生
		baseList = readConfigFile(targetPath) ?? readConfigFile(getGlobalConfigPath()) ?? [];
	} else {
		targetPath = getGlobalConfigPath();
		baseList = readConfigFile(targetPath) ?? [];
	}

	const set = new Set(baseList);
	if (enabled) {
		set.add(toolName);
	} else {
		set.delete(toolName);
	}

	const filtered = Array.from(set).filter((name) => knownTools.has(name));
	writeConfigFile(targetPath, filtered);
}
