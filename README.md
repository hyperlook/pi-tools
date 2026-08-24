# pi-tools

给 Pi 用的按需工具加载扩展。会话开始扫一遍本机已注册工具：内置默认开，扩展工具默认关。目录写进 `enable_tool` 的 description / guidelines，**开场冻住、会话内不变**，避免按「当前失活名单」改 system prompt 打爆前缀缓存。完整 schema 出现在下一轮请求。

不把工具名写进源码。别人装这包、你自己再加一个扩展，下一场会话都会进目录。

## 能力

- **开场目录**：`getAllTools()` 里非内置、且不是 `enable_tool` 的，写进 loader 广告。这是已安装按需工具的快照，不是当前失活列表。你中途用 `/tools` 关掉某个已在目录里的工具，模型仍然看得到名字。
- **`/tools`**：TUI 开关任意工具。非内置的开集写入 `~/.pi/agent/pi-tools.json`，作为以后新会话的默认。内置开关只影响当前会话。`enable_tool` 本身不能关。
- **`enable_tool`**：模型按精确名或 query 激活未启用的工具（最短 3 字符、计分、最多 5 个）。只改当前会话，不改默认。激活是纯增量，走 Pi 的 deferred loading。
- **新会话默认**：内置始终开。还没用过 `/tools` 时，扩展工具全关。用过之后，按你上次手动开着的那批扩展工具来。新装的扩展工具会进目录，默认关，直到你打开或模型 `enable_tool`。
- **分支持久化**：当前会话状态存在 `tools-config` 自定义条目里，跟会话叶子走。`/tree` 切分支能还原。
- **缓存**：不按「当前未激活集合」改 system prompt。loader 始终在线。Anthropic 4.5+ / GPT-5.4+ 可走官方 deferred loading 保住前缀；Gemini 等走 fallback，tools 数组仍可能让对话前缀 miss。

这包会在 `session_start` 里收回扩展工具的 active 集。若要它说了算，把它放在 `packages` 列表后面。

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
| `/tools` | 打开工具开关面板（仅 TUI）。非内置的选择会记成新会话默认。 |

`~/.pi/agent/pi-tools.json` 由 `/tools` 自动写，一般不用手改。只含你想默认开的扩展工具名，不含内置。

## 开发

仓库在 `~/github/pi-tools`。Pi 核心包是 peer，不进本仓库的 `node_modules`。
