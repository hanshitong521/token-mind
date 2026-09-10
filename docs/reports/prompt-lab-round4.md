# Prompt Lab 第四轮整改报告（Step 9 Builtin Eval + Step 10 Conservative Rewrite + Step 11 Export）

> 日期：2026-09-09 ｜ 范围：round-3 冻结顺序 —— Step 9 Eval 基础设施（§27–§30/§41）、
> Step 10 Conservative Rewrite adapter（§14/P10）、Step 11 Export 扩展（§50），ADR-0013
> 机器可验证证据：`docs/reports/prompt-lab-round4-evidence.txt`
> （`contextmind/scripts/prompt-lab-round4-evidence.mjs` 生成，自校验失败即非零退出）
> 本报告 Gate 见 §7，证据 67 条机器断言全绿。

---

## 1. 本轮目标（来自 round-3 §9 未决 #1/#2/#3）

| round-3 未决 | 交付 |
|---|---|
| #1 Step 9 Eval provider + 3 张 eval_* 表 + Eval 页 + gate 打开路径 | `lib/prompt-lab/eval.mjs` BuiltinEvaluator（离线确定性，零 LLM）+ schema v2 三表 + `routeEvaluate` 落库 + 证据→gate 贯通（ADR-0013 D1–D3） |
| #2 Step 10 Conservative Rewrite adapter | `lib/prompt-engine/rewrite-adapter.mjs` 机械合并 adapter（近重复→`MERGE_BLOCKS`，risk=SEMANTIC_REWRITE，requiresEval）+ `semantic/confirm` P10 路由（D4–D5） |
| #3 Step 11 Export fidelity | `format:"file"` + AGENTS/CLAUDE/RULES/SKILL 目标族 + openai_json/anthropic_json（D6） |
| UI 同步 | Eval 页（指标/负向控制/case 表 + Export 下拉）、Optimize 页 Mode-C 候选确认区 |

## 2. Eval 基础设施（Step 9，ADR-0013 D1–D3）

- **BuiltinEvaluator**（`eval.mjs`）：全离线。数据集 `builtin-1` = 3 个真实编码
  prompt 形状 case（JAVA-CONTROLLER-001 / SQL-DONT-TOUCH-001 / DUP-RULES-001），
  每个声明 must_have / must_not_have / 负向控制注入；full regression 时叠加
  41 个 repo fixture 的 expect 契约回归（evidence `eval_cases_dataset3_fixtures41=44`、
  `eval_fixture_regression_zero=true`）。
- **指标诚实**：断言通过率=1（`eval_assertion_pass_rate=1`）；§29 里离线可测的
  token/cache 指标全部实测（before/after tokens、tool schema tokens、stable
  prefix ratio/tokens 均值，evidence `eval_prompt_tokens_before=13371`、
  `eval_stable_prefix_ratio_avg=0.63`）；LLM-only 的 task_success_rate /
  tool_selection_accuracy / hallucination_rate / latency / cost /
  provider_cached_tokens = `not_measured`（evidence 6 条），spec §29"严禁只
  比较 token 数"落地。
- **§30 负向控制**：3 个故意破损注入（volatile 前缀 / 重复 # Rules / 三段重复）
  全部被规则引擎检出（`eval_negative_all_detected=3/3`）；语义级破损如实
  not_measured（ADR-0013 D7-2）。
- **落库**：schema v1→v2，`prompt_eval_runs / prompt_eval_cases /
  prompt_eval_results`（evidence `eval_schema_tables=3/3`、总表 11/11）；
  `saveEvalRun/saveEvalResults/latestEvalEvidence/listEvalRuns`；
  telemetry `eval_run_count/eval_regression_count`。
- **gate 贯通**：analyze/optimize 在无显式 assertions 时，以该内容 hash 最新
  builtin 全过 run 作为证据 —— evidence
  `gate_critical_assertions_unknown_before_eval=true` →
  `gate_critical_assertions_pass_after_eval=true`，且 `recommendable` 同步翻转；
  FAIL/无 run 时 UNKNOWN 保持关闭，客户端声明无效（ADR-0013 D3）。

## 3. Conservative Rewrite adapter（Step 10，ADR-0013 D4–D5）

- adapter 契约：`conservativeRewriteCandidates(manifest)` 只对**近重复**
  （tokenSimilarity ≥ 0.72）非精确重复、非 DO_NOT_TOUCH/tool_schema 的段产出
  候选；merged = 行并集去重保序（`mergeTexts`），tokenDelta 必然 ≤ 0
  （evidence `candidate_*_tokenDelta_negative=-15`）；精确重复归 Mode B
  （`exact_duplicates_not_semantic_candidates=true`）。
- optimizer `semanticCandidates` 的候选现在携带**可执行 ops**
  （MERGE_BLOCKS + rebuildBlock 补全 id/hash/tokenCount），修复了只读建议无法
  apply 的问题。
- **P10 confirm 全链路**（evidence `route_optimize_mode_C=true` →
  `p10_blocks_without_eval=true` → eval 全过 → `semantic_confirm_ok=true`）：
  候选先落成 pending SEMANTIC_REWRITE patch 行（审计，`pending_semantic_patch_rows=1`）；
  confirm 按 base.source_hash 查证据（不重算）；apply 出 child version
  （`semantic_confirm_merged_blocks=3->2`）；undo 快照还原回原块数
  （`semantic_undo_restores_block_count=true`）。风险一律由 acceptPatch 从 op
  派生（MERGE/EXTRACT→SEMANTIC_REWRITE），telemetry 分 semantic/safe/layout 计数。

## 4. Export 扩展（Step 11，ADR-0013 D6）

- `format:"file"` + target 族：AGENTS.md / CLAUDE.md / `.cursor/rules/prompt-lab.mdc`
  / SKILL.md —— 各带目标 front-matter/头注，正文复用同一 `serializeToMarkdown`
  （evidence 4×4 条 filename/header/body 全绿）；未知 target 显式拒绝
  （`export_unknown_target_rejected=true`）。
- `openai_json`（messages 数组）/ `anthropic_json`（含 system 字段）可直接投喂；
  markdown 旧格式不变（`export_markdown_legacy_intact=true`）。
- UI：Eval 页 Export 下拉 + Optimize 页 Mode-C 候选确认按钮已接
  `/promptLab/semantic/confirm`（HTTP E2E 背书，见 §6）。

## 5. 测试与回归

```
prompt-lab: 155/155 pass  (node --test "tests/prompt-lab/*.test.mjs")
全仓:       336/337 pass —— 唯一失败 tests/s8.test.mjs G-S8-06（预存在，
            handles/telemetry 链路，0 引用 prompt-engine，round-1 已排期）
```

本轮修复 1 个过期测试（`prompt-lab-server.test.mjs` 原"evaluate 显式降级"断言 → 真实
builtin Eval + §30 负向控制 + §29 not_measured 断言，HTTP 层验证证据持久化）。

新增/更新测试：

| 文件 | 断言方向 |
|---|---|
| `tests/prompt-lab/prompt-lab-eval.test.mjs`（5，新增） | 全量回归（dataset3+fixtures41）PASS；自定义内容即时断言；负向控制全检出；单 case/单 fixture；数据集稳定性 |
| `tests/prompt-lab/rewrite-export.test.mjs`（7，新增） | adapter 近重复→SEMANTIC MERGE；精确重复不属 Mode C；mergeTexts 行并集；候选带可执行 ops；P10 无证据阻断→Eval 后 confirm→undo；Step-11 五目标 + JSON |
| `tests/prompt-lab/prompt-lab-api.test.mjs`（改） | 过期 evaluate 降级测试 → 真实 Eval 落库 + evidence 查询 + gate UNKNOWN→PASS 翻转 |
| `tests/prompt-lab/prompt-lab-server.test.mjs`（改） | HTTP evaluate = builtin PASS + runId + §30/§29 断言 |

## 6. 机器证据（67 条机器断言全绿，7 段共 93 行断言记录）

evidence 段落：`BUILTIN_EVAL` → `EVAL_DB_PERSIST` → `GATE_THREAD`（含完整
gate.checks）→ `MODE_C_SEMANTIC` → `STEP11_EXPORT` → `LAB_INFO` → `HTTP_E2E`。
HTTP E2E 在真实子进程 server 上验证：页面含 Eval 页 → evaluate=builtin PASS
（runId 持久化）→ lab/info 状态 → Mode C 候选 → 无证据 P10 阻断 → 同内容
Eval 全过后 confirm=SEMANTIC_REWRITE → SKILL 导出。

## 7. Round-4 Gate（全部带机器证据，见 evidence 文件）

| # | 门槛 | 结果 | 证据 |
|---|---|---|---|
| 1 | Builtin Eval 全离线可跑：dataset+41 fixture 回归全过 | ✅ | eval_full_regression_ok=true / eval_cases_dataset3_fixtures41=44 / regression_zero |
| 2 | 断言通过率与关键指令保留真实上报 | ✅ | eval_assertion_pass_rate=1 / criticalAssertionVerdict=PASS |
| 3 | LLM/provider-only 指标 not_measured，绝不伪造；token/cache 离线指标实测 | ✅ | eval_llm_metric_*=not_measured（task/hallucination/latency/cost/tool/cache 6 项）+ eval_prompt_tokens_* / stable_prefix_* / tool_schema_tokens 实测 |
| 4 | §30 负向控制全部检出 | ✅ | eval_negative_all_detected=3/3 |
| 5 | schema v2 三张 eval 表消费者驱动落地 | ✅ | eval_schema_tables=3/3 / total=11/11 |
| 6 | Eval run + per-case 结果落库、evidence 可按内容 hash 查询 | ✅ | eval_run_persisted=true / eval_latest_evidence_*=true / eval_runs_total=2 |
| 7 | gate：无证据 UNKNOWN 关闭 → 全过 run 后 PASS | ✅ | gate_critical_assertions_unknown_before_eval=true / pass_after_eval=true |
| 8 | Mode C 候选 = 可执行 MERGE_BLOCKS、risk=SEMANTIC_REWRITE、requiresEval | ✅ | candidate_*_op=MERGE_BLOCKS / risk / pending_eval=1 |
| 9 | P10：无 Eval 证据 confirm 被阻断（含 HTTP） | ✅ | p10_blocks_without_eval=true / http_p10_blocked_without_eval=true |
| 10 | Eval 全过后 confirm 生效、可撤销、计数真实 | ✅ | semantic_confirm_ok=true / merged 3->2 / undo restores / telemetry |
| 11 | Step-11 目标族 + JSON 导出、未知目标拒绝 | ✅ | export_{agents,claude,rules,skill}_*=true / openai/anthropic_json=true / unknown_rejected |
| 12 | lab/info 状态诚实（builtin + promptfoo NOT_INSTALLED） | ✅ | lab_info_eval_provider=builtin / promptfoo=NOT_INSTALLED |
| 13 | 真实 HTTP 端到端（Eval→Mode C→confirm→Export） | ✅ | http_* 全绿（8 条） |
| 14 | 全量测试真实执行 | ✅ | prompt-lab 155/155、全仓 336/337（仅剩预存在 s8） |
| 15 | 零新增生产 runtime 依赖 | ✅ | 仅 node: 内置（http/sqlite/crypto…），未改 package.json |
| 16 | 语义级破损如实 not_measured，不假装检出 | ✅ | ADR-0013 D7-2 + eval_llm_metric_* 字段分离 |

## 8. 修改文件清单

代码：
- `lib/prompt-lab/eval.mjs`（新增，BuiltinEvaluator + 数据集 + fixture 回归）
- `lib/prompt-engine/rewrite-adapter.mjs`（新增，Mode C adapter 契约）
- `lib/db/prompt-lab-schema.mjs`（改，schema v1→v2 + eval 三表）
- `lib/prompt-lab/store.mjs`（改，eval 持久化/查询 + acceptPatch 风险派生 + 计数）
- `lib/prompt-lab/api.mjs`（改，routeEvaluate 实跑 + 证据→gate 贯通 +
  routeConfirmSemantic + export 扩展 + lab/info）
- `lib/prompt-engine/optimizer.mjs`（改，semanticCandidates 产出可执行 merge ops）
- `prompt-lab-server.mjs`（改，/promptLab/semantic/confirm 路由）
- `prompt-lab.html`（改，Eval 页 + Export 下拉 + Mode-C 候选确认区）

测试/脚本/文档：
- `tests/prompt-lab/prompt-lab-eval.test.mjs`、`rewrite-export.test.mjs`（新增）
- `tests/prompt-lab/prompt-lab-api.test.mjs`、`prompt-lab-server.test.mjs`（更新过期断言）
- `scripts/prompt-lab-round4-evidence.mjs`（自校验证据收集器，67 断言）
- `docs/decisions/ADR-0013-step9-eval-conservative-rewrite-export.md`
- `docs/reports/prompt-lab-round4.md`（本报告）+ `prompt-lab-round4-evidence.txt`

## 9. 未决问题（下一轮裁决/排期）

1. **promptfoo / LLM provider 适配**：同一报告形状接真实 provider 执行后，
   task_success_rate 等从 not_measured 转实测；`prompt_eval_cases` 表随之有消费者。
2. **LLM-backed Conservative Rewrite**：adapter 契约已就绪（返回同形状 ops），
   语义级改写 + 对应负向控制需要 provider 执行标定。
3. **评分标定**（round-2 未决 #4）：quality 粗粒度档位可借 Eval 断言反标定。
4. **Mode D Experimental**：仍被 gate 挡在 recommendable 之外，无 Eval 覆盖前不开。
5. **UI 性能目标**（100K token <800ms，§39）：留 Step 12 runtime 压测。
6. **预存在失败**：`tests/s8.test.mjs` G-S8-06 待独立排期（round-1 起未动）。
7. **git untracked**：prompt-engine / lib/prompt-lab 等仍 untracked（入场即如此，未提交）。

---

## 结论

> Step 9/10/11 冻结项一次落地：Builtin Eval（离线确定性、41 fixture 回归、
> 负向控制全检出、LLM-only 指标 not_measured）→ 证据落库并贯通 publish gate
> （UNKNOWN 无证据不开，全过 run 才 PASS）→ Mode C Conservative Rewrite
> （机械行并集合并、SEMANTIC_REWRITE + P10 confirm 全链路可撤销）→ Export
> 目标族（AGENTS/CLAUDE/Cursor Rule/SKILL + OpenAI/Anthropic JSON）。
> prompt-lab 155/155、全仓 336/337（仅剩预存在 s8）、67 条机器断言全绿、
> HTTP E2E 全绿、零新增依赖。下一轮：promptfoo/LLM provider 适配（实测语义
> 指标）+ LLM-backed rewrite。
