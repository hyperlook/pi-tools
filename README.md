# pi-tools

Pi 编码助手的**按需工具加载与管理扩展**。

扩展工具装多了挤占 Context 和 Prompt Cache？`pi-tools` 让工具**按需激活**：平时待命削减 Token 消耗，模型在执行任务时自动调出，并提供 `/tools` 可视化管理面板。

---

## 快速安装

```bash
pi install git:github.com/hyperlook/pi-tools
```

---

## 它是怎么工作的？

- **内置工具常驻**：`read`、`bash`、`edit`、`write` 等 Pi 原生核心工具由 pi 命令自行管理（`settings.json` 的 `defaultTools`）。
- **扩展工具按需激活**：未激活的扩展工具收敛为待命目录，当任务需要时，模型会自动调用 `enable_tool` 增量激活。新工具在**同一次用户请求的下一助手回合**带上完整 Schema，不用用户再发一条消息。
- **零破坏开箱即用**：首次安装默认全量可用，仅将你主动在面板中停用的工具转入待命池。
- **不抢 Pi 的决定**：本扩展只在 Pi 自己的启动集合上做减法，`defaultTools` / `--tools` / `--exclude-tools` 关掉的工具不会被重新拉回。
- **不越权上游工具**：`deferred` / `codemode` 由 Pi 1.0 的 `tool_search` 与 `codemode` 接管，`hidden` 只是注册了但不可达。面板中以 `[upstream]` 只读展示，不进入待命池。需要 Pi 1.0+。

---

## 使用方式

### 1. 模型自动激活（无需人工干预）
当你给出的任务需要某个停用工具时，模型会自动通过工具名或意图关键词将其唤醒：
> *例如：模型需要检索网络时，会自动调度 `enable_tool(["web_search"])`。*

### 2. 管理面板 `/tools`
在 Pi 的 TUI 聊天输入框中输入 `/tools` 回车，即可打开管理面板：

| 按键 | 说明 |
| :--- | :--- |
| **`↑` / `↓`** 或 **`j` / `k`** | 浏览工具列表 |
| **`Space`** | 切换工具状态（启用 / 待命） |
| **`Tab`** | 切换配置作用域：**[Project]** 或 **[Global]** |
| **`r`** | 项目级配置一键恢复继承全局偏好 |
| **`Enter`** | 保存修改生效并同步当前会话 |
| **`Esc`** / **`q`** | 放弃修改并退出面板 |

---

## 配置文件（可选进阶）

如果你更偏好直接通过文件维护，可在以下路径手动编辑：

- **项目级**（优先）：`<project>/.pi/pi-tools.json`
- **全局级**（兜底）：`~/.pi/agent/pi-tools.json`

```json
{
  "disabledTools": [
    "quarkclouddrive",
    "imagine"
  ]
}
```

> **提示**：未信任的项目（Untrusted Project）会自动降级仅使用全局配置，保障安全。进行中的会话会在下一条消息前重新读取这个文件，resume 同样以磁盘为准。`enable_tool` 只改当前分支，不写回配置；在 `/tools` 里保存会按磁盘策略重置这条会话增量。

---

## License

[MIT](LICENSE)
