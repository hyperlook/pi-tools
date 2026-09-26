import { describe, expect, it } from "bun:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	activationResultText,
	activationsFromSaved,
	applySessionActivations,
	injectToolsNotice,
	lastToolsState,
	managedToolDelta,
	pruneSessionActivated,
	toolsUpdateNotice,
} from "../src/activation.ts";
import { LOADER_TOOL_NAME } from "../src/shared.ts";

function mockTool(name: string, source: "builtin" | "extension"): ToolInfo {
	return {
		name,
		description: `Description of ${name}`,
		parameters: { type: "object", properties: {} },
		sourceInfo: source === "builtin" ? { source: "builtin" } : { source: "npm:some-ext" },
		execute: async () => ({ content: [] }),
	};
}

const tools = [
	mockTool("read", "builtin"),
	mockTool("bash", "builtin"),
	mockTool(LOADER_TOOL_NAME, "extension"),
	mockTool("web_search", "extension"),
	mockTool("image_gen", "extension"),
];

describe("session activation policy", () => {
	it("keeps disk policy and only re-adds explicit session activations", () => {
		const disk = new Set(["read", "bash", "web_search", LOADER_TOOL_NAME]);
		const disabled = new Set(["image_gen"]);

		const merged = applySessionActivations(disk, ["image_gen", "read", "missing"], tools, disabled);

		expect(merged.has("image_gen")).toBe(true);
		expect(merged.has("web_search")).toBe(true);
		expect(merged.has("read")).toBe(true);
		expect(merged.has(LOADER_TOOL_NAME)).toBe(false);
	});

	it("does not let a legacy absolute snapshot imply session activations", () => {
		const saved = lastToolsState([
			{ type: "message" },
			{
				type: "custom",
				customType: "tools-config",
				data: { enabledTools: ["read", "image_gen", "web_search"] },
			},
		]);

		expect(saved?.enabledTools).toEqual(["read", "image_gen", "web_search"]);
		expect(activationsFromSaved(saved)).toEqual([]);

		const disk = new Set(["read", "bash", "web_search", LOADER_TOOL_NAME]);
		const merged = applySessionActivations(disk, activationsFromSaved(saved), tools, new Set(["image_gen"]));
		expect(merged.has("image_gen")).toBe(false);
	});

	it("uses the latest tools-config and keeps an explicit session delta", () => {
		const saved = lastToolsState([
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["read"], sessionActivated: ["old"] } },
			{
				type: "custom",
				customType: "tools-config",
				data: { enabledTools: ["read", "image_gen"], sessionActivated: ["image_gen"] },
			},
		]);

		expect(activationsFromSaved(saved)).toEqual(["image_gen"]);
	});

	it("drops session activations once disk no longer disables them", () => {
		const enabled = new Set(["read", "image_gen", "web_search"]);
		expect(pruneSessionActivated(["image_gen", "web_search", "read"], enabled, tools, new Set(["image_gen"]))).toEqual([
			"image_gen",
		]);
	});

	it("tells the model to continue in the same request instead of waiting for the user", () => {
		const text = activationResultText(["image_gen"]);
		expect(text).toContain("Enabled: image_gen");
		expect(text).toContain("next assistant turn of this same user request");
		expect(text).toContain("Do not ask the user to send another message");
		expect(text).not.toContain("next model request");
	});

	it("builds a one-shot notice for managed tools only", () => {
		const delta = managedToolDelta(
			["read", "web_search", LOADER_TOOL_NAME],
			["read", "image_gen"],
			tools,
		);
		expect(delta).toEqual({ enabled: ["image_gen"], disabled: [LOADER_TOOL_NAME, "web_search"] });
		expect(toolsUpdateNotice(delta.enabled, delta.disabled)).toContain("do not call enable_tool");
		expect(toolsUpdateNotice([], [])).toBeUndefined();
	});

	it("prepends the notice to the latest user message without creating consecutive user messages", () => {
		const messages = [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "draw this" },
		];
		const next = injectToolsNotice(messages, "<tools_update>User enabled: image_gen.</tools_update>");
		// 严禁连续出现两条 user message，保持合法角色交替
		expect(next.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(next[2]?.content).toBe("<tools_update>User enabled: image_gen.</tools_update>\n\ndraw this");
		// 不可变性：原数组及其内容未被污染
		expect(messages).toHaveLength(3);
		expect(messages[2]?.content).toBe("draw this");
	});

	it("prepends notice when user content is block array", () => {
		const textBlocks = [
			{ role: "user", content: [{ type: "text", text: "draw this" }] },
		];
		const nextText = injectToolsNotice(textBlocks, "<tools_update>notice</tools_update>");
		expect(nextText[0]?.content).toEqual([{ type: "text", text: "<tools_update>notice</tools_update>\n\ndraw this" }]);

		const imageBlocks = [
			{ role: "user", content: [{ type: "image", data: "base64", mimeType: "image/png" }] },
		];
		const nextImage = injectToolsNotice(imageBlocks, "<tools_update>notice</tools_update>");
		expect(nextImage[0]?.content).toEqual([
			{ type: "text", text: "<tools_update>notice</tools_update>" },
			{ type: "image", data: "base64", mimeType: "image/png" },
		]);
	});

	it("falls back to appending user message when history has no user message", () => {
		const messages = [{ role: "system", content: "sys" }];
		const next = injectToolsNotice(messages, "<tools_update>notice</tools_update>");
		expect(next).toHaveLength(2);
		expect(next[1]?.role).toBe("user");
		expect(next[1]?.content).toBe("<tools_update>notice</tools_update>");
	});
});
