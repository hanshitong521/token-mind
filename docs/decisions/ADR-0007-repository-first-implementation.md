# ADR-0007: Repository-First Implementation（规范约束行为，仓库决定实现方式）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（Prompt Lab 第一轮裁决 Q1=C）
- 关联: 《Token-Mind Prompt Lab / Prompt Optimizer 开发总规范 2026-09》§67.1、P1–P12

## 背景

规范自称"建议冻结为 SSOT"，但其技术选型条款是在未扫描现有仓库的前提下写成的
（§67.1 明写"先扫描现有 Token-Mind 目录与接口"，这条规范自身未做到）。审计确认三处
规范与仓库现状直接冲突：

| 条款 | 规范字面 | Token-Mind 仓库现状 |
|---|---|---|
| §31 前端 | Vue 2 + Element UI + Monaco | 零运行时依赖；`node:http` + 静态 HTML dashboard |
| §49 存储 | better-sqlite3 | Node 内置 `node:sqlite`（`DatabaseSync`），零依赖 |
| §27 Eval | Promptfoo "第一阶段必装" | 仅 shallow clone 源码参考；引入即破坏零依赖约定 |

## 决策

分层裁决，冻结如下：

1. **架构 / 行为 / 安全条款 = SSOT，不允许让路**：P1–P12、DO_NOT_TOUCH、Prompt IR、
   可解释/可逆/不 mutate 输入、Secret Guard、Stable Prefix、Fingerprint、Cache Drift、
   Patch stale protection、Eval / Regression Gate、Fail-open、Token 不得以牺牲正确率为代价、
   优化结果必须有 Evidence、未通过质量 Gate 不得推荐自动应用。这些是产品不变量，
   不因技术栈不同而修改。
2. **技术选型条款 = 服从现有仓库**：`node:http`、现有静态 HTML Dashboard、
   `node:sqlite / DatabaseSync`、零运行时第三方依赖优先。
   规范里的 Vue2 / Element UI / better-sqlite3 / "Promptfoo 必装"降级为
   *Reference Implementation / Optional Adapter*，不再作为架构不变量。
3. 所有此类偏离进入 ADR（本文件 + ADR-0008/0009/0010），不允许静默改。

> 核心原则：**Behavior SSOT ≠ Technology Stack SSOT。规范约束行为，仓库决定实现方式。**

## 后果

- 优点：不为了文档字面选型破坏已有项目结构；第一阶段可保持零新增运行时依赖。
- 代价：规范 §31/§49/§27 的字面条款在仓库内不可直接对照执行，需以 ADR 映射。
- 回退：若 node:sqlite / 静态 HTML 在实测中成为瓶颈，重议本 ADR，重写须 owner 批准。
