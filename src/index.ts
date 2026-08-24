/**
 * 按需启用工具：
 * 1. 把未激活工具的短描述写进 system prompt，模型不用猜名字。
 * 2. `enable_tool` 按精确名或 query 激活（纯增量，走 deferred loading）。
 * 3. `/tools` TUI 给人手动开关。
 * 4. 选择跟会话分支走。
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ToolsState {
	enabledTools: string[];
}

const DEFERRED_BY_DEFAULT = new Set(["image_gen", "image_edit"]);
const LOADER_TOOL_NAME = "enable_tool";
const QUERY_MIN_TOKEN = 3;
const QUERY_LIMIT = 5;

export default function toolsExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	/** TUI / 会话恢复：整表替换。loader 执行期间不要走这条。 */
	function replaceActiveTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t) => allToolNames.includes(t)));
			enabledTools.add(LOADER_TOOL_NAME);
			replaceActiveTools();
		} else {
			const currentActive = pi.getActiveTools();
			enabledTools = new Set(
				currentActive.filter((name) => !DEFERRED_BY_DEFAULT.has(name)),
			);
			enabledTools.add(LOADER_TOOL_NAME);
			replaceActiveTools();
		}
	}

	function getInactiveTools(): ToolInfo[] {
		allTools = pi.getAllTools();
		const activeNames = pi.getActiveTools();
		return allTools.filter(
			(t) => t.name !== LOADER_TOOL_NAME && !activeNames.includes(t.name),
		);
	}

	function firstSentence(text: string | undefined): string {
		if (!text) return "";
		const match = text.match(/^.+?(?:。|\.(?:\s|$)|$)/);
		return (match?.[0] ?? text).trim();
	}

	function matchByQuery(inactive: ToolInfo[], query: string): ToolInfo[] {
		const tokens = query
			.toLowerCase()
			.split(/[\s,._-]+/)
			.filter((tok) => tok.length >= QUERY_MIN_TOKEN);
		if (tokens.length === 0) return [];

		return inactive
			.map((tool) => {
				const searchable = `${tool.name} ${tool.label || ""} ${tool.description || ""}`.toLowerCase();
				const score = tokens.reduce(
					(sum, tok) => sum + (searchable.includes(tok) ? 1 : 0),
					0,
				);
				return { tool, score };
			})
			.filter((row) => row.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, QUERY_LIMIT)
			.map((row) => row.tool);
	}

	pi.registerTool({
		name: LOADER_TOOL_NAME,
		label: "Enable Tool",
		description: "Activate inactive tools by name or task query when their capability is needed.",
		promptSnippet: "Activate inactive tools by name when needed",
		promptGuidelines: [
			"Check the inactive tools list in system prompt. When the user asks for a capability (e.g. image generation/editing), call enable_tool with exact tool_names before use. Newly enabled tools are available on the next model request only — do not call them in the same assistant message as enable_tool.",
		],
		parameters: Type.Object({
			tool_names: Type.Optional(Type.Array(Type.String(), {
				description: "Exact names of inactive tools to activate (e.g. ['image_gen'])",
			})),
			query: Type.Optional(Type.String({
				description: "Task description/keyword if exact tool name is not known (e.g. 'draw', 'picture')",
			})),
		}),
		async execute(_toolCallId, params) {
			const inactive = getInactiveTools();
			const toEnable: ToolInfo[] = [];

			if (params.tool_names && params.tool_names.length > 0) {
				for (const name of params.tool_names) {
					const found = inactive.find((t) => t.name.toLowerCase() === name.toLowerCase());
					if (found && !toEnable.includes(found)) {
						toEnable.push(found);
					}
				}
			}

			if (params.query) {
				for (const tool of matchByQuery(inactive, params.query)) {
					if (!toEnable.includes(tool)) toEnable.push(tool);
				}
			}

			if (toEnable.length === 0) {
				const available = inactive
					.map((t) => `${t.name}: ${firstSentence(t.description).slice(0, 60)}`)
					.join("; ") || "none";
				return {
					content: [{
						type: "text",
						text: `No matching inactive tools found. Inactive tools available: [${available}].`,
					}],
					details: { requested: params, enabled: [] },
				};
			}

			const active = pi.getActiveTools();
			const added = toEnable
				.map((t) => t.name)
				.filter((name) => !active.includes(name));
			for (const name of added) enabledTools.add(name);
			// 必须纯增量，Pi 才走 deferred loading / 前缀缓存。
			pi.setActiveTools([...new Set([...active, ...added])]);
			persistState();

			const enabledList = added.join(", ");
			return {
				content: [{
					type: "text",
					text: `Successfully enabled tool(s): ${enabledList}. Their parameter schemas will be available on the next model request. Do not call them in this same assistant message.`,
				}],
				details: { enabled: added },
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		const inactive = getInactiveTools();
		if (inactive.length === 0) return;

		const listStr = inactive
			.map((t) => `• \`${t.name}\`: ${firstSentence(t.description)}`)
			.join("\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Inactive Tools (Call \`${LOADER_TOOL_NAME}\` to activate on demand)\n${listStr}`,
		};
	});

	pi.registerCommand("tools", {
		description: "打开面板查看、启用或停用工具",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools 只能在 TUI 模式使用", "error");
				return;
			}

			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name === LOADER_TOOL_NAME ? `${tool.name} (auto-loader)` : tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Tool Configuration")),
								theme.fg("muted", "开关工具。enable_tool 会按需自动激活，且不能关闭。"),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 3, 16),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === LOADER_TOOL_NAME) {
							enabledTools.add(LOADER_TOOL_NAME);
							replaceActiveTools();
							persistState();
							return;
						}
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						replaceActiveTools();
						persistState();
					},
					() => {
						done(undefined);
					},
				);

				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
