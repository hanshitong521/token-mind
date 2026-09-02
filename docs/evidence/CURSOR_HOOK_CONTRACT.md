# Evidence: Cursor Hook contract (verified 2026-09-01)

- 采集时间: 2026-09-01
- 来源: https://cursor.com/docs/hooks （官方文档全文抓取，非凭记忆）
- 用途: ContextMind hooks 的实现依据；同时记录现网 hook 与契约不符的发现

## 1. 关键契约事实（逐条与实现对应）

| 事实 | ContextMind 落点 |
|---|---|
| `preToolUse` 输出 `{permission, user_message, agent_message, updated_input}` | `cm-pre-tool.mjs` |
| 退出码 2 也可阻断，但此时 JSON 不承载决策 → 统一 exit 0 + payload 表态 | 全部 hook |
| `postToolUse` 是唯一能改写模型所见输出的 hook，且仅限 MCP 工具，字段 `updated_mcp_tool_output` | `cm-post-tool.mjs` |
| MCP 工具的 matcher 必须写 `MCP:<tool_name>` | `install-plan.mjs` HOOK_ENTRIES |
| `postToolUse` 输入字段是 `tool_output`（字符串化结果负载） | `mcp-guard.mjs extractText` |
| `afterMCPExecution` 有 `result_json` 但文档未定义任何输出字段 → 只能观测、不能治理 | 未使用 |
| `afterShellExecution` 无输出字段 → Shell 输出治理只能靠 `preToolUse` 改写命令 | `shell-guard.mjs` |
| `beforeReadFile` 有 `content` 但输出只有 `permission/user_message`，没有 `agent_message` → 无法给 Agent 下一步指引 | 未用作守卫主通道 |
| `sessionStart` 输出 `{env, additional_context}` | `cm-session-start.mjs` |
| `stop` 输出 `{followup_message}`，`loop_count`/`loop_limit` 可控循环 | `cm-stop.mjs` |
| 公共字段含 `conversation_id`（跨轮稳定）、`workspace_roots` | `runtime.mjs sessionIdOf/projectRootOf` |
| 环境变量 `CURSOR_PROJECT_DIR`、`CLAUDE_PROJECT_DIR` | 同上 |
| `failClosed` 默认 false | 全部为 false（治理层不得放大故障） |

## 2. 发现：现网 `gate-mcp-output.mjs` 很可能从未生效

shejiuPro `.cursor/hooks.json` 注册：

```json
{ "command": ".cursor/hooks/gate-mcp-output.cmd",
  "matcher": "mysql_query|semantic_search|get_evidence",
  "failClosed": false }
```

两个与契约不符之处：

1. **matcher 缺 `MCP:` 前缀** —— 文档明确 MCP 工具的 matcher 形如 `MCP:<tool_name>`，裸工具名匹配不到。
2. **读取字段是 `mcp_tool_output`** —— `postToolUse` 的输入字段名是 `tool_output`；`gate-mcp-output.mjs:32` 的候选列表里没有 `tool_output`，即使 hook 被触发也取不到载荷。

结论：该 hook 在现网是死配置。S3 的 MCP Output Guard（`cm-post-tool.mjs`）用正确 matcher 与字段重写；旧 hook 在迁移时从 hooks.json 摘除。

## 3. 未确认项

- `postToolUse` 的 `updated_mcp_tool_output` 接受的具体形态（对象/数组/字符串）文档只写 "object (optional)"。实现按"输入是什么形态就回什么形态"处理（`mcp-guard.mjs rewrap`），实机验证列入 SLICE_REPORT 的待办。
- `sessionStart` 是否在云代理只读轮次触发：文档说暂不支持；本切片不做云代理场景。
