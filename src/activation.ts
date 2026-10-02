import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isOnDemand, LOADER_TOOL_NAME } from "./shared.ts";

/**
 * 分支里持久化的工具状态。
 * enabledTools 只是当时的结果快照；恢复时不以它覆盖磁盘。
 * sessionActivated 才是 enable_tool 的会话增量（磁盘仍把这些工具列在 disabledTools 里）。
 */
export interface StoredToolsState {
	enabledTools: string[];
	sessionActivated?: string[];
	/** Pi 愿意激活的名字。/reload 会丢掉内存里的冻结基线，靠它找回来。 */
	piBaseline?: string[];
}

export interface BranchLikeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** 稳定契约：不把「当前未激活名单」写进 guidelines，避免同一次请求内名单过期后和真实工具列表打架。 */
export const ACTIVATION_CONTRACT =
	"未激活的扩展工具先单独调用 enable_tool，本条助手消息不要并行调用目标工具。返回后，同一用户请求的下一助手回合会带上参数定义，立刻调用并完成原任务，不要让用户再发一条消息。工具已经在当前工具列表里就直接调用，不要再 enable_tool。";

export function activationResultText(enabled: readonly string[]): string {
	const list = enabled.join(", ");
	return `Enabled: ${list}. Do not call them in this assistant message. The next assistant turn of this same user request already has their schemas — call them now and finish the original task. Do not ask the user to send another message. If you also called one of them in this message, that call failed; call it again now.`;
}

export function toolsUpdateNotice(enabled: readonly string[], disabled: readonly string[]): string | undefined {
	if (enabled.length === 0 && disabled.length === 0) return undefined;
	const parts: string[] = [];
	if (enabled.length > 0) {
		parts.push(
			`User enabled: ${enabled.join(", ")}. These tools are already active. Call them directly; do not call enable_tool for them.`,
		);
	}
	if (disabled.length > 0) {
		parts.push(`User disabled: ${disabled.join(", ")}. Do not call these tools.`);
	}
	return `<tools_update>${parts.join(" ")}</tools_update>`;
}

export function managedToolDelta(
	before: Iterable<string>,
	after: Iterable<string>,
	allTools: readonly ToolInfo[],
): { enabled: string[]; disabled: string[] } {
	const managed = new Set(
		allTools.filter((tool) => isOnDemand(tool) || tool.name === LOADER_TOOL_NAME).map((tool) => tool.name),
	);
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const name of managed) {
		const was = beforeSet.has(name);
		const now = afterSet.has(name);
		if (was === now) continue;
		(now ? enabled : disabled).push(name);
	}
	enabled.sort();
	disabled.sort();
	return { enabled, disabled };
}

export function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
	const a = new Set(left);
	const b = new Set(right);
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
}

/**
 * 磁盘策略是基准。sessionActivated 只补回本分支用 enable_tool 打开、且磁盘仍禁用的扩展工具。
 * 之后重算 loader：没有待激活扩展工具时不占 token。
 */
export function applySessionActivations(
	diskEnabled: ReadonlySet<string>,
	sessionActivated: Iterable<string>,
	allTools: readonly ToolInfo[],
	disabledNames: ReadonlySet<string>,
	baseline?: Iterable<string>,
): Set<string> {
	const willing = baseline ? new Set(baseline) : undefined;
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const next = new Set(diskEnabled);
	for (const name of sessionActivated) {
		// 不在 Pi 基线里的名字不是我们收编的，会话增量也不能拉回来。
		if (willing && !willing.has(name)) continue;
		const tool = byName.get(name);
		if (tool && isOnDemand(tool)) next.add(name);
	}
	const hasInactive = allTools.some(
		(tool) => isOnDemand(tool) && !next.has(tool.name) && (!willing || willing.has(tool.name)),
	);
	if (disabledNames.has(LOADER_TOOL_NAME) || !hasInactive) {
		next.delete(LOADER_TOOL_NAME);
	} else {
		next.add(LOADER_TOOL_NAME);
	}
	return next;
}

/** 只保留「当前仍启用，且磁盘仍禁用」的扩展工具。磁盘已放开的不再算会话增量。 */
export function pruneSessionActivated(
	activated: Iterable<string>,
	enabled: ReadonlySet<string>,
	allTools: readonly ToolInfo[],
	disabledNames: ReadonlySet<string>,
): string[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	return [...activated].filter((name) => {
		const tool = byName.get(name);
		return !!tool && isOnDemand(tool) && enabled.has(name) && disabledNames.has(name);
	});
}

export function lastToolsState(entries: readonly BranchLikeEntry[]): StoredToolsState | undefined {
	let saved: StoredToolsState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "tools-config") continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as { enabledTools?: unknown; sessionActivated?: unknown; piBaseline?: unknown };
		if (!Array.isArray(data.enabledTools)) continue;
		saved = {
			enabledTools: data.enabledTools.filter((name): name is string => typeof name === "string"),
			sessionActivated: Array.isArray(data.sessionActivated)
				? data.sessionActivated.filter((name): name is string => typeof name === "string")
				: undefined,
			piBaseline: Array.isArray(data.piBaseline)
				? data.piBaseline.filter((name): name is string => typeof name === "string")
				: undefined,
		};
	}
	return saved;
}

/**
 * 旧条目没有 sessionActivated。绝不能把 enabledTools 绝对快照当成增量，
 * 否则外部修改 disabledTools 会在 resume 时被历史快照盖掉。
 */
export function activationsFromSaved(saved: StoredToolsState | undefined): string[] {
	return saved?.sessionActivated?.filter((name) => name.trim() !== "") ?? [];
}

export function toolsStateChanged(
	saved: StoredToolsState | undefined,
	enabled: Iterable<string>,
	sessionActivated: Iterable<string>,
	baseline?: Iterable<string>,
): boolean {
	if (!saved) return false;
	if (!sameStringSet(saved.enabledTools, enabled) || !sameStringSet(saved.sessionActivated ?? [], sessionActivated)) {
		return true;
	}
	return baseline !== undefined && !sameStringSet(saved.piBaseline ?? [], baseline);
}

function prependNoticeToContent(content: unknown, notice: string): unknown {
	if (typeof content === "string") {
		return content.length > 0 ? `${notice}\n\n${content}` : notice;
	}
	if (Array.isArray(content)) {
		if (content.length === 0) {
			return [{ type: "text", text: notice }];
		}
		const first = content[0];
		if (
			first &&
			typeof first === "object" &&
			(first as { type?: unknown }).type === "text" &&
			typeof (first as { text?: unknown }).text === "string"
		) {
			const text = (first as { text: string }).text;
			const updatedFirst = {
				...first,
				text: text.length > 0 ? `${notice}\n\n${text}` : notice,
			};
			return [updatedFirst, ...content.slice(1)];
		}
		return [{ type: "text", text: notice }, ...content];
	}
	return notice;
}

export function injectToolsNotice<T extends { role: string }>(messages: readonly T[], notice: string): T[] {
	if (!notice) return messages.slice();
	const next = messages.slice();
	let lastUserIndex = -1;
	for (let i = next.length - 1; i >= 0; i--) {
		if (next[i]?.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	if (lastUserIndex !== -1) {
		const target = next[lastUserIndex]!;
		const currentContent = "content" in target ? (target as { content?: unknown }).content : undefined;
		next[lastUserIndex] = {
			...target,
			content: prependNoticeToContent(currentContent, notice),
		};
		return next;
	}

	const fallback = { role: "user", content: notice, timestamp: Date.now() } as unknown as T;
	next.push(fallback);
	return next;
}
