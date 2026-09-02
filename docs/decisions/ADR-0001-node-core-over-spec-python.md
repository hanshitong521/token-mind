# ADR-0001: 采用 Node/TS context-compress 作为 ContextMind 核心引擎（偏离 spec §7.1）

- 状态：Accepted
- 日期：2026-09-01
- 决策人：owner（grill 会话拍板，编号 1A）
- 关联规范：《ContextMind — AI 一体化开发与极致上下文优化总规范》v1.1 §7.1、§51.3

## 背景

spec §7.1 冻结推荐栈为 Python 3.13（Serena/Headroom 生态兼容、MCP SDK 成熟）。但仓库 Token-Mind 的现状是：

1. context-compress（Node/TS）已实现：8 个 MCP 工具、ContentStore（better-sqlite3）、过滤管线、结构化 adapter（pytest/jest/gradle/maven）、setup/doctor/uninstall、46 个测试文件、bench 三份报告（含 shejiuPro 实机 A/B）。
2. shejiuPro 现网 hooks（gate-pre-tool.mjs 等）已是 .mjs，实现 spec §15 Read Guard 主体。
3. spec §51.3（最高纪律）："先复用成熟能力，后自研"；§8："目录不是越多越好"。

## 决策

1. 以 Token-Mind 内 Node/TS context-compress 为 ContextMind 核心引擎，向 spec §0.3 切片 S2→S3→S4→S8 演进。
2. **禁止**新建平行 `src/contextmind/` Python 引擎重写。
3. Python 保留 Save-The-Token（预算/doctor）与 telemetry/report CLI 等已存在或更适合的部分。
4. 偏离 §7.1 由本 ADR 记录；spec 其余架构原则（6 工具、Hook 强制、Handle、预算、去重、三列账）不变。

## 后果

- 优点：复用已实测管线与测试；shejiuPro hooks 无缝迁移；交付提速。
- 代价：放弃 Serena/Headroom Python 生态的天然互操作（Serena 本轮 SKIP，见 ADR-0003）；MCP SDK 用 TS 版。
- 回退：若 TS 管线在 Gate 实测中证明无法满足正确性/性能，可重议本 ADR，重写须 owner 批准。
