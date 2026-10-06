import { describe, expect, it } from "bun:test";
import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { lastPolicyState, planPolicy, sameNames, STATE_ENTRY, stateEqual } from "../src/policy.ts";
import { modeOf, nextMode, type ToolModes } from "../src/shared.ts";

function tool(name: string, exposure: ToolExposure = "deferred", source = "npm:example"): ToolInfo {
	return { name, exposure, description: name, parameters: { type: "object" }, sourceInfo: { source } };
}
const tools = [tool("read", "direct", "builtin"), tool("bash", "direct", "builtin"),
	tool("tool_search", "model-only"), tool("codemode", "model-only"), tool("docs"),
	tool("images", "codemode"), tool("legacy", "direct"), tool("ask", "model-only"), tool("secret", "hidden")];

describe("native loading policy", () => {
	it("does not touch the startup loadout without explicit preferences", () => {
		const active = ["read", "legacy", "docs"];
		expect([...planPolicy(active, tools, {}).active]).toEqual(active);
	});
	it("cycles three modes with an explicit opt-out", () => {
		expect(nextMode("inherit")).toBe("always");
		expect(nextMode("always")).toBe("on-demand");
		expect(nextMode("on-demand")).toBe("inherit");
		expect(modeOf({}, "docs")).toBe("inherit");
	});
	it("activates a native tool when switching to always", () => {
		const plan = planPolicy(["read"], tools, { docs: "always" });
		expect([...plan.active]).toEqual(["read", "docs"]);
	});
	it("applies on-demand and enables the existing native search tool", () => {
		const plan = planPolicy(["read", "docs"], tools, { docs: "on-demand" });
		expect([...plan.active]).toEqual(["read", "tool_search"]);
		expect(plan.missingSearch).toBe(false);
	});
	it("does not unload native search matches on later syncs or reloads", () => {
		const modes: ToolModes = { docs: "on-demand" };
		const first = planPolicy(["read", "docs"], tools, modes);
		const restored = lastPolicyState([{ type: "custom", customType: STATE_ENTRY, data: first.state }]);
		const next = planPolicy(["read", "tool_search", "docs"], tools, modes, restored);
		expect(next.active.has("docs")).toBe(true);
		expect(stateEqual(first.state, next.state)).toBe(true);
	});
	it("does not re-add tools another extension deactivated", () => {
		const first = planPolicy(["read", "bash"], tools, { docs: "always", images: "on-demand" });
		const next = planPolicy(["read", "tool_search"], tools,
			{ docs: "always", images: "always" }, first.state);
		expect(next.active.has("bash")).toBe(false);
		expect(next.active.has("docs")).toBe(false);
		expect(next.active.has("images")).toBe(true);
	});
	it("returning to inherit releases control without rewinding the live set", () => {
		const first = planPolicy(["read"], tools, { docs: "always" });
		const next = planPolicy(first.active, tools, {}, first.state);
		expect(next.active.has("docs")).toBe(true);
		expect(next.state.appliedModes).toEqual({});
	});
	it("ignores preferences for builtins, services, hidden and unadapted tools", () => {
		const modes: ToolModes = { read: "on-demand", bash: "always", tool_search: "on-demand",
			codemode: "on-demand", legacy: "on-demand", ask: "always", secret: "always" };
		const plan = planPolicy(["read", "legacy", "codemode"], tools, modes);
		expect([...plan.active]).toEqual(["read", "legacy", "codemode"]);
		expect(plan.state.appliedModes).toEqual({});
	});
	it("never revives a missing or CLI-excluded tool", () => {
		const plan = planPolicy(["read"], tools.filter((t) => t.name !== "docs"), { docs: "always" });
		expect([...plan.active]).toEqual(["read"]);
	});
	it("handles late native registration and conversion without modifying exposure", () => {
		const first = planPolicy(["legacy"], tools, { legacy: "on-demand" });
		const converted = tools.map((t) => t.name === "legacy" ? { ...t, exposure: "deferred" as const } : t);
		const next = planPolicy(first.active, converted, { legacy: "on-demand" }, first.state);
		expect(next.active.has("legacy")).toBe(false);
		expect(next.active.has("tool_search")).toBe(true);
		expect(converted.find((t) => t.name === "legacy")?.exposure).toBe("deferred");
	});
	it("does not reapply on-demand when a known MCP tool is temporarily absent on resume", () => {
		const modes: ToolModes = { docs: "on-demand" };
		const first = planPolicy(["read"], tools, modes);
		const disconnected = planPolicy(["read"], tools.filter((t) => t.name !== "docs"), modes, first.state);
		const reconnected = planPolicy(["read", "docs"], tools, modes, disconnected.state);
		expect(reconnected.active.has("docs")).toBe(true);
	});
	it("applies a changed preference when a disconnected tool reappears", () => {
		const first = planPolicy([], tools, { docs: "on-demand" });
		const absent = planPolicy([], [], { docs: "always" }, first.state);
		const next = planPolicy([], tools, { docs: "always" }, absent.state);
		expect(next.active.has("docs")).toBe(true);
	});
	it("warns when discovery is absent, and enables it when it arrives", () => {
		const modes: ToolModes = { docs: "on-demand" };
		const first = planPolicy(["docs"], tools.filter((t) => t.name !== "tool_search"), modes);
		expect(first.missingSearch).toBe(true);
		expect(first.active.has("tool_search")).toBe(false);
		const next = planPolicy(first.active, tools, modes, first.state);
		expect(next.active.has("tool_search")).toBe(true);
	});
	it("takes policy from the active branch, not old tools-config snapshots", () => {
		const state = planPolicy([], tools, { docs: "always" }).state;
		expect(lastPolicyState([{ type: "custom", customType: "tools-config", data: { enabledTools: ["docs"] } }])).toBeUndefined();
		expect(lastPolicyState([
			{ type: "custom", customType: STATE_ENTRY, data: state },
			{ type: "custom", customType: STATE_ENTRY, data: { appliedModes: { docs: "invalid" } } },
		])).toEqual(state);
	});
	it("treats tool names as data, including object prototype keys", () => {
		const special = [tool("__proto__"), tool("constructor")];
		const modes = JSON.parse('{"__proto__":"always","constructor":"on-demand"}');
		const plan = planPolicy(["constructor"], special, modes);
		expect(plan.active.has("__proto__")).toBe(true);
		expect(plan.active.has("constructor")).toBe(false);
		expect(modeOf({}, "constructor")).toBe("inherit");
	});
	it("compares names without order or duplicate sensitivity", () => {
		expect(sameNames(["docs", "read", "read"], ["read", "docs"])).toBe(true);
		expect(sameNames(["read"], [])).toBe(false);
	});
});
