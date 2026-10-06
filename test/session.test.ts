import { describe, expect, it } from "bun:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { exposuresEqual, lastPolicyState, planPolicy, sameNames, STATE_ENTRY } from "../src/policy.ts";
import { configuredExposure, nextExposure } from "../src/shared.ts";
function tool(name: string, exposure: ToolInfo["exposure"] = "direct", source = "example"): ToolInfo {
	return { name, exposure, description: name, parameters: { type: "object" }, sourceInfo: { source } };
}
const search = tool("tool_search", "model-only");
const codemode = tool("codemode", "model-only");
describe("exposure transition policy", () => {
	it("leaves the live loadout untouched without overrides", () => {
		const result = planPolicy(["bash", "legacy"], [tool("legacy"), tool("docs", "deferred"), search], {});
		expect([...result.active]).toEqual(["bash", "legacy"]);
		expect(result.applied).toEqual({});
	});
	it("cycles only real exposure values", () => {
		expect(nextExposure("direct")).toBe("codemode");
		expect(nextExposure("codemode")).toBe("deferred");
		expect(nextExposure("deferred")).toBe("direct");
		expect(configuredExposure({}, "legacy", "direct")).toBe("direct");
	});
	it("activates direct overrides exactly once", () => {
		const tools = [tool("docs")];
		const first = planPolicy([], tools, { docs: "direct" });
		expect(first.active.has("docs")).toBe(true);
		const later = planPolicy([], tools, { docs: "direct" }, first.applied);
		expect(later.active.has("docs")).toBe(false);
	});
	it("unloads newly deferred declarations and activates native search", () => {
		const result = planPolicy(["bash", "docs"], [tool("docs", "deferred"), search], { docs: "deferred" });
		expect([...result.active]).toEqual(["bash", "tool_search"]);
		expect(result.missingSearch).toBe(false);
	});
	it("activates the native script directory for codemode overrides", () => {
		const result = planPolicy(["docs"], [tool("docs", "codemode"), search, codemode], { docs: "codemode" });
		expect([...result.active]).toEqual(["tool_search", "codemode"]);
	});
	it("does not unload tools loaded by native search on later syncs", () => {
		const first = planPolicy(["docs"], [tool("docs", "deferred"), search], { docs: "deferred" });
		const later = planPolicy(["docs", "tool_search"], [tool("docs", "deferred"), search], { docs: "deferred" }, first.applied);
		expect(later.active.has("docs")).toBe(true);
		expect(exposuresEqual(first.applied, later.applied)).toBe(true);
	});
	it("applies actual mode changes without resetting unrelated tools", () => {
		const result = planPolicy([], [tool("docs"), tool("images", "deferred"), search], { docs: "direct", images: "deferred" },
			{ docs: "direct", images: "direct" });
		expect(result.active.has("docs")).toBe(false);
		expect(result.active.has("bash")).toBe(false);
		expect(result.active.has("images")).toBe(false);
	});
	it("rejects a fake exposure switch instead of merely hiding a direct tool", () => {
		expect(() => planPolicy(["docs"], [tool("docs")], { docs: "deferred" })).toThrow("did not take effect");
	});
	it("restores native activation behavior when an override is removed", () => {
		const direct = planPolicy([], [tool("docs")], {}, { docs: "deferred" });
		expect(direct.active.has("docs")).toBe(true);
		expect(direct.applied).toEqual({});
		const deferred = planPolicy(["docs"], [tool("docs", "deferred")], {}, { docs: "direct" });
		expect(deferred.active.has("docs")).toBe(false);
	});
	it("ignores attempts to override protected tools", () => {
		const result = planPolicy(["read"], [tool("read", "direct", "builtin"), search, codemode,
			tool("hidden", "hidden"), tool("locked", "model-only"), tool("sdk", "direct", "sdk")],
			{ read: "deferred", tool_search: "direct", codemode: "direct", hidden: "direct", locked: "direct", sdk: "deferred" });
		expect([...result.active]).toEqual(["read"]);
		expect(result.applied).toEqual({});
	});
	it("retains applied entries through temporary absence but applies changed overrides on return", () => {
		const absent = planPolicy([], [], { docs: "direct" }, { docs: "deferred" });
		expect(absent.applied).toEqual({ docs: "deferred" });
		expect(absent.active.has("docs")).toBe(false);
		const returned = planPolicy([], [tool("docs")], { docs: "direct" }, absent.applied);
		expect(returned.active.has("docs")).toBe(true);
	});
	it("reports missing host search and script orchestrators", () => {
		const result = planPolicy([], [tool("docs", "codemode")], { docs: "codemode" });
		expect(result.missingSearch).toBe(true);
		expect(result.missingCodemode).toBe(true);
		expect([...result.active]).toEqual([]);
	});
	it("activates a late discovery service only once", () => {
		const first = planPolicy([], [tool("docs", "deferred")], { docs: "deferred" });
		const later = planPolicy([], [tool("docs", "deferred"), search], { docs: "deferred" }, first.applied, first.services);
		expect(later.active.has("tool_search")).toBe(true);
		const external = planPolicy([], [tool("docs", "deferred"), search], { docs: "deferred" }, later.applied, later.services);
		expect(external.active.has("tool_search")).toBe(false);
	});
	it("reads only valid policy snapshots from the active branch", () => {
		expect(lastPolicyState([{ type: "custom", customType: "tools-loading-policy", data: { appliedModes: { docs: "always" } } },
			{ type: "custom", customType: STATE_ENTRY, data: { applied: { docs: "deferred" }, services: ["tool_search"] } },
			{ type: "custom", customType: STATE_ENTRY, data: { applied: { docs: "hidden" }, services: [] } }]))
			.toEqual({ applied: { docs: "deferred" }, services: ["tool_search"] });
	});
	it("treats prototype keys as data", () => {
		const overrides = JSON.parse('{"__proto__":"deferred","constructor":"direct"}');
		const result = planPolicy([], [tool("__proto__", "deferred"), tool("constructor")], overrides);
		expect(Object.hasOwn(result.applied, "__proto__")).toBe(true);
		expect(result.active.has("constructor")).toBe(true);
		expect(configuredExposure({}, "constructor", "direct")).toBe("direct");
	});
	it("compares maps and sets without depending on order", () => {
		expect(exposuresEqual({ a: "direct", b: "deferred" }, { b: "deferred", a: "direct" })).toBe(true);
		expect(exposuresEqual({}, { a: "direct" })).toBe(false);
		expect(sameNames(["a", "a", "b"], ["b", "a"])).toBe(true);
	});
});
