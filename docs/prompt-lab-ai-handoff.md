# Prompt Lab（Prompt Optimizer）功能总览与 AI 交接文档

> 给接手/使用本模块的 AI 或工程师。所有结论均以当前代码、测试与
> `docs/reports/prompt-lab-round{1..4}.md` 机器证据为准；若与本文冲突，
> **以代码与测试为准**，并请顺手修正本文。
>
> 仓库：`Token-Mind` monorepo　|　功能目录：`Token-Mind/contextmind`
> 引擎版本：`ENGINE_VERSION = "1.0.0"`，`RULE_PACK_VERSION = "1.0.0"`
> 数据库 schema：`PROMPT_LAB_SCHEMA_VERSION = 2`

---

## 1. 一句话定位

Prompt Lab 是一个**离线的 Prompt 优化工作台**：粘贴任意指令文件
（AGENTS.md / CLAUDE.md / SKILL.md / 规则 / OpenAI messages / Anthropic
request），它把内容解析成"块(block)"结构，跑一组确定性规则找问题，
按风险分级的原子补丁(op)优化，用**无 LLM 的内置 Eval** 证明改动安全，
再按目标导出成 AGENTS/CLAUDE/Cursor/SKILL 等格式。全程本地、无外部
provider、可审计、可回滚。

## 2. 目录导航（改代码前先看这张表）

| 路径 | 内容 |
|---|---|
| `contextmind/lib/prompt-engine/` | 纯引擎：解析/规则/评分/优化/补丁/缓存/指纹（22 个 .mjs，见 §5） |
| `contextmind/lib/prompt-lab/` | 应用层：`api.mjs`（HTTP 路由实现）、`store.mjs`（SQLite 持久化）、`eval.mjs`（内置 Eval 引擎） |
| `contextmind/lib/db/prompt-lab-schema.mjs` | schema v2（10 表 + 6 索引） |
| `contextmind/prompt-lab-server.mjs` | Node http 服务器：静态 UI + 16 条 JSON API（见 §6） |
| `contextmind/prompt-lab.html` | 单文件 UI（7 个 Tab，见 §12） |
| `contextmind/scripts/prompt-lab-round{2,3,4}-evidence.mjs` | 各轮自校验证据收集器 |
| `contextmind/lib/fixtures/prompt-lab/` | 41 个回归 fixture（每条带 `expect` 契约注释） |
| `contextmind/tests/prompt-lab/` | 18 个测试文件（18 文件含 `_helpers.mjs`） |
| `docs/decisions/ADR-0009..0013` | 本功能域决策记录（见 §15） |
| `docs/reports/prompt-lab-round{1..4}.md` + `-evidence.txt` | 分轮整改报告与机器证据 |

## 3. 功能全景（按轮次：每轮"新增了什么"）

### Round 1 —— 引擎骨架（Step 1–5）
- 解析器支持 3 种输入：`markdown` / `openai`(messages) / `anthropic`(request)
- Block 模型：每块有 `id / hash / tokenCount / mutability / volatility` 等
- `DO_NOT_TOUCH` 不可变区识别（代码围栏、SQL、密钥、已标注指令）
- 规则引擎 `runRulesWithReport`：注册制规则，全部执行、无静默失败
- `summarizeFindings` 输出分类汇总（问题/规则命中）
- **不允许自己优化自己**的元规则；HTTP 服务 + 单文件 UI

### Round 2 —— 缓存指纹（Step 6）
- 缓存稳定分析器：`stablePrefixTokens / stablePrefixRatio / cacheBreakerCount`
  （探测动态 token 是否落在缓存前缀内）
- 指纹：文档 root fingerprint + 逐版本快照
- Token 分析（粗略 + 前后对比）、布局分析（次序/分组/空行）

### Round 3 —— 版本链与安全优化器（Step 7–8）
- **版本链**：`prompt://<document>/<version>` 每次 analyze/optimize 落库，
  History 是真实数据而非会话缓存（spec §56）
- **安全优化器（Mode B）**：只能产出 6 类引用寻址的原子补丁
- **发布门（Gate）**：3 个 critical check（见 §4.4），全 PASS 才 recommendable
- 补丁应用带 **STALE 指纹守卫**；全部可逆（undo 快照）
- 规则报告 → 状态机：`draft → rule_execution_complete → ... → recommendable`
- SQLite（`node:sqlite`）落地：schema v1

### Round 4 —— Eval / Conservative Rewrite / Export（Step 9–11，最近一轮）
- **Step 9 内置 Eval 引擎**（`lib/prompt-lab/eval.mjs`，完全离线确定性）：
  3 个内置数据集用例 + 41 fixture 回归 + §30 负向控制 + §29 全指标
  （含实测 token/cache 指标，LLM-only 项如实 `not_measured`）
- **schema v1 → v2**：新增 3 张 eval 表 + 2 个索引（§11）
- **Eval 证据→门控打通**：同一内容 hash 有全过 Eval 记录时，
  `critical_assertions_pass` 由 `UNKNOWN` 翻为 `PASS`
- **Step 10 Mode C（CONSERVATIVE_REWRITE）**：机械式行并集合并候选
  （非 LLM 改写），标记 `SEMANTIC_REWRITE` 风险，**P10 门：必须先过
  Eval 才能 apply**，apply 后可 undo
- **Step 11 导出家族**：AGENTS / CLAUDE / Cursor Rule(.mdc) / SKILL /
  OpenAI JSON / Anthropic JSON / Patch（§10）
- API 全量真实化：`/promptLab/evaluate` 实跑落库，不再是降级桩
- UI 新增 Eval Tab、Optimize 页 Mode C 候选区（confirm 按钮）、导出下拉

### 扫尾轮（Round 4 之后的系统查漏）
- 补齐 §29 离线可测指标：`prompt_tokens_before/after/delta`、
  `tool_schema_tokens`、`stable_prefix_tokens_avg`、`stable_prefix_ratio_avg`
- LLM-only 补齐 `tool_selection_accuracy` / `provider_cached_tokens` = `not_measured`
- 清理过期注释、UI 文案、`patch` 恒空导出选项、空输入静默降级
- 过期测试（server "evaluate 显式降级" 断言）替换为真实 Eval 行为断言

## 4. 核心领域模型

### 4.1 优化模式（`OPTIMIZE_MODE`，见 optimizer.mjs）
| 档 | 值 | 行为 |
|---|---|---|
| A | `ANALYZE_ONLY` | 只分析，不产补丁 |
| B | `SAFE` | 安全优化：仅布局/去重/规范化等无损 op（默认） |
| C | `CONSERVATIVE_REWRITE` | B 子集 + 机械语义合并候选（需 P10 Eval 确认） |
| D | `EXPERIMENTAL` | **未解锁**：需 `allowExperimental && compressorAdapter`（静态核心两者皆无），返回 `EXPERIMENTAL_UNAVAILABLE` |

### 4.2 补丁操作（`OP` 枚举，patch.mjs）
`DELETE_DUPLICATE_BLOCK` / `NORMALIZE_BLOCK` / `REPLACE_BLOCK` /
`MOVE_BLOCK` / `MERGE_BLOCKS` / `EXTRACT_DYNAMIC_BLOCK` /
`EXTRACT_TOOL_GUIDANCE` —— 全部按 `{blockId, occurrence}` **引用寻址**。
风险分级：`patchRiskOf(ops)` ∈ `SAFE / REVIEW / EXPERIMENTAL`
（`MERGE_BLOCKS`、`EXTRACT_*` → 记为 `SEMANTIC_REWRITE`）。
应用顺序固定：removals → content → layout（见 patch.mjs 头注释）。

### 4.3 三态发布门（`evaluateGate`，scoring.mjs）
- critical checks（缺一不可 recommendable）：`rule_execution_complete`、
  `critical_assertions_pass`（无 Eval 时为 UNKNOWN）、`safety_regression_zero`
- `recommendable ⇔ 全部 critical = PASS 且无任何 check = FAIL`
- `recommendFor` 状态机：`BLOCKED / EVAL_REQUIRED / EXPERIMENTAL_UNAVAILABLE /
  ANALYZE_ONLY / ... / APPLY`（recommendFor 是"现在能不能 apply 到文件"的回答）
- **P10 规则**：op 全 SAFE 的补丁无需 Eval；`SEMANTIC_REWRITE` 及以上必须先过 Eval

### 4.4 指纹守卫
补丁携带 `baseFingerprint`；apply 时若目标块列表指纹不匹配则
`onStale: "throw"`（默认），防止在已变化的文档上盲打补丁。

## 5. prompt-engine 模块清单（22 个）

| 模块 | 职责 |
|---|---|
| `index.mjs` | 门面：`ENGINE_VERSION`、`allRules()`、`analyze()`、`optimize()`、`diff()`、`fingerprint()`、`summarizeFindings`；再导出 OPTIMIZE_MODE 等 |
| `parser.mjs` | `parsePrompt`（markdown/openai/anthropic 三源） |
| `manifest.mjs` | Block/Manifest 模型、sha256 |
| `optimizer.mjs` | `optimizeManifest`、`semanticCandidates`、`recommendFor`、mode 归一 |
| `rule-engine.mjs` | `runRulesWithReport`、`allRules`（规则注册制） |
| `patch.mjs` | `OP/PATCH_RISK`、`applyPatch`、`reverseOps`、`patchOpsBetween`、`rebuildBlock` |
| `scoring.mjs` | 评分 + `evaluateGate` |
| `safety-rules.mjs` | 安全规则（不可变区等） |
| `duplicate-detector.mjs` / `conflict-detector.mjs` | 重复块 / 冲突检测 |
| `segment-classifier.mjs` | 分段分类（含 tool_schema 段） |
| `secrets.mjs` | 密钥扫描 |
| `token-analyzer.mjs` / `cache-analyzer.mjs` / `cache-rules.mjs` / `volatility.mjs` | token、缓存稳定、缓存规则、易变检测 |
| `canonicalizer.mjs` / `fingerprint.mjs` | 规范化 / 指纹 |
| `layout.mjs` | 布局优化 |
| `quality-analyzer.mjs` | 质量分析 |
| `rewrite-adapter.mjs` | **Step 10**：`conservativeRewriteCandidates`、`mergeTexts`、`MERGE_SIMILARITY_FLOOR=0.72` |
| `providers.mjs` | provider 元信息 |

## 6. HTTP API 全清单（prompt-lab-server.mjs）

页面：`GET /` 与 `GET /prompt-lab`（prompt-lab.html）、`GET /api/nav`。
JSON API 均为 **POST**（除注明），handler 见 `lib/prompt-lab/api.mjs`：

| 路由 | 作用 | 关键入参 → 要点 |
|---|---|---|
| `/promptLab/import` | 导入并建文档 | content/sourceType → 返回 versionId |
| `/promptLab/analyze` | 分析 | content/versionId → findings + gate + eval 证据线索 |
| `/promptLab/optimize` | 优化（A/B/C/D） | content + mode → 响应含 `optimized.manifest`、summary、gate、`pendingEval`(Mode C) |
| `/promptLab/diff` | 前后对比 | a/b → ops |
| `/promptLab/fingerprint` | 指纹 | content → root fingerprint |
| `/promptLab/tokenize` | Token 统计 | content → before/after |
| `/promptLab/layout` | 布局分析 | content → layout 建议 |
| `/promptLab/evaluate` | **实跑 Eval** | content/versionId/caseId/fixtureId/mode → runId + 全指标，落库 |
| `/promptLab/export` | 导出 | format ∈ markdown/messages/anthropic/patch/file/openai_json/anthropic_json；file 需 target |
| `/promptLab/history/list` | 历史列表 | docId/limit/offset |
| `/promptLab/history/detail` | 版本详情 | versionId → blocks/manifest/findings/patches/fingerprints |
| `/promptLab/patch/apply` | 应用补丁 | versionId + ops → child version（STALE 守卫） |
| `/promptLab/patch/reverse` | 撤销补丁 | childVersionId → 还原父版本 |
| `/promptLab/semantic/confirm` | **P10 确认** | versionId → 需该 doc 有全过 Eval 证据；通过则应用 SEMANTIC_REWRITE |
| `/promptLab/info` | 状态 | evalProvider=builtin、promptfoo=PROMPTFOO_NOT_INSTALLED、计数器 |
| `GET /promptLab/provider/capabilities` | provider 能力 | 静态能力表（store 预置） |

> 空 body / 未知 format / 未知 target 均显式返回 `{ok:false, error}`，绝不静默降级。

## 7. Store 层（`PromptLabStore`，store.mjs）

`saveVersion / saveFindings / saveFingerprint / savePatch / saveEvalRun /
saveEvalResults / latestEvalEvidence(contentHash,{provider}) / listEvalRuns /
ensureDocument / nextVersionNo / acceptPatch / undoToParent / historyList /
versionDetail / blocksOf / manifestOf / findingsOf / patchesOf /
fingerprintsOf / versionRow / listProviderCapabilities / getCounters / bump`

要点：
- `acceptPatch` 自动从 ops 推 `patchRisk`，并区分
  `semantic_patch_count` / `safe_patch_count` / `layout_count`
- `latestEvalEvidence(hash)` 是门控翻 PASS 的唯一证据源
- 测试中注意：Store 持 SQLite 连接，用完必须 `close()`，
  否则 Windows 上 `rmSync` 报 EBUSY

## 8. Eval 引擎（Step 9，eval.mjs）

### 8.1 Provider 状态
`EVAL_PROVIDERS = { BUILTIN: "builtin", PROMPTFOO: "promptfoo" }`；
当前 `evalProvider: "builtin"`，`promptfoo: "PROMPTFOO_NOT_INSTALLED"`
（**是显式状态，不是静默 no-op**，ADR-0010）。

### 8.2 数据集与回归
- `BUILTIN_DATASET_ID = "builtin-1"`，`BUILTIN_CASES` 3 例：
  `JAVA-CONTROLLER-001`（Java 控制器指令）、`SQL-DONT-TOUCH-001`（SQL 保护）、
  `DUP-RULES-001`（重复规则）—— 每例有 `must_have/must_not_have` 断言
  与静态可检出负向控制
- 自定义输入（`/evaluate` 传 content）→ 追加 `CUSTOM-INPUT` 即时断言例
- 默认同时跑 **41 个 fixture 回归**：解析可达、`minBlocks`、
  `minDoNotTouch`（DO_NOT_TOUCH 生存）、`ruleIds` 命中、
  `roundTrip`（序列化→重解析后受保护块逐字存活）
- 负向控制（§30）：向 seed 注入**静态可检出缺陷**（volatile 前缀、
  重复 `# Rules` 段等），要求规则输出必须随之变化才算 `detected`
  —— 语义级破坏需 provider 执行，如实报 `not_measured`，不伪造

### 8.3 指标字典（metrics 字段，谁在测一目了然）
实测（离线确定性）：
`assertion_pass_rate`、`critical_instruction_retention`、
`negative_control_detection`、`regression_count`、
`prompt_tokens_before / after / delta`、`tool_schema_tokens`、
`stable_prefix_tokens_avg`、`stable_prefix_ratio_avg`

如实 `not_measured`（需 provider 执行，**严禁伪造**，spec §29）：
`task_success_rate`、`tool_selection_accuracy`、`hallucination_rate`、
`latency_ms`、`cost`、`provider_cached_tokens`

Per-case metrics：`seedTokens / optimizedTokens / deltaTokens /
toolSchemaTokens / stablePrefixTokens / stablePrefixRatio /
cacheBreakerCount / seedFindings`。

## 9. Mode C 全链路（Step 10）

```
optimize(mode=C) → semanticCandidates(manifest)
  → conservativeRewriteCandidates（行并集合并，相似度 ≥0.72）
  → pendingEval 候选逐条持久化为 SEMANTIC_REWRITE patch 行
  → gate: EVAL_REQUIRED（recommendFor 明确 apply:false）
evaluate(同内容全过) → prompt_eval_runs 落库（all_passed=1）
semantic/confirm{versionId}
  → 校验同一 source_hash 存在全过 Eval 证据（无则 P10 阻断）
  → acceptPatch(risk=SEMANTIC_REWRITE) → child version
  → undoToParent 可回滚
```

候选合并是**机械式**行并集（`mergeTexts`），非 LLM 改写 —— 这是保守
改写的安全根基。

## 10. 导出家族（Step 11，api.mjs routeExport / FILE_TARGETS）

| format | 产出 | 备注 |
|---|---|---|
| `markdown` | 文本 | `serializeToMarkdown(manifest)` |
| `messages` / `openai_json` | JSON | OpenAI messages 形状，文件名 `openai-messages.json` |
| `anthropic` / `anthropic_json` | JSON | Anthropic request 形状，文件名 `anthropic-request.json` |
| `patch` | JSON | `body.operations`（API 保留；UI 已移除该下拉项） |
| `file` | 文本+建议文件名 | target：`AGENTS`→AGENTS.md、`CLAUDE`→CLAUDE.md、`RULES`→`.cursor/rules/prompt-lab.mdc`（带 front-matter）、`SKILL`→SKILL.md（带 `---\nname: generated-prompt\n---`） |
| 其它 | — | `{ok:false, error}` 显式拒绝 |

## 11. 数据库 schema v2（10 表）

`prompt_meta` / `prompt_documents` / `prompt_versions`（版本链）/
`prompt_blocks` / `prompt_findings` / `prompt_patches` /
`prompt_fingerprints` / `provider_capabilities` / `prompt_eval_runs`（新）/
`prompt_eval_cases`（新）/ `prompt_eval_results`（新）
+ 6 个索引（含 `idx_eval_runs_version`、`idx_eval_results_run`）。
`prompt_eval_runs` 记录 `total/passed/assertions_total/assertions_passed/
negative_total/negative_detected/regression_count/all_passed/metrics_json/
summary_json`。

## 12. UI（prompt-lab.html，7 个 Tab）

`分析器 Analyze` → `优化器 Optimize`（Mode A–D + Mode C 语义候选区
`optSemantic` + 导出下拉）→ `Eval`（跑当前输入+内置 3 例 / 全量 41
fixtures、指标表、导出）→ `缓存 Cache` → `Token` → `History` →
`Provider Rules`。
注意：Eval 页"当前输入"按钮在输入为空时**明确报错**（不静默降级成全量）；
全量按钮文案标注 "+41 fixtures"。

## 13. 测试矩阵与运行命令

| 范围 | 结果 |
|---|---|
| prompt-lab 全套件 | **155/155 通过** |
| 全仓 `node --test` | **336/337** —— 唯一失败 `tests/s8.test.mjs` G-S8-06（预存在，与 prompt-engine 0 引用，待独立排期） |

```bash
# 必须用 managed node（Windows 上 node:sqlite 依赖它）
NODE="C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"

cd "E:\workA\A-skill\Token-Mind\contextmind"

# prompt-lab 套件（注意：node --test 目录会报 module not found，要带 glob）
"$NODE" --test tests/prompt-lab/*.test.mjs

# 全仓回归（约 2 分钟，可后台跑）
"$NODE" --test
```

## 14. 证据/审计脚本

`scripts/prompt-lab-round2/3/4-evidence.mjs`：自校验、exit≠0 即失败；
round4 含 **67 条机器断言**（7 段：BUILTIN_EVAL / EVAL_DB_PERSIST /
GATE_THREAD / MODE_C_SEMANTIC / STEP11_EXPORT / LAB_INFO / HTTP_E2E，
HTTP E2E 在真实子进程 server 上验证）。产出写入
`docs/reports/prompt-lab-round{2,3,4}-evidence.txt`。

## 15. 决策记录（ADR，docs/decisions/）

本功能域：`ADR-0009`（UI 策略）→ `ADR-0010`（promptfoo Eval 适配：
NOT_INSTALLED 是显式状态）→ `ADR-0011`（实例寻址 + 优化模式）→
`ADR-0012`（Step 8 UI/路由/DB/布局）→ `ADR-0013`（Step 9 Eval +
Conservative Rewrite + Export）。

## 16. 给协作 AI 的硬性红线

1. **不要伪造指标**：LLM-only 项必须 `not_measured`；"严禁只比较 token 数"
   是 spec §29 铁律。
2. **promptfoo 未安装**是显式状态字面量 `PROMPTFOO_NOT_INSTALLED`，
   不许静默吞掉/降级。
3. **Mode C apply 必须先有同内容哈希的全过 Eval 证据**（P10），
   `semantic/confirm` 无证据必须阻断。
4. 补丁一律 `{blockId, occurrence}` 引用寻址 + fingerprint STALE 守卫；
   不要直接改 block 数组绕过守卫。
5. 每次 analyze/optimize 走版本链落库，History 必须可回放、可 undo。
6. Windows + node:sqlite：用 managed node；Store 用完 `close()`，
   否则临时目录清理 EBUSY。
7. 跑测试用 `node --test tests/prompt-lab/*.test.mjs`（目录形式会报错）。
8. 破坏性操作（删表/清库/批量改 fixture）先确认；`.workbuddy` 目录不是缓存。
9. 改动后跑：prompt-lab 套件 → 全仓回归 →（功能涉 Eval/Mode C/导出时）
   重跑 round4 证据脚本保持 ≥67 断言全绿。

## 17. 已知遗留与建议下一步

- `tests/s8.test.mjs` G-S8-06：预存在失败，独立排期
- Mode D（EXPERIMENTAL）静态核心未接线（无 lossy compressor adapter）
- promptfoo / LLM provider 适配：接实测语义指标，
  `prompt_eval_cases` 表随之有消费者（ADR-0013 冻结顺序第一步）
- LLM-backed Conservative Rewrite：adapter 契约已就绪，只等 provider
- 评分反标定：需 Eval 覆盖后解锁
