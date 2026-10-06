import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";

export const SEARCH_TOOL_NAME = "tool_search";
export type ToolMode = "inherit" | "always" | "on-demand";
export type ToolModes = Record<string, Exclude<ToolMode, "inherit">>;
export type ToolKind = "builtin" | "service" | "native" | "unsupported";
export const MODE_LABELS: Record<ToolMode, string> = {
	inherit: "跟随扩展", always: "常驻", "on-demand": "按需",
};

export function modeOf(modes: ToolModes, name: string): ToolMode {
	return Object.hasOwn(modes, name) ? modes[name]! : "inherit";
}
export function nextMode(mode: ToolMode): ToolMode {
	return mode === "inherit" ? "always" : mode === "always" ? "on-demand" : "inherit";
}
export function firstSentence(text: string | undefined): string {
	return (text?.match(/^.+?(?:[。！!？?]|(?:\.\s)|\.$|$)/)?.[0] ?? text ?? "").trim();
}
export function exposureOf(tool: ToolInfo): ToolExposure {
	return tool.exposure ?? "direct";
}
export function isSupported(toolOrName: ToolInfo | string): boolean {
	const name = typeof toolOrName === "string" ? toolOrName : toolOrName.name;
	return name !== "powershell" || process.platform === "win32";
}
export function toolKind(tool: ToolInfo): ToolKind {
	if ([SEARCH_TOOL_NAME, "codemode"].includes(tool.name)) return "service";
	if (tool.sourceInfo?.source === "builtin") return "builtin";
	const exposure = exposureOf(tool);
	return exposure === "deferred" || exposure === "codemode" ? "native" : "unsupported";
}
export function isManageable(tool: ToolInfo): boolean {
	return toolKind(tool) === "native" && isSupported(tool);
}
export function lockReason(tool: ToolInfo): string | undefined {
	switch (toolKind(tool)) {
		case "builtin": return "内置工具由 Pi 的 defaultTools / CLI 管理";
		case "service": return "原生调度工具由 Pi 管理";
		case "unsupported": return exposureOf(tool) === "hidden"
			? "hidden 工具不可达，本面板不会将其重新开放"
			: `${exposureOf(tool)} 不在原生搜索池中；需由工具所属扩展适配 deferred`;
	}
}

/** Invalid entries are rejected rather than silently changing the loading policy. */
export function parseModes(value: unknown): ToolModes | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.some(([name, mode]) => !name.trim() || !["inherit", "always", "on-demand"].includes(mode))) {
		return undefined;
	}
	return Object.fromEntries(entries.filter(([, mode]) => mode !== "inherit")) as ToolModes;
}
export function modesEqual(a: ToolModes, b: ToolModes): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((name) => modeOf(a, name) === modeOf(b, name));
}
