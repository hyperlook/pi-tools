# pi-tools

给 Pi 用的按需工具加载扩展。新会话默认把重型工具（目前是 `image_gen` / `image_edit`）挂起，只把名字写进 system prompt；需要时模型调 `enable_tool` 再把完整 schema 加进下一轮请求。人也可以用 `/tools` 手动开关。选择会写进当前会话分支，`/tree` 切分支能还原。

## 能力

- **默认挂起**：新会话不把 `image_gen`、`image_edit` 的参数 schema 打进每一轮请求。
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
