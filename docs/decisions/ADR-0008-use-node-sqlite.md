# ADR-0008: Use node:sqlite（不引入 better-sqlite3）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（Prompt Lab 第一轮裁决 Q1=C）
- 关联: 《Token-Mind Prompt Lab 开发总规范》§36、§49；ADR-0007

## 背景

规范 §36 要求新增 10 张 `prompt_*` 表，§49 建议存储用 better-sqlite3。
仓库 ContextMind 已用 Node 内置 `node:sqlite`（`DatabaseSync`）实现建表
（`contextmind/lib/db/schema.mjs`：JS 内嵌 SQL 字符串 + 迁移数组），
`package.json` 零运行时依赖、`engines.node >= 22.5.0`。

## 决策

1. SQLite 通过仓库既有 SQLite 抽象层访问，驱动 = Node 内置 `node:sqlite`
   （`DatabaseSync`），**不引入 better-sqlite3**。
2. 规范 §49 的 better-sqlite3 视为 *Reference Implementation / Optional Adapter*
   （仓库为 node:sqlite 的实现选择）。
3. 本轮（Step 0–4）不建任何 `prompt_*` 表 —— 表结构设计待 Optimizer / Eval /
   UI 轮次与数据流一起冻结，避免为尚未存在的消费者建表。
4. 新增表必须以 `ensureXxxSchema()` + 迁移数组的形式加入既有 schema 目录约定，
   与 `prompt_cache` 等现有表同一套升级路径。

## 后果

- 优点：保持零新增运行时依赖；与现有 cache-engine 共用一套迁移机制。
- 代价：node:sqlite 在 22.5 以下不可用（engines 已锁 22.5+）；不兼容
  better-sqlite3 特有扩展（本阶段无此需求）。
- 回退：若出现 node:sqlite 无法满足的并发/扩展需求，经 ADR 重议。
