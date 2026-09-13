# ADR-0014 — TokenMind as Agent Context OS (Runtime + Policy + Evidence + Adapters)

- 状态: Accepted
- 日期: 2026-09-11
- 取代: [ADR-0003](ADR-0003-no-daemon-no-rust-hook.md)、[ADR-0006](ADR-0006-resident-hookd.md)（resident 空 stub 禁令保留并升级）
- 不取代: [ADR-0006-windows-codegraph-ps1-spawn.md](ADR-0006-windows-codegraph-ps1-spawn.md)（编号碰撞，内容无关）

## 背景

ADR-0003 拒绝 daemon，是因为当时没有常驻实现、只有 spawn 税（hook p50≈200ms+，其中 Node 启动占大头）。ADR-0006 关闭 resident hookd，是因为空 stub 客户端在 Windows 上把暖路打到 ≈5s 并卡住会话。

触发已满足：空 stub / 假 start-stop 不可再出现。本切片实现**真实** TokenMind Runtime（localhost HTTP），thin hook **禁止** import `cm-lib`。Rust cmhook 本切片仍不做。

## 决策

TokenMind 定位为 **Agent Context Operating System**：只决定 AI 看到什么、多少、何时看到。

四层（禁止把 policy/budget/git/session 塞进一个无法替换的胖进程）：

1. **Runtime**（仅）：生命周期、RPC、请求路由、cache、telemetry。本机一个进程，默认 `127.0.0.1:18787`。请求带 `project_id` / `session_id` / `client`。
2. **Policy Engine**：Adaptive Hook、Output Level、Budget、Awareness。可换，不改 Runtime 核心。
3. **Evidence Layer**：压缩前闸门。Policy 不得绕过。P0 永不压缩。
4. **Adapters**：git / shell / read / grep / MCP。Git 摘要缓存 = Adapter + Runtime Cache，不是 Tool Gateway。

异常路径：RPC 失败 → retry 1 → **minimal mode**（thin 本地 allow + 体积硬帽，不加载 `cm-lib`）+ telemetry FAIL → **不中断 Agent**。禁止空 stub 客户端（会挂）。禁止把 `start`/`stop` 做成无进程占位符。

`sessionStart` = health + 若 down 则拉起 daemon。工具路径禁止 spawn/import `cm-lib`。

冻结不做：AgentOS / Tool Gateway / workflow / 多 Agent 调度 / Memory 系统；不替代 Brain、CodeGraph、TestMind。Output Gate 保真/ABSTAIN 仍是压缩皮带。

## Token Saving Score

相对同一任务 Phase 0：

- `InputReduction` = 1 − (emitted_input_tokens / baseline_input_tokens)
- `ToolReduction` = 1 − (tool_calls / baseline_tool_calls)
- `ReuseRate` = cache_hits / cache_lookups（目标 ≥50%）

`TokenSavingScore = 0.4*InputReduction + 0.3*ToolReduction + 0.3*ReuseRate`

**正确率一票否决**：任一 P0 证据丢失 → Score 记为 `invalid`，不得宣传节省。

生产级同时要求（本切片未宣称）：Input ↓30–50%；Tool ↓≥30%；Reuse ≥50%；暖路 p50<20 / p95<50 / p99<100；Replay≥50 真实任务。未达标必须记 FAIL/KNOWN + 原始数字。

## 后果

- 换来：暖路可去掉 Node+cm-lib 启动税；CLI `start`/`stop`/`doctor` 对应真进程。
- 代价：本机常驻 Node；daemon 挂了必须 fail-open 到 minimal，而不是卡住。
- RSS 空闲 <10MB 为生产目标；测不到则 KNOWN + 理由。
