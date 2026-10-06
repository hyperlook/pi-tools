/**
 * The only host-internal integration point. Overlay registry definitions, not executors.
 * The process-wide hook dispatches by OUR command handler identity, so other sessions
 * and /reload without pi-tools receive the untouched upstream registry.
 */
import { ExtensionRunner, type ExtensionContext, type ToolExposure } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveConfig } from "./config.ts";
import { configuredExposure, exposureOf, isManageable, type ToolExposures } from "./shared.ts";

type Registry = ReturnType<ExtensionRunner["getAllRegisteredTools"]>;
type RegistryMethod = ExtensionRunner["getAllRegisteredTools"];
const HOOK = Symbol.for("pi-tools.exposure-adapter.v1");
interface HookState {
	wrapper: RegistryMethod;
	owners: WeakMap<Function, ExposureAdapter>;
}
export interface ExposureView {
	/** Frozen for this runner: external file edits require /reload, just like panel saves. */
	overrides: ToolExposures;
	originals: Map<string, ToolExposure>;
}
export class ExposureAdapter {
	private runners = new WeakMap<ExtensionRunner, ExposureView>();
	private sessions = new WeakMap<ExtensionContext["sessionManager"], ExposureView>();

	install(handler: Function): void {
		const proto = ExtensionRunner.prototype as typeof ExtensionRunner.prototype & { [HOOK]?: HookState };
		for (const key of ["getAllRegisteredTools", "getRegisteredCommands", "createContext"] as const) {
			if (typeof proto[key] !== "function") throw new Error(`pi-tools: incompatible Pi registry (${key} missing)`);
		}
		let state = proto[HOOK];
		if (state && proto.getAllRegisteredTools !== state.wrapper) {
			throw new Error("pi-tools: another adapter replaced the registry hook; exposure overrides cannot be guaranteed");
		}
		if (!state) {
			const original = proto.getAllRegisteredTools;
			const owners = new WeakMap<Function, ExposureAdapter>();
			const wrapper: RegistryMethod = function (this: ExtensionRunner) {
				const entries = original.call(this);
				const installed = this.getRegisteredCommands().flatMap((command) => {
					const owner = owners.get(command.handler);
					return owner ? [owner] : [];
				});
				if (installed.length > 1) throw new Error("pi-tools: multiple exposure managers loaded in one runtime");
				return installed[0] ? installed[0].overlay(this, entries) : entries;
			};
			state = { wrapper, owners };
			Object.defineProperty(proto, HOOK, { value: state });
			proto.getAllRegisteredTools = wrapper;
		}
		state.owners.set(handler, this);
	}

	private overlay(runner: ExtensionRunner, entries: Registry): Registry {
		if (!Array.isArray(entries) || entries.some((entry) => !entry?.definition?.name)) {
			throw new Error("pi-tools: incompatible Pi tool registry shape");
		}
		const ctx = runner.createContext();
		let view = this.runners.get(runner);
		if (!view) {
			view = { overrides: resolveEffectiveConfig(ctx.cwd, ctx.isProjectTrusted()).toolExposures, originals: new Map() };
			this.runners.set(runner, view);
		}
		view.originals.clear();
		this.sessions.set(ctx.sessionManager, view);
		return entries.map((entry) => {
			const definition = entry.definition;
			const original = exposureOf(definition);
			view.originals.set(definition.name, original);
			if (!isManageable({ ...definition, exposure: original, sourceInfo: entry.sourceInfo })) return entry;
			if (!Object.hasOwn(view.overrides, definition.name)) return entry;
			const exposure = configuredExposure(view.overrides, definition.name, original);
			// Explicit direct overrides activate on preference changes, not every /reload registration.
			// Otherwise upstream re-registration would revive a tool another extension deactivated.
			return { ...entry, definition: { ...definition, exposure,
				...(exposure === "direct" ? { defaultActive: false } : {}) } };
		});
	}

	view(ctx: ExtensionContext): ExposureView {
		const view = this.sessions.get(ctx.sessionManager);
		if (!view) {
			throw new Error("pi-tools: host registry hook did not run; exposure overrides are unavailable in this Pi runtime");
		}
		return view;
	}
}
