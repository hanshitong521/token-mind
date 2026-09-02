# ADR-0004: S4 六工具 MCP 层放在 contextmind/，不改 CC

- 状态：ACCEPTED（2026-09-02）
- 决策来源：DECISIONS-2026-09-01 决策 5C；总规范 v1.2 §9

## 背景

S4 要求对 Cursor 只暴露 6 个 MCP 工具（context_orient / find / get / impact / run / fetch），
内部 dispatch 到 CC 实现 + CodeGraph 实装探测。总规范 v1.2 §8 将落点写为
"CC 侧 `src/mcp/`"，本 ADR 记录实际落点的偏离及理由。

## 决策

六工具层实现在 **`contextmind/mcp-server.mjs` + `contextmind/lib/mcp-tools.mjs`**
（零 npm 依赖，手写 ~120 行 stdio JSON-RPC 循环），**不改 CC 任何代码**。

## 理由

1. 六工具的依赖（handles / telemetry / gate / config / tokens）全部住在 contextmind lib，
   进程内直接复用；放 CC 侧反而要跨包搬 .mjs 或走子进程。
2. CC 的调用路径已由先前 ADR 冻结为 **CLI 子进程**（engine.mjs，与 A/B 实测路径一致、
   数字可比），"dispatch 到 CC 实现"= 沿用该路径，不需要进程内 import CC。
3. 零依赖架构延续：MCP stdio 协议对本服务器只需 initialize / notifications / ping /
   tools/list / tools/call 五个方法，引入 MCP SDK 换来的是 npm 依赖 + zod schema，
   违反决策 1A 的轻量原则。
4. CC 旧 8 工具"不对 Agent 暴露"通过 **mcp.json 不注册 CC server** 达成（本来就没注册），
   无需删改 CC 的工具注册代码。

## CodeGraph 适配方式

走本机 `codegraph` CLI（v1.5.0 实测在 PATH，含 explore/query/impact/callers/callees），
不实现 MCP client。实装探测 = 运行时探测：CLI 不存在 → `ADAPTER_MISSING` 状态语义；
索引缺失 → `NO_INDEX`；任何失败都返回状态文本，禁止假装调用成功（决策 5C）。

## 后果

- 总规范 §8 的 "CC 侧 src/mcp/" 一句随本 ADR 修正为 contextmind 侧。
- 协议兼容性由 L4 契约测试覆盖（子进程 initialize → tools/list → tools/call 全链）。
- 若未来六工具需要 CC 进程内能力（如 execute 沙箱），再评估升格；届时需新 ADR。
