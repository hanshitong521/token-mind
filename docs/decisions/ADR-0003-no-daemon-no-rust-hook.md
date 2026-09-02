# ADR-0003: 本切片不做 daemon，也不做 Rust cmhook；提供 start/stop 即说谎

- 状态: Accepted
- 日期: 2026-09-01
- 关联: DECISIONS-2026-09-01 决策 6（SKIP Rust cmhook）、spec §7.2 / §27 / G4

## 背景

spec §27 要求 CLI 至少提供 `start` / `stop`；spec §7 架构图里有 daemon 与 Rust cmhook。决策 6 已明确 SKIP Rust cmhook（无延迟证据支撑）。

实测（docs/evidence/SLICE_S2_S3_BENCH.md §3）：hook p50 269ms，其中 **Node 进程启动占 172ms（64%）**，本层自身工作仅 ~74ms。daemon 化能省的是那 172ms，不是我们的 74ms。

## 决策

1. 不实现 daemon；hooks 是无状态子进程。
2. **不提供 `start` / `stop` 命令**。为一个不存在的守护进程提供启停命令，是两个"会跑但什么都不做"的占位符——spec §41 明令禁止把这类东西当完成证据。
3. CLI 提供的实际命令：`install / uninstall / doctor / status / report / gc / fetch / config / benchmark`。
4. G4 的 25ms 目标记 KNOWN_LIMITATION，原始数据在 evidence；若实机证明 269ms 不可接受，重启 T11（先测常驻 launcher，再议最薄 Rust bridge），而不是回头调 Node。

## 后果

- 换来：少一个常驻进程、少一套 IPC、少一类"daemon 挂了怎么办"的故障模式（spec §44 daemon down 一节整段不适用）。
- 代价：每次工具调用多 ~170ms 的进程启动税；G4 不达标。
- 触发重议的条件：实机会话出现可感知卡顿，或用户因延迟关掉治理层导致 savings 归零。
