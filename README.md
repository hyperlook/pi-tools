# pi-tools

给 Pi 用的按需工具加载扩展。新会话默认把重型工具（目前是 `image_gen` / `image_edit`）挂起；目录写在 `enable_tool` 的 description / guidelines 里，会话内不变，避免激活后改 system prompt 打爆前缀缓存。需要时模型调 `enable_tool`，完整 schema 出现在下一轮请求。人也可以用 `/tools` 手动开关。选择会写进当前会话分支，`/tree` 切分支能还原。

## 能力

- **默认挂起**：新会话不把 `image_gen`、`image_edit` 的参数 schema 打进每一轮请求。
- **缓存**：不按「当前未激活集合」改 system prompt。loader 始终在线，激活走纯增量 `setActiveTools`。Anthropic 4.5+ / GPT-5.4+ 可走官方 deferred loading 保住前缀；Gemini 等走 fallback，tools 数组仍可能让对话前缀 miss。
- **`enable_tool`**：按精确工具名激活；不知道名字时用 query（最短 3 字符、计分、最多 5 个）。激活是纯增量，走 Pi 的 deferred loading。
- **`/tools`**：TUI 面板开关工具。`enable_tool` 本身不能关。
- **分支持久化**：状态存在 `tools-config` 自定义条目里，跟会话叶子走。

## 安装

和 `pi-imagine`、`pi-web-search2` 一样，写进 `~/.pi/agent/settings.json` 的 `packages`：

```json
{
  "packages": [
    "../../github/pi-tools"
  ]
}
```

相对路径相对 `~/.pi/agent/settings.json`，解析到 `~/github/pi-tools`。

不要再把 `tools.ts` 拷进 `~/.pi/agent/extensions/`：那个目录会自动加载，和本包叠在一起会注册两次。

改完代码后在 Pi 里 `/reload` 即可，本地路径包不会复制，读的就是这个仓库。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/tools` | 打开工具开关面板（仅 TUI） |

## 开发

仓库在 `~/github/pi-tools`。Pi 核心包是 peer，不进本仓库的 `node_modules`。
