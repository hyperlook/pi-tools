import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const LOADER_TOOL_NAME = "enable_tool";

export type ToolKind = "loader" | "builtin" | "user";

export function firstSentence(text: string | undefined): string {
	if (!text) return "";
	const match = text.match(/^.+?(?:[。！!？?]|(?:\.\s)|\.$|$)/);
	return (match?.[0] ?? text).trim();
}

export function isBuiltin(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin";
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
	return isBuiltin(tool) ? "builtin" : "user";
}

/**
 * 扩展工具：非内置核心工具、非调度器、受当前系统环境支持
 */
export function isOnDemand(tool: ToolInfo): boolean {
	return tool.name !== LOADER_TOOL_NAME && !isBuiltin(tool) && isSupported(tool);
}
