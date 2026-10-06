import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";

export const SEARCH_TOOL_NAME = "tool_search";
export const EXPOSURE_MODES = ["direct", "codemode", "deferred"] as const;
export type ExposureMode = typeof EXPOSURE_MODES[number];
export type ToolExposures = Record<string, ExposureMode>;
export type ToolKind = "builtin" | "service" | "extension" | "protected";
export function isExposureMode(value: unknown): value is ExposureMode {
	return EXPOSURE_MODES.some((mode) => mode === value);
}
export function exposureOf(tool: { exposure?: ToolExposure }): ToolExposure {
	return tool.exposure ?? "direct";
}
export function configuredExposure(overrides: ToolExposures, name: string, original: ToolExposure): ToolExposure {
	return Object.hasOwn(overrides, name) ? overrides[name]! : original;
}
export function nextExposure(mode: ExposureMode): ExposureMode {
	return EXPOSURE_MODES[(EXPOSURE_MODES.indexOf(mode) + 1) % EXPOSURE_MODES.length]!;
}
export function prevExposure(mode: ExposureMode): ExposureMode {
	return EXPOSURE_MODES[(EXPOSURE_MODES.indexOf(mode) + EXPOSURE_MODES.length - 1) % EXPOSURE_MODES.length]!;
}
export function firstSentence(text: string | undefined): string {
	// Descriptions may start with Markdown headings and span several paragraphs.
	// Flatten before matching: a failed dot-match must never leak newlines into a TUI row.
	const plain = (text ?? "").replace(/^#{1,6}[^\r\n]*(?:\r?\n|$)/gm, " ").replace(/\s+/gu, " ").trim();
	return (plain.match(/^.+?(?:[。！!？?]|(?:\.\s)|\.$|$)/)?.[0] ?? plain).trim();
}
export function isSupported(toolOrName: ToolInfo | string): boolean {
	const name = typeof toolOrName === "string" ? toolOrName : toolOrName.name;
	return name !== "powershell" || process.platform === "win32";
}
export function toolKind(tool: ToolInfo): ToolKind {
	if ([SEARCH_TOOL_NAME, "codemode"].includes(tool.name)) return "service";
	if (tool.sourceInfo?.source === "builtin") return "builtin";
	return isExposureMode(exposureOf(tool)) && tool.sourceInfo?.source !== "sdk" ? "extension" : "protected";
}
export function isManageable(tool: ToolInfo): boolean {
	return toolKind(tool) === "extension" && isSupported(tool);
}
export function lockReason(tool: ToolInfo): string | undefined {
	switch (toolKind(tool)) {
		case "builtin": return "Builtin tools are managed by Pi defaultTools / CLI";
		case "service": return "Native service tools are managed by Pi";
		case "protected": return tool.sourceInfo?.source === "sdk"
			? "SDK customTools bypass extension registry and cannot be overridden"
			: `${exposureOf(tool)} tool is protected; cannot change exposure boundary`;
	}
}
export function parseExposures(value: unknown): ToolExposures | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.some(([name, mode]) => !name.trim() || !isExposureMode(mode))) return undefined;
	return Object.fromEntries(entries) as ToolExposures;
}
export function exposuresEqual(a: ToolExposures, b: ToolExposures): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((name) => Object.hasOwn(b, name) && a[name] === b[name]);
}
