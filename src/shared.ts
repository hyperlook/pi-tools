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

export function toolKind(tool: ToolInfo): ToolKind {
	if (tool.name === LOADER_TOOL_NAME) return "loader";
	return isBuiltin(tool) ? "builtin" : "user";
}
