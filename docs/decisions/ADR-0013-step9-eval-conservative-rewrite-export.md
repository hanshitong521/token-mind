# ADR-0013: Step 9 Builtin Eval + Step 10 Conservative Rewrite + Step 11 Export（第四轮）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（第四轮自动执行，无 Q&A；"一口气都解决完"指示下按 round-3 冻结顺序
  进入 Step 9 Eval → Step 10 Conservative Rewrite → Step 11 Export）
- 关联: 《Token-Mind Prompt Lab 开发总规范》§14/§27–§30/§41/§50/§P10；
  ADR-0008 / ADR-0010 / ADR-0011 / ADR-0012

## D1. EvalProvider 是状态注册表：builtin 落地，promptfoo 保持显式 NOT_INSTALLED

ADR-0010 的"降级是状态、不是静默通过"在本轮兑现为两级 provider：

- **BuiltinEvaluator**（`lib/prompt-lab/eval.mjs`）离线、确定性、零 LLM 依赖，测
  量 spec §27–§30 中不依赖外部执行的集合：断言通过率（must_have /
  must_not_have，作用于 Mode-B 输出）、关键指令保留、token 预算（Δ≤0）、
  41 fixture 回归（expect 契约：minBlocks / minDoNotTouch / ruleIds /
  roundTrip 受保护块逐字节存活 / 无静态 volatile / cacheBreaker 上限）、
  §30 负向控制（故意破损输入必须被规则引擎检出）。
- **Task Success Rate / Hallucination Rate / Latency / Cost 一律
  `not_measured`**——需要 provider 执行才能测（promptfoo 未装）。绝不伪造
  （spec §29：严禁只比较 token 数）。断言通过率 ≈1 不等于任务成功率，报告里
  字段分离、语义诚实。
- UI/API 状态：`EVAL_PROVIDER_STATE="builtin"`、`PROMPTFOO_STATE=
  "PROMPTFOO_NOT_INSTALLED"`（lab/info 与页面 footer 同时展示）。

## D2. Eval 落库 = 三张消费者驱动表（schema v1→v2）

`PROMPT_LAB_SCHEMA_VERSION` 1→2，按 ADR-0008"只为有消费者的数据建表"新增：

- `prompt_eval_runs`（provider/kind/versionId/content_hash/dataset/总case/
  通过case/断言总数通过数/负向控制检出/regression 数/all_passed/metrics+summary
  JSON/ranAt）；
- `prompt_eval_results`（每 case 一行：case_id/passed/variant/assertions_json/
  metrics_json，run_id 外键）；
- `prompt_eval_cases`（本轮 run 元数据已内嵌于 runs/metrics，表格先建不写——
  保持与 eval.mjs 输出形状解耦，后续 promptfoo 适配器可填充不同 case 定义）。
- evidence 查询 = **content hash 键**（`latestEvalEvidence(contentHash)`，provider
  过滤 + created_at 倒序取最新），与文档身份（source_hash）同一把钥匙；
  §59 telemetry 增 `eval_run_count` / `eval_regression_count`。

## D3. Eval 证据驱动 publish gate（UNKNOWN 永不自行变 PASS）

round-1 gate 的 `critical_assertions_pass` 不再是死值：analyze/optimize 路由在
无客户端显式 assertions 时，用该内容 hash 的**最新 builtin 全过 run** 作为
`options.assertions` 证据；无 run ⇒ UNKNOWN（gate 关闭），FAIL run ⇒ 仍关闭。
客户端永远无法声明一个布尔值绕过 gate——证据只能来自已落库的 Eval run
（evidence 行同时带 runId / assertions / negatives / regressions 摘要，
History 可审计）。

## D4. Mode C = Conservative Rewrite adapter（机械合并，不做 LLM 改写）

Step 10 以 adapter 契约为界（`lib/prompt-engine/rewrite-adapter.mjs`）：

- 产出**唯一的合并候选**：近重复（tokenSimilarity ≥ 0.72）、非精确重复
  （精确重复归 Mode B）、非 DO_NOT_TOUCH / tool_schema 的规则段；
  merged text = **行并集去重保序**（`mergeTexts`）——"rewrite"是机械合并，
  不是改写，语义按构造保留，tokenDelta 必然 ≤ 0；
- 每条候选 = `MERGE_BLOCKS` op，携带 `risk:"SEMANTIC_REWRITE"`、
  `requiresEval:true`（P10：任何 SEMANTIC_REWRITE apply 前必须有 Eval）；
- 未来 LLM-backed adapter 只需返回同一 op 形状即可接入，optimizer 零改动；
- optimizer 的 `semanticCandidates` 生成**可执行 ops**（rebuildBlock 补全
  id/hash/tokenCount），不再是只读建议。

## D5. 风险由 op 派生 + 候选即审计行 + 快照撤销

- `store.acceptPatch` **从 ops 派生 patchRisk**（MERGE/EXTRACT → 
  SEMANTIC_REWRITE，其余 SAFE/MOVE→layout），不采信客户端自称；telemetry
  分 `semantic_patch_count` / `safe_patch_count` / `layout_count`；
- Mode C optimize 把每条 pendingEval 候选落成一行 **pending SEMANTIC_REWRITE
  patch**（applied=0，why 含 candidateId）→ History 有完整审计；
- `/promptLab/semantic/confirm`（P10 confirm 路由）：先按 **base.source_hash**
  （文档身份，绝不从序列化块重算）查 Eval 证据；无 run → P10 阻断文案，FAIL →
  阻断；通过后把该候选 op 走 acceptPatch 生 child version（kind=patch_apply）；
  撤销沿用 patch/reverse 的**快照还原**（不伪造 op 级逆）。

## D6. Step 11 Export = 一个序列化器 + 目标族 + JSON 格式，可扩展

- markdown/messages/anthropic/patch 保持不变；新增 `format:"file"` +
  `target∈{AGENTS,CLAUDE,RULES,SKILL}`（`FILE_TARGETS` 表：建议文件名 +
  各目标 front-matter/头注，正文复用同一 `serializeToMarkdown`——保真单一来源）；
- `openai_json` / `anthropic_json` 返回可直接投喂的负载；
- 未知 target 显式报错（不回退成裸 markdown，避免用户以为导出了正确的
  AGENTS.md）。

## D7. 诚实边界（不变量）

1. LLM-only 指标 = `not_measured`，绝不填数；
2. 负向控制仅限**可静态检出**的破损注入（volatile 前缀 / 重复 # Rules 段 /
  密文形状）——语义级破损（如只读 SQL 翻成写 SQL）需要 provider 执行，如实报
  `not_measured`，不假装检出；
3. gate 的 PASS 只可能来自"该内容 hash 的全过 builtin run"，客户端声明无效；
4. 41 fixture 回归全绿是 Eval 报告 `ok` 的前提（回归≠只数块数，roundTrip 断言
  受保护块存活）。

## 后果

- 优点：Eval→证据→gate→SEMANTIC apply→undo 全链路离线可跑、确定性、可审计；
  零新增依赖（沿用 node: 内置 + node:sqlite）；Export 目标族一行一个。
- 代价：builtin 数据集规模小（3 case + 41 fixture 回归 + 负向控制），对语义
  质量的覆盖依赖未来 promptfoo/LLM provider 扩展（同一报告形状不变）；
  `prompt_eval_cases` 表暂为占位。
- 回退：删除 eval 三表 + evidence 读取即回到 round-3 gate 语义；Mode C 候选
  未被 confirm 前不产生任何副作用版本。
