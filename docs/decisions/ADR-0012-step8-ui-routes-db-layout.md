# ADR-0012: Step 8 决策（Layout Engine 语义 / 消费者驱动 DB / API 路由 / 可写 Lab Server）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（第三轮自动执行，无 Q&A；按 round-2 冻结顺序进入 Step 8 UI/路由/DB，布局引擎作前置小步）
- 关联: 《Token-Mind Prompt Lab 开发总规范》§16/§31/§32/§33/§35/§36/§56/§58/§59；
  ADR-0008 / ADR-0009 / ADR-0010 / ADR-0011

## D1. Layout Engine = 建议层，不是自动排序器

§16 的逻辑布局（L0..L7）映射表已由 `segment-classifier.mjs` 独占
（KIND_STABILITY / KIND_SLOT / LAYOUT_SLOTS），round-3 只在其上加**实例级视图**
（`lib/prompt-engine/layout.mjs`）：

- 逐实例 lane 报告 + 缓存 frontier（首个 DYNAMIC/EPHEMERAL 实例，与
  analyzeCacheStability 同一边界）+ frontier 之后的 stable 实例违规清单；
- MOVE 候选**只**给 parser 标 `mutability === "SAFE_REORDER"`
  （project_contract / repo_map / wiki 且无 volatile 内容）且位于 frontier 之后
  的实例 —— 缓存动机明确（把稳定内容挪回稳定前缀）；
- **任何布局 op 都不自动 apply**：顺序变化是 SEMANTIC_REWRITE 级（P10），
  UI 单条接受（§33）；`SAFE_COMPACT`（rule/instruction）与 `DO_NOT_TOUCH`
  一律标为 manual / Eval-grade，绝不出 op。

理由：parser 把 DYNAMIC/EPHEMERAL 一律标 DO_NOT_TOUCH（§15），所以真正"可
移动的稳定块"只剩 SAFE_REORDER；自动重排 rule 会改变行为，安全边界必须留在
parser 的 mutability 一处，layout 不持有第二套权限表。

## D2. DB：消费者驱动，只建本轮有消费者的表

按 ADR-0008"不为不存在的消费者建表"：

- 本轮建 8 张（`lib/db/prompt-lab-schema.mjs`，`ensurePromptLabSchema` +
  `PROMPT_LAB_SCHEMA_VERSION`，与 cache schema 同一约定）：
  `prompt_meta`（schema_version + §59 telemetry 计数）、`prompt_documents`、
  `prompt_versions`、`prompt_blocks`、`prompt_findings`、`prompt_patches`、
  `prompt_fingerprints`、`provider_capabilities`；
- `prompt_eval_runs / prompt_eval_cases / prompt_eval_results` 三张推迟到
  Step 9（届时才有 Eval 消费者）；
- 文档身份 = source_hash（同字节 = 同一文档）；每次 analyze/optimize/patch
  都写一个新版本（spec §56 `prompt://<doc>/<version>`，绑定 engine /
  rule-pack / tokenizer / optimizer 版本）；provider 能力表启动时从静态注册表
  upsert 快照（§58）；
- DB 文件 = `<projectRoot>/.contextmind/prompt-lab.db`（区别于 dashboard 只读的
  telemetry.db）。

## D3. API：§35 路由全落地 + patch/apply 与 patch/reverse

`lib/prompt-lab/api.mjs` 实现 §35 全部路由（analyze/optimize/diff/fingerprint/
tokenize/export/history list+detail/provider capabilities），另加 `layout`
（供 Optimize/Cache 页）与两个 §33 需要的变更端点：

- `patch/apply`：对已存版本做 STALE 守卫的实例级 op 应用（单条/子集），
  成功即写 child version（kind=patch_apply）+ applied patch 行；
- `patch/reverse`：**快照还原**（把 parent 内容作为新 restore 版本），不伪造
  op 级逆（round-2 reverseOps 的 DELETE 不可逆边界保持诚实）；
- `evaluate` 保持显式降级 `PROMPTFOO_NOT_INSTALLED`（ADR-0010），直到 Step 9。

## D4. Server：独立可写进程，dashboard 保持只读

`prompt-lab-server.mjs`（node:http，零依赖）：默认 8898、`--port 0` 交给 OS
（打印实际 URL，供测试）；挂 `/prompt-lab`（静态 HTML 单文件）+ `/promptLab/*`
JSON 路由 + `/api/nav` 增加 `prompt_lab`。与 dashboard 的只读属性分离，避免
把写路径混进只读 telemetry 查看器。

## D5. Step 10 冻结不变

Conservative Rewrite 的 LLM 改写需要 rewrite adapter + Eval 证据（§P10），
静态核心只排队（Mode C pendingEval，round-2 已落）；Step 9（promptfoo /
eval 表）先于 Step 10。UI 上 "Apply All" 由客户端显式排除 Experimental /
红色阻断 / 布局 MOVE —— 与服务端 recommendFor 语义一致。

## 后果

- 优点：DB/API/UI 三者围绕同一条版本链；布局语义单一来源；零新增依赖；
  Step 8 页面在本地即可跑通 Analyze→Optimize→Apply→Undo→History。
- 代价：完整 Export（AGENTS/CLAUDE/Cursor/SKILL 序列化）仍在 Step 11；
  Eval 矩阵页面在 Step 9 前显示不可用；layout 的 MOVE 需人工逐条确认。
- 回退：若静态 HTML 复杂度失控，按 ADR-0009 重新评估引入构建链。
