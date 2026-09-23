# pi-tools

Pi 编码助手的**按需工具加载与管理扩展**（Deferred Tool Loader & Manager）。

会话开始时自动扫描本机所有已注册工具：**内置工具默认开启，第三方/自定义扩展工具默认全量可用（零破坏开箱即用）**。用户可在 `/tools` 面板中自主将不需要常驻的扩展工具失活挂起；当存在失活工具时，插件会自动向模型提供轻量级的 `enable_tool` 调度工具，在任务需要时增量激活，既削减 Prompt Token 占用，又保护 LLM 的前缀缓存（Prompt Cache）。

---

## 核心特性

- ⚡ **节省 Context & 保护前缀缓存**：
  - 目录在会话开场时生成并冻结在 `enable_tool` 的描述中，**会话内不再按「实时失活名单」动态改动 System Prompt**，避免破坏 Anthropic / OpenAI / DeepSeek 等模型的前缀缓存。
- 🔍 **智能按需激活（`enable_tool`）**：
  - 模型可根据任务需求，通过**精确名称**或**关键词语义检索**（query 计分）按需激活目标工具。
  - 激活为纯增量模式，完整参数 Schema 在下一轮请求生效。
- 🎛️ **交互式管理（`/tools`）**：
  - 提供可视化的 TUI 开关面板。
  - 支持 **Project（项目级）** 与 **Global（全局级）** 自由切换（按 `Tab` 键切换保存目标）。
  - 手动调整非内置工具的开关会自动持久化到对应作用域，作为后续新会话的默认设置。
  - 深度联动 Pi 原生 **Project Trust** 安全机制，严格防护项目级配置加载。
- 🌿 **支持会话分支持久化**：
  - 会话激活状态与会话树（`/tree`）分支严格绑定，切换分支自动恢复对应的工具状态。
- 🌐 **环境无缝兼容**：
  - 基于标准 Node.js / Web 规范开发，无论是 **Node.js** 环境还是 **Bun** 环境运行的 Pi，均可直接即插即用，无需预编译。

---

## 安装与配置

### 方式 1：使用 Pi CLI 命令一键安装（推荐）

```bash
pi install git:github.com/hyperlook/pi-tools
```

> 如果需要临时试用而不写入全局配置：
> ```bash
> pi -e git:github.com/hyperlook/pi-tools
> ```

### 方式 2：在 `settings.json` 中配置

在 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）的 `packages` 中添加：

```json
{
  "packages": [
    "git:github.com/hyperlook/pi-tools"
  ]
}
```

> **提示**：建议将 `pi-tools` 放置在 `packages` 列表的**靠后位置**，确保它在 `session_start` 时能完整扫描到先加载的其他扩展所注册的工具。

---

## 使用指南

### 1. 交互指令 `/tools`
在 TUI 模式下输入 `/tools` 回车，即可呼出工具管理面板：
- 使用方向键与空格/回车切换工具状态（`enabled` / `disabled`）。
- **按 `Tab` 键切换保存目标（Scope）**：
  - **`[Project]`**：写入 `<cwd>/.pi/pi-tools.json`，仅在当前项目生效，便于随代码仓库共享。
  - **`[Global]`**：写入 `~/.pi/agent/pi-tools.json`，在所有未指定项目级配置的项目中作为默认值。
- **内置核心工具**（如 `read`, `bash`, `edit`, `write`）：完全归 Pi 官方托管，在面板中**灰显锁定且只读**（标注 `pi native`），本插件彻底不碰、不改、不持久化，杜绝操作困惑与误触。
- **按需调度器 `enable_tool` & 扩展工具**：主动失活（Opt-out）机制。按空格自由开/关并持久化到当前作用域（Project / Global）。当无配置文件时，失活列表为空，用户的所有工具默认保持启用（对新安装用户 0 破坏）；仅当用户主动在面板中关闭某个工具时，才会将其写入失活名单转入按需挂起池。

### 2. 模型自动激活
当 LLM 发现当前激活的工具无法满足任务需求时，会主动调用 `enable_tool`：
- **精确指定**：如 `enable_tool(tool_names: ["web_search", "url_context"])`
- **意图检索**：如 `enable_tool(query: "search the web")`
- 激活后，工具参数 Schema 会在下一轮请求中自动就绪。

---

## 本地开发与贡献

### 源码链接安装（本地调试）

如果你正在本地修改本插件源码，可将本地相对路径或绝对路径加入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "../../github/pi-tools"
  ]
}
```
*(相对路径相对于 `settings.json` 所在目录)*

修改源码后，在 Pi 会话中直接执行 `/reload` 即可热重载。

### 依赖与环境
- **运行时环境**：Node.js >= 18 或 Bun。
- **类型检查**：
  ```bash
  bun x tsc --noEmit
  # 或
  npx tsc --noEmit
  ```

---

## 配置文件与多层级支持

`pi-tools` 严格遵循 Pi 的多层级配置与覆盖设计：

| 优先级 | 作用域 | 路径 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 (最高) | 环境变量 | `$PI_TOOLS_CONFIG` | 显式指定配置文件路径（常用于临时调试） |
| 2 | 项目级 | `<project>/.pi/pi-tools.json` | 针对当前项目的专属配置，**覆盖全局配置** |
| 3 | 全局级 | `~/.pi/agent/pi-tools.json` | 跨项目的全局兜底偏好 |

### 覆盖策略与安全性
1. **项目覆盖全局（Project Overrides Global）**：当受信任的项目存在 `.pi/pi-tools.json` 时，新会话将优先使用该项目配置中指定的失活工具名单（`disabledTools`），未配置或未受信任时回退到全局配置。
2. **Project Trust 安全联动**：未被信任的项目不会加载其 `.pi/pi-tools.json`，自动降级使用全局配置。
3. **配置文件格式**：
```json
{
  "disabledTools": [
    "quarkclouddrive",
    "imagine"
  ]
}
```
> 若某个项目需要保持零扩展工具纯净沙箱环境，可将不需要的工具或 `enable_tool` 加入 `disabledTools`。

## 开源协议

[MIT License](LICENSE)
