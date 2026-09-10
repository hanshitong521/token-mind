# ADR-0009: Prompt Lab UI Strategy（不引入 Vue2/Element UI 构建链）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（Prompt Lab 第一轮裁决 Q1=C）
- 关联: 《Token-Mind Prompt Lab 开发总规范》§31、§32、§33；ADR-0007

## 背景

规范 §31 冻结"沿用现有前端技术栈：Vue 2 + Element UI"，并要求 Monaco Editor。
审计事实：

1. Token-Mind **不存在** Vue 前端与构建链。现有 UI 是 `dashboard.mjs`（`node:http`）
   直出的静态 HTML（`dashboard.html` / `mcp-lab.html`），零运行时依赖、零构建步骤。
2. Vue 2 已于 2023-12-31 EOL；为它新引入 Vue CLI/Vite + babel + Element UI +
   monaco-editor 依赖树，将摧毁"零依赖可单进程跑"的仓库属性。
3. 规范 §67.14："SQLite / logger / config / HTTP 能复用现有即复用"，且
   规范 UI 条款（Analyze 三栏、Findings 过滤、Before|After、Cache 条、Token 表、
   Eval 矩阵）均为页面结构要求，不依赖任何特定框架。

## 决策

1. Prompt Lab UI = 现有 `node:http` 静态 HTML 体系的**新页面**
   （`prompt-lab.html` + 新 API 路由），不引入 Vue2 / Element UI / Monaco 构建链。
2. 规范 §31/§32/§33 视为 *Optional UI implementation*；页面结构与交互细节
   （三栏布局、severity 过滤、单条 patch 接受/撤销、红色阻断关键规则删除、
   "Apply All 不含 Experimental"）作为行为要求保留，后续在静态 HTML 中落地。
3. 代码高亮/编辑能力后续按需评估：本地优先轻量方案，Monaco 仅在
   CDN/离线都可用时纳入，且不成为第一阶段依赖。
4. UI 阶段（§50 Step 8）另行排期，本轮不建页面。

## 后果

- 优点：保持单进程零依赖可运行；与 dashboard/mcp-lab 同构，维护成本低。
- 代价：放弃 Vue 生态组件（表格/树/拖拽需手写或引入单个轻量库）；UI 复杂功能开发量略增。
- 回退：若页面复杂度超出静态 HTML 可控范围，经 ADR 重议引入构建链。
