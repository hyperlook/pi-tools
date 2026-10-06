# pi-tools

Pi 的**工具 exposure 管理面板**。在 `/tools` 中直接切换扩展工具的 `direct / codemode / deferred` 属性；没有填写 exposure 的普通工具也能管理，不需要工具作者先适配。

已验证 Pi **1.0.0 / 1.0.4**。本插件使用一个非官方的注册适配入口，后续 Pi 版本需要重新验证。

## 安装

```bash
pi install git:github.com/hyperlook/pi-tools
```

## 三种状态

| Exposure | 原生行为 |
| :--- | :--- |
| **direct** | 激活时直接向模型声明完整 schema；激活期间可由脚本调用。 |
| **codemode** | 注册后可由脚本调用，并进入原生 codemode 的工具目录；也可以搜索加载。 |
| **deferred** | 注册后可由脚本调用，不列入 codemode 目录，由原生 `tool_search` 发现、加载。 |

没有覆盖项时，保留工具作者的属性；作者未填写则为 `direct`。面板中没有第四种“跟随扩展”状态，可用 **d** 清除覆盖、恢复作者定义。

**这些选择实际改变 exposure，不只是隐藏 schema。** 选 direct 时在应用配置转换时激活；选 codemode / deferred 时移出模型声明。原生搜索加载后的工具在当前上下文保持激活（●）；面板通过状态指示灯（●/○）与 exposure 属性清晰区分当前上下文挂载状态与工具配置。

## 管理面板

在 Pi TUI 中输入 `/tools`。

| 按键 | 行为 |
| :--- | :--- |
| **↑ / ↓** 或 **j / k** | 浏览工具 |
| **PgUp / PgDn** | 按当前可见条数翻页 |
| **Home / End** | 跳到第一个 / 最后一个工具 |
| **← / →** 或 **Space** | 上一个 / 下一个模式（direct → codemode → deferred） |
| **d** | 清除当前层对所选工具的覆盖项（仅在有覆盖时显示） |
| **r** | 清空全部项目覆盖，回到继承全局（仅 Project 层且有覆盖时显示） |
| **Tab** | 切换正在编辑的层：Global / Project |
| **Enter** | 保存、关闭面板，然后自动重载（显示待保存改动数） |
| **Esc / q** | 放弃草稿，不写文件、不重载 |

每行显示 `模式` 与 `来源`（default / global / project）。重载前的实际状态与目标不同时显示 `live → target`。`●/○` 表示当前是否已加载进上下文。不可编辑的工具（内置、调度工具、受保护项）排在可编辑工具之后，来源列标注 `locked`，表头显示两类工具的总数。

列表采用固定高度的滚动窗口，**最多显示 12 个工具**；小终端自动减少可见条数，为详情与操作提示留出空间。下分隔线显示当前范围 / 总数和上下方是否还有工具。选中项越过窗口边缘才滚动，不会一次展开全部工具。详情描述只显示单行首句，过长截断；切换工具、锁定状态或操作提示不会改变面板高度。低于 22 行时采用紧凑布局，隐藏配置路径和次要详情；低于 15 行时提示扩大终端。

## 实现边界

```text
原插件注册定义
       ↓
pi-tools 应用 exposure 覆盖
       ↓
Pi 原生声明 / codemode / tool_search / 执行
```

- 唯一内部适配点在 `src/exposure-adapter.ts`：覆盖 `ExtensionRunner.getAllRegisteredTools()` 返回的定义，**不修改原定义、不包装执行函数**。schema、执行函数、渲染器、namespace 等保留原引用。
- 适配器通过本插件命令 handler 的身份识别运行时。未加载本插件的会话、重载后关闭本插件的会话直接返回原注册结果；同一进程中的其他会话不受影响。
- 没有配置的工具不会被接管。用户显式配置的 direct 工具由配置转换激活，抑制重载时的注册自动激活，避免覆盖其他扩展的运行时停用。
- 内置工具、`tool_search` / `codemode` 调度工具、`model-only`、`hidden` 受保护，不能作为普通工具转换。SDK `customTools` 不经过此扩展注册入口，同样只读。
- 尊重 Pi 的 CLI 筛选，不复活已排除或不存在的工具；暂时未注册的工具覆盖项会保留。
- 需要搜索或脚本目录时，激活**已注册的**原生调度工具。缺失时显示提示，不注册替代品，不提供 `enable_tool`。
- 不循环重置 active 集合、不保存工具集合快照。Pi 继续负责执行、权限检查、搜索加载、会话分支和 transcript。
- 宿主方法缺失、其他适配器覆盖入口、实际工具属性与配置不一致时，**明确报错**，不进行假切换。

## 配置文件

- 全局：`~/.pi/agent/pi-tools.json`（遵循 `PI_CODING_AGENT_DIR`）
- 项目：`<project>/.pi/pi-tools.json`
- `PI_TOOLS_CONFIG`：指定唯一配置文件，优先于以上路径

```json
{
  "toolExposures": {
    "web_search": "deferred",
    "image_gen": "codemode",
    "project_info": "direct"
  }
}
```

配置分三层，按工具逐项解析：**作者定义 → 全局 → 项目**。项目文件只保存它覆盖的工具，其余继承全局；全局之后的修改会自然反映到项目。面板保存时若项目没有任何覆盖，会删除项目文件。未信任项目只读取全局配置。

**手动修改文件后需要 `/reload`。** 每个运行时在注册时读取配置并固定下来，避免某个 MCP 连接或延迟注册意外提前应用尚未重载的文件修改。

旧 `disabledTools` / `toolModes` 配置、旧会话策略条目不读取、不迁移。请使用新面板重新选择，或改成 `toolExposures` 格式。

## 开发与验证

```bash
bun test
bun run check
```

集成测试不发起模型请求，使用 Pi 的真实文件扩展加载器。默认将发行的源码放进不带仓库 devDependencies 的临时目录，模拟正常包安装。

用另一份已安装 Pi 运行相同测试：

```bash
PI_TOOLS_TEST_HOST=/path/to/pi-coding-agent/dist/bundle/index.js \
  bun test test/integration.test.ts
```

用 CLI 同源的 bundled SDK 测试当前仓库源码：

```bash
PI_TOOLS_TEST_HOST=/path/to/pi-coding-agent/dist/bundle/index.js \
PI_TOOLS_TEST_SOURCE="$PWD/src/index.ts" \
  bun test test/integration.test.ts
```

使用 unbundled SDK 且源码目录带另一版本的 Pi devDependency 时，Bun 的 native import 可能绕过宿主别名，载入另一份 `ExtensionRunner`。此时适配器会明确报错；应使用上述隔离包加载方式或宿主的 bundled SDK，不能把未生效的覆盖当成功。

## License

[MIT](LICENSE)
