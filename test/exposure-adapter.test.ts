import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { ExposureAdapter } from "../src/exposure-adapter.ts";

describe("host adapter fails explicitly", () => {
	it("rejects a missing host method", () => {
		const proto = ExtensionRunner.prototype;
		const original = proto.createContext;
		try {
			(proto as any).createContext = undefined;
			expect(() => new ExposureAdapter().install(() => {})).toThrow("createContext missing");
		} finally { proto.createContext = original; }
	});
	it("detects another adapter replacing its hook", () => {
		const proto = ExtensionRunner.prototype;
		new ExposureAdapter().install(() => {});
		const wrapper = proto.getAllRegisteredTools;
		try {
			proto.getAllRegisteredTools = () => [];
			expect(() => new ExposureAdapter().install(() => {})).toThrow("another adapter replaced");
		} finally { proto.getAllRegisteredTools = wrapper; }
	});
	it("does not silently succeed if the host's class instance was never intercepted", () => {
		expect(() => new ExposureAdapter().view({ sessionManager: {} } as any)).toThrow("host registry hook did not run");
	});
});
