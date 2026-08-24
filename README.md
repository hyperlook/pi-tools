# pi-tools

Pi 编码助手的**按需工具加载与管理扩展**（Deferred Tool Loader & Manager）。

会话开始时自动扫描本机所有已注册工具：**内置工具默认开启，第三方/自定义扩展工具默认挂起（按需加载）**。通过向模型提供轻量级的 `enable_tool` 调度工具，在需要时增量激活具体工具，大幅削减 Prompt Token 占用，并保护 LLM 的前缀缓存（Prompt Cache）。

---

## 核心特性

- ⚡ **节省 Context & 保护前缀缓存**：
  - 目录在会话开场时生成并冻结在 `enable_tool` 的描述中，**会话内不再按「实时失活名单」动态改动 System Prompt**，避免破坏 Anthropic / OpenAI / DeepSeek 等模型的前缀缓存。
- 🔍 **智能按需激活（`enable_tool`）**：
  - 模型可根据任务需求，通过**精确名称**或**关键词语义检索**（query 计分）按需激活目标工具。
  - 激活为纯增量模式，完整参数 Schema 在下一轮请求生效。
- 🎛️ **交互式管理（`/tools`）**：
  - 提供可视化的 TUI 开关面板。
  - 手动调整非内置工具的开闭状态会自动记入全局偏好（`~/.pi/agent/pi-tools.json`），作为后续新会话的默认设置。
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
- **非内置工具**的开关会被持久化为全局默认偏好。
- **内置核心工具**（如 `read`, `bash`, `edit`, `write`）的调整仅影响当前会话。
- `enable_tool` 自身始终保持开启，不可禁用。

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

## 配置文件说明

- `~/.pi/agent/pi-tools.json`：保存用户通过 `/tools` 选定的「默认开启的扩展工具列表」。文件由面板自动维护，通常无需手动编辑。

## 开源协议

[MIT License](LICENSE)
