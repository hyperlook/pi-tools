# pi-tools

Pi 的**原生工具加载偏好面板**。在 `/tools` 中配置工具常驻或按需，让 Pi 自带的 `tool_search` 负责发现和加载，不再维护另一套调度器。

需要 Pi 1.0+；已在 Pi 1.0.4 SDK 上验证。

## 安装

```bash
pi install git:github.com/hyperlook/pi-tools
```

## 三种状态

| 状态 | 行为 |
| :--- | :--- |
| **跟随扩展**（默认） | 不覆盖 Pi 或扩展的当前加载状态，配置中不保存此工具的覆盖项。 |
| **常驻** | 应用偏好时向模型提供工具的完整 schema。 |
| **按需** | 应用偏好时从模型声明中移出，由原生 `tool_search` 搜索并加载。 |

只有原生支持搜索的 **`deferred` / `codemode` 工具**可以编辑。扩展工具和 MCP 工具均可使用，不限于 MCP。

```text
/tools 或配置文件
       ↓
应用显式加载偏好
       ↓
Pi tool_search → 下一助手回合获得 schema → 执行
```

### 边界

- 本扩展**不注册任何模型工具**，不更改工具 exposure，不接管执行函数。
- `direct` / `model-only` 工具只读展示：它们不在原生搜索池中，需要工具所属扩展主动适配。`model-only` 的嵌套调用边界不变。
- 内置工具、`tool_search`、`codemode` 调度工具由 Pi 的 `defaultTools` / CLI 管理；`hidden` 工具不会被重新开放。
- CLI 排除或未注册的工具不会被拉回来。
- **按需不是禁用**。`deferred` / `codemode` 工具仍然可以从脚本调用；`codemode` 工具的目录行为也保持原样。
- 偏好只在首次应用、模式变化或工具首次出现时调整声明。不反复重置 active 集合：原生搜索加载的工具在当前分支中保持可用，其他扩展的运行时停用不会被覆盖。
- 切回“跟随扩展”只释放控制，**不会撤销当前会话已经加载的工具**；新会话按 Pi / 扩展的默认选择启动。

当你明确配置原生工具为按需时，面板会激活**已注册的** `tool_search`。若其被禁用或被 CLI 排除，会提示你加载 `builtin:tool-search` 并允许 `tool_search`；本扩展不会注册替代品。

## 管理面板

在 Pi TUI 中输入 `/tools`。

| 按键 | 说明 |
| :--- | :--- |
| **↑ / ↓** 或 **j / k** | 浏览工具 |
| **Space** | 跟随扩展 → 常驻 → 按需 → 跟随扩展 |
| **Tab** | 切换 Global / Project 配置作用域 |
| **r** | 项目配置恢复继承全局（保存后生效） |
| **Enter** | 保存并应用偏好 |
| **Esc / q** | 放弃草稿 |

面板分别显示**加载偏好**与**当前是否已声明**。“按需 · 已声明”表示工具已经由 Pi 加载，不是配置失效。

## 配置文件

- 全局：`~/.pi/agent/pi-tools.json`（遵循 `PI_CODING_AGENT_DIR`）
- 项目：`<project>/.pi/pi-tools.json`
- `PI_TOOLS_CONFIG`：指定唯一配置文件，优先于以上路径

```json
{
  "toolModes": {
    "mcp__docs__search": "on-demand",
    "mcp__docs__read": "always"
  }
}
```

未列出的工具跟随扩展；也可以显式写 `"inherit"`，保存时会省略。项目文件**整体替代**全局偏好；`{"toolModes": {}}` 表示项目所有工具跟随扩展，删除项目文件则恢复继承全局。未信任项目只读取全局配置。

修改文件后，在下一条请求前生效；`/reload` 也会读取。暂时断开的 MCP 或尚未加载的工具偏好会保留。

本扩展仅持久化“哪些偏好已应用”，不保存或恢复 active 工具快照。工具搜索后的分支状态、`/tree`、恢复会话和 fork 由 Pi 管理。

### 2.0 破坏性变更

`enable_tool`、旧待命目录、冻结基线和自研会话激活逻辑已删除。旧 `disabledTools` 配置和 `tools-config` 会话条目**不再读取，也不迁移**；请通过新面板重新选择，或改用 `toolModes` 格式。

## 开发与验证

```bash
bun test
bun run check
```

SDK 集成测试不发起模型请求。可用另一个已安装的 Pi 运行相同测试：

```bash
PI_TOOLS_TEST_HOST=/path/to/pi-coding-agent/dist/index.js bun test test/integration.test.ts
```

## License

[MIT](LICENSE)
