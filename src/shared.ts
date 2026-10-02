import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";

export const LOADER_TOOL_NAME = "enable_tool";

export type ToolKind = "loader" | "builtin" | "upstream" | "user";

export function firstSentence(text: string | undefined): string {
	if (!text) return "";
	const match = text.match(/^.+?(?:[。！!？?]|(?:\.\s)|\.$|$)/);
	return (match?.[0] ?? text).trim();
}

export function isBuiltin(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin";
}

/** Pi 1.0 起显式声明；缺省视为 direct，兼容旧宿主形状。 */
export function exposureOf(tool: ToolInfo): ToolExposure {
	return tool.exposure ?? "direct";
}

/** 能被模型直接看见的 exposure：只有这两种会随 active 集合进入请求声明。 */
export function isDeclarable(tool: ToolInfo): boolean {
	const exposure = exposureOf(tool);
	return exposure === "direct" || exposure === "model-only";
}

/** deferred / codemode / hidden：由上游 tool_search、codemode 脚本或插件自己接管。 */
export function isUpstreamManaged(tool: ToolInfo): boolean {
	return !isDeclarable(tool);
}

export function isSupported(toolOrName: ToolInfo | string): boolean {
	const name = typeof toolOrName === "string" ? toolOrName : toolOrName.name;
	if (name === "powershell" && process.platform !== "win32") {
		return false;
	}
	return true;
}

export function toolKind(tool: ToolInfo): ToolKind {
	if (tool.name === LOADER_TOOL_NAME) return "loader";
	if (isBuiltin(tool)) return "builtin";
	return isDeclarable(tool) ? "user" : "upstream";
}

/** 面板只读锁定：内置核心工具由 defaultTools 托管，上游 exposure 由 tool_search / codemode 托管。 */
export function isLocked(tool: ToolInfo): boolean {
	return tool.name !== LOADER_TOOL_NAME && (isBuiltin(tool) || isUpstreamManaged(tool));
}

/**
 * 扩展工具：非内置核心工具、非调度器、exposure 可直接声明、受当前系统环境支持。
 * 只有这类工具归本扩展收编，其余一律不碰。
 */
export function isOnDemand(tool: ToolInfo): boolean {
	return tool.name !== LOADER_TOOL_NAME && !isBuiltin(tool) && isDeclarable(tool) && isSupported(tool);
}
