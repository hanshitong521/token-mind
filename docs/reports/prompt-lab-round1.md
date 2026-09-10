# Prompt Lab 第一轮整改报告（Step 0–4 + 两项 P0 修复）

> 日期：2026-09-09 ｜ 范围：规范 §50 Step 0–4 ｜ 裁决：Q1=C（分层）、Q2=C（测试先行）、Q3=A（收口 Step 0–4）
> 机器可验证证据：`docs/reports/prompt-lab-round1-evidence.txt`（由 `_collect-evidence.mjs` 生成）
> 本轮 Gate 全过（14/14），见 §10。

---

## 1. Audit Findings（入场审计结论）

入口审计（只读，改动前）认定 `contextmind/lib/prompt-engine/`（20 个 untracked .mjs）
为**从未执行过的骨架**。实跑证据：

| 审计项 | 审计结论 | 现状 |
|---|---|---|
| 规则执行 | `rule-engine.mjs` 调 `rule(m,ctx)` 而传入 `{id,run}`，11 条规则全抛异常被吞成 INFO | **已修（P0-1）**：11/11 真实执行，抛错=CRITICAL，见 §6 |
| Secret 落库 | `index.mjs` 算出 redacted 却返回原始 manifest，`sk-proj-*` 明文在返回值 | **已修（P0-2）**：默认 redact，泄漏=0，见 §7 |
| Gate 假绿 | `token_not_increased = true` 写死；无 `critical_assertions_pass`；0 条规则执行仍 recommendable | **已修**：三态 gate，0/41 假绿，见 §9 |
| 四档稳定性 | parser 常量赋值；timestamp/UUID 块仍 STATIC；分类器是 no-op | **已修**：content 降级 + declared/effective 双类，见 §5 |
| 优化器改坏输入 | `optimizeSafe` 浅拷贝就地写 `b.text/hash`，original 快照取于改动后 | 本轮未动（Step 7 专属）；列为未决项 §12.2 |
| §13.2 重复成本 | 行级重复检不出（同块内 2 次重复 = 0） | 部分缓解：CJK bigram tokenBag + schema dup 修复；行级成本在 Optimizer 轮再做 |
| Q13 | 空占位 `return []` | **已实现**（动态事实入静态规则），见 §6 |
| §52 fingerprint | `segmentHash` 按 id 排序 → tool 换序不可见 | **已修**：序敏感，见 §8 |
| normalizeBlankLines | 二次遍历全局折叠空行 → 吃掉代码块内空行（§9.2） | **已修**，见 §12.1 |
| CJK `\b` 死正则 | `\b...中文...\b` 在 JS 永不匹配（`\b` 只认 `[A-Za-z0-9_]`） | **已修**：剥离 25 处，见 §6 |

## 2. ADR

4 份 ADR 落盘 `docs/decisions/`（沿用仓库 ADR-000N 编号）：

- `ADR-0007-repository-first-implementation.md` — **Behavior SSOT ≠ Technology Stack SSOT**；P1–P12 不妥协，技术选型服从仓库
- `ADR-0008-use-node-sqlite.md` — 不引入 better-sqlite3；10 张 `prompt_*` 表推迟到有消费者的轮次
- `ADR-0009-prompt-lab-ui-strategy.md` — 不引入 Vue2/Element UI 构建链；静态 HTML + 新 API 路由
- `ADR-0010-promptfoo-eval-adapter.md` — Promptfoo 是 Eval Provider 非 runtime 依赖；未装=显式降级

## 3. Fixture Manifest

`contextmind/fixtures/prompt-lab/`：**41 个 fixture**（≥30 达标），每个带 `.meta.json` 声明期望。

| 类别 | 数量 | 覆盖 |
|---|---|---|
| A. Agent Instruction | 11 | 3 个真实文件（promptfoo AGENTS.md 22KB / headroom llms.txt / aider CONTRIBUTING.md）+ Cursor Rules / SKILL.md / System Prompt / 冲突 / 模糊目标 / Persona / 重复规则 / 常驻规则过载 |
| B. Tool / MCP | 6 | tools/list JSON / 重复 schema / 顺序互换 / 巨型 description / 动态 description / 正文内嵌 schema 重复 |
| C. Provider | 6 | OpenAI messages / Anthropic request / OpenAI-compatible Qwen / history+tool results / Anthropic tool_use / 本地 Qwen agent |
| D. Cache Killer | 9 | timestamp / UUID / request·trace id / git commit·branch / 绝对路径 / epoch·hash / 动态 memory 前置 / 动态 RAG 前置 / **纯静态对照 D09** |
| E. DO_NOT_TOUCH | 5 | SQL / JSON Schema / Code Diff / 验收+危险操作 / 用户原始需求 |
| F. Security | 4 | API Key(sk-/sk-proj-) / Bearer·JWT·Cookie / Password·Private Key / Access Token·DB URL |

生成器 `_generate-fixtures.mjs` 可重跑（确定性），汇总在 `manifest.json`。

## 4. Test Matrix

`contextmind/tests/prompt-lab/` 9+1 个测试文件，`node --test` 全部发现执行：

| 文件 | 断言方向 |
|---|---|
| `parser.test.mjs` | 全 fixture 可解析；确定性；枚举合法；fence 不拆分；schema 保持 JSON；role 保留；**deep-frozen manifest 不被 mutate** |
| `roundtrip.test.mjs` | DO_NOT_TOUCH 块在 markdown/messages/anthropic 三种导出中**字节保留**；重解析分类不丢 |
| `canonicalizer.test.mjs` | key 序无关；数组序敏感；fence 内空白不折叠；SQL/JSON 字面不变；canonicalManifest 不擅自排序 tools |
| `fingerprint.test.mjs` | 确定性；7 段齐备；user 改动不动稳定段；timestamp 定位为 firstDynamic；tool 换序改变 tools hash；segmentMap 完整 |
| `stability.test.mjs` | 含 volatile 的块不得 STATIC；11 种动态形态逐一识别；只降不升；普通文本零误报；D09 对照全静态 |
| `rules.test.mjs` | 11/11 注册可调用；全 fixture 执行率 100%；抛错规则=CRITICAL 且断 gate；Q13 非空占位；finding 全部可回溯 |
| `secret-guard.test.mjs` | 13 种凭据形态全检出；analyze() 公开结果 0 泄漏；默认 redact / 显式 opt-out；scanSecrets 不带原文；strict 拒发 |
| `cache-analyzer.test.mjs` | §11.3 五项指标；§54 Case A–D 全绿；评分 0..100 |
| `gate.test.mjs` | 三态；`token_not_increased` 未测=UNKNOWN；critical UNKNOWN 不得 recommend；破规则断 recommend；fixture 无 Eval 证据 0 推荐 |

## 5. Test Result

```
89/89 tests pass  (node --test)
证据行: pass 89 fail 0
```
`npm test`（`node --test`）全仓库 270/271：唯一失败 `tests/s8.test.mjs` 是**预存在失败**
（`context_orient` vs `context_fetch` 事件断言，位于 handles/telemetry 链路，0 引用 prompt-engine，
本次未触碰该模块），建议单独排期修。

## 6. Rule Execution Report

```
rules_registered=11
rules_executed_per_fixture_complete=true   # 41/41 fixture 全部 total==executed, failed==0, malformed==0
rule_ids_seen=CACHE-001,CACHE-003,CACHE-004,Q01,Q02,Q03-CONFLICT,Q04-DUP-EXACT,Q04-DUP-NEAR,Q05,Q06,Q08,Q09,Q10,Q11,Q12-SCHEMA-DUP,Q13,Q15,SAFE-001
```
本轮同时修掉三类让规则"看着有、实际死"的缺陷：
1. **P0-1 调用契约**：`runRules` 统一走 `rule.run(manifest,ctx)`（函数/描述符均可），
   异常从 INFO 占位升级为 CRITICAL DETERMINISM finding 并断执行完整性；
2. **CJK `\b` 死正则**：JS `\b` 不认汉字，含中文的检测模式（Q05/Q11/Q02/action verbs/
   conflict pairs 等共 25 处）全部剥掉 `\b`，否则中文 prompt 永远不命中；
3. **Q13 空占位实现**：检测"写入静态规则区的每次运行都会变的状态事实"
   （current task / 当前任务 / today / pending 等），区别于 CACHE-003 的 volatile token 路径。

## 7. Secret Leakage Report

```
security_fixtures=4
plaintext_secret_leaks_in_public_analyze=0
```
实现要点：`analyze()` 在**解析后立即**把 manifest redact 成工作副本，后续 token/cache/
fingerprint/评分全部在 redacted 副本上算（self-consistent）；SAFE-002 在 redact **前**
按 label-only 生成（不带原文）；findings/evidence 再经 `redactDeep` 兜底。
Secret Guard 模式库从 9 条扩到 15 条并做重叠去重（`authorization: Basic` 等此前漏检）。

## 8. Fingerprint Determinism Report

```
deterministic_runs=41/41
tool_reorder_changes_tools_segment=true
tool_reorder_changes_system_segment=false   # 只动该动的段
```
关键修复：`segmentHash` 原先按 block id 排序 → tool 顺序变化对指纹不可见（§52 明确要求
"只换 tool order => tools hash 改变"）。已改为保序哈希。
指纹仍为 content-address（§9.3）：字节相同的重复块共享同一 id —— 见未决项 §12.3。

## 9. Cache Stability Report

```
metrics_present=true                         # totalTokens / stablePrefixTokens / stablePrefixRatio
                                             # firstDynamicBlock / firstDynamicTokenOffset / cacheBreakerCount
caseA_user_only_regression=false             # 只改末尾 user 请求：前缀不动（§54 A）
caseB_leading_timestamp_regression=true      # 头部插时间戳：回归，前缀 35→0（§54 B）
caseD_dynamic_early_regression=true          # 动态 memory 进稳定区：回归，前缀 35→0（§54 D）
caseC 见 fingerprint：tool 换序 -> tools 段哈希变（§54 C）
```
含两处正确性修复：
- cache breaker 计数改判 **declared 稳定 + 内容 volatile**（不再依赖已被内容降级的 effective 类）；
- `compareCacheRegression` 不再把"动态尾部变长导致 ratio 下降"误报为回归 —— 回归
  = 前缀 token 减少 或 首个动态块前移（与 §11.5 的 token 口径一致）。

## 10. Round-1 Gate（14/14）

| # | 门槛 | 结果 | 证据 |
|---|---|---|---|
| 1 | 真实规则执行率 = 100% | ✅ | 41/41 fixture `complete=true`（evidence §RULE_EXECUTION） |
| 2 | fixture >= 30 | ✅ | 41 |
| 3 | DO_NOT_TOUCH round-trip 丢失 = 0 | ✅ | blocks_checked=7 blocks_lost=0（evidence §ROUNDTRIP） |
| 4 | Secret 明文泄漏 = 0 | ✅ | leaks=0（evidence §SECRET_LEAKAGE） |
| 5 | 动态字段识别正确 | ✅ | stability 测试 11 形态全中 |
| 6 | timestamp/UUID/session/commit 不误入 STATIC | ✅ | 全 fixture 断言 + 针对性用例 |
| 7 | 相同 prompt fingerprint 确定性 | ✅ | 41/41 |
| 8 | 顺序敏感内容变化 fingerprint 必变 | ✅ | tool reorder 用例 |
| 9 | cache 五项指标有 fixture 验证 | ✅ | 41 fixture 五项类型 + §54 A–D |
| 10 | scoring 无硬编码假绿 | ✅ | `token_not_increased` 写死已删；未测=UNKNOWN |
| 11 | 0 条规则执行时 recommendable != true | ✅ | 断规则用例 FAIL；0/41 假绿 |
| 12 | critical_assertions_pass 为真实 Gate 条件 | ✅ | 缺失=UNKNOWN 并阻断推荐 |
| 13 | 测试全部真实执行并通过 | ✅ | 89/89 |
| 14 | 无新增生产 runtime dependency | ✅ | 本轮零新增依赖；仅改 package.json test 脚本 |

## 11. 修改文件清单

代码（`contextmind/lib/prompt-engine/`，均为此前 untracked 骨架的整改，非新增整仓）：
- **P0-1** `rule-engine.mjs`（调用契约 + 执行报告 + 异常=CRITICAL）
- **P0-2** `secrets.mjs`（模式扩 15 条、重叠去重、redactText/redactDeep/scanSecrets、id 保留）
- `parser.mjs`（content-aware stability / §15 mutability / priority；fence 与 schema 识别补 `inputSchema`）
- `segment-classifier.mjs`（declared + effective 双类）
- `volatility.mjs`（去 version 误报、收紧熵直过、加 git-ref/branch/absolute-path、`stabilityFromContent`）
- `cache-analyzer.mjs`（effective 前缀 + declared breaker、孤立度判据、compareCacheRegression 重写）
- `canonicalizer.mjs`（normalizeBlankLines 保护 fence 内空行）
- `fingerprint.mjs`（segmentHash 保序）
- `scoring.mjs`（三态 gate、删写死 tokenOk、critical_assertions_pass、`rule_execution_complete`）
- `index.mjs`（analyze 默认 redact、ruleExecution 透传、SAFE-002 前置 label-only、gate 接线）
- `quality-analyzer.mjs`（Q13 实现；CJK `\b` 剥离）
- `duplicate-detector.mjs`（findSchemaDuplicates 同指纹重复也报；CJK bigram tokenBag）
- `conflict-detector.mjs`（去掉裸 always↔never 误报对；CJK `\b` 剥离）
- `safety-rules.mjs`（SAFE-002 去重、集中到 index）
- `scoring/quality 等` CJK `\b` 剥离（scoring.mjs）

配置/工程：
- `contextmind/package.json`（test 脚本：`node --test` 递归发现；新增 `test:prompt-lab`）

新增目录：
- `contextmind/fixtures/prompt-lab/`（41 fixture × 2 + manifest.json + 生成器）
- `contextmind/tests/prompt-lab/`（10 个测试文件 + `_helpers.mjs`）
- `docs/decisions/ADR-0007~0010.md`
- `docs/reports/prompt-lab-round1.md`（本报告）+ `prompt-lab-round1-evidence.txt`

文档修订（独立改动集，未与代码同提交）：
- `Downloads/44444444/Token-Mind_Prompt_Lab_Prompt_Optimizer_开发总规范_2026-09.md`：
  顶部修订横幅、§27/§31/§49 按 ADR 标注降级、§48 路径 `11111`→实际参考目录、删 shejiuPro 残留。

## 12. 未解决问题（供下一轮裁决/排期）

1. **Optimizer（Step 7）已知三处硬伤**：浅拷贝就地改输入（违反 §P6）、DO_NOT_TOUCH 保护
   走正则而非 `block.mutability`、私有 tokenizer 标签造假。本轮按 Q3 未触碰，下一轮
   "Safe Optimizer + Patch + 不可变输入 + Reversible" 的第一顺位重写对象。
2. **四档 Mode 只实现 Mode B(SAFE)**：`optimize()` 硬编码 SAFE，A/C/D 缺失（§14）。Optimizer 轮补齐。
3. **content-address 的重复块共享 id**（§9.3 副作用）：`A10` 两个字节相同的规则块 id 相同，
   segmentMap 出现 1 id / 2 块；对 PATCH（"删除其中一个重复块"）会产生歧义 ——
   Optimizer/Patch 轮需要 addressable 实例 id 或 patch 按 (id, occurrence) 定位。
4. **评分维度仍是粗粒度启发式**（quality 维度二值档、risk=severity 加权 + 阈值 60）。
   本 gate 保证"不假绿"；"分数准"需要 Eval 轮用真实任务反标定，不在静态层拍脑袋。
5. **性能目标（§39）未压测**：22KB fixture 确定性 analyze ≈ 93ms；100K token 目标
   （<800ms）需构造大 fixture 实测，非本轮 gate。
6. **预存在失败**：`tests/s8.test.mjs`（handles/telemetry，context_orient vs context_fetch）
   与本次改动无关，需独立排期。
7. **规范 §36 十张表、§35 路由、UI 页面**：按 ADR-0008/0009 推迟到 Eval/DB/UI 轮。
8. **Promptfoo / LLMLingua / GPTCache / LiteLLM 源码**仍留在 Downloads 参考目录，未入库（ADR-0010）。

---

## 结论

> 第一阶段"分析结果是真的"已经成立：41 fixture + 89 测试 + 11 规则 100% 执行 +
> 0 secret 泄漏 + 0 DO_NOT_TOUCH 丢失 + 0 假绿推荐。下一轮按冻结顺序进入
> **Safe Optimizer → Patch → 四档 Mode → 不可变输入 → Reversible Transform → Risk-aware
> Recommendation**（规范 §50 Step 7，先解 §12.1–12.3）。
