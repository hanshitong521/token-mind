# Prompt Lab 第三轮整改报告（§16 Layout Engine 前置 + Step 8 UI / 路由 / DB）

> 日期：2026-09-09 ｜ 范围：round-2 冻结顺序 —— 布局引擎（未决 #1 前置小步）→
> Step 8 UI / 路由 / DB（规范 §31/§32/§33/§35/§36/§56/§58/§59），ADR-0012
> 机器可验证证据：`docs/reports/prompt-lab-round3-evidence.txt`
> （`contextmind/scripts/prompt-lab-round3-evidence.mjs` 生成，自校验失败即非零退出）
> 本报告 Gate 见 §7，证据 44 条断言全绿。

---

## 1. 本轮目标（来自 round-2 §10 冻结项）

| 冻结项 | 交付 |
|---|---|
| 未决 #1：Layout/Reorder 的 mutability 映射 | `lib/prompt-engine/layout.mjs`：实例级 lane 报告 + frontier 违规 + SAFE_REORDER 单条 MOVE 候选（ADR-0012 D1） |
| §36 十张表 / §35 路由 / UI（Step 8） | 8 张消费者驱动表（ADR-0012 D2）+ `lib/prompt-lab/api.mjs` 全路由（D3）+ `prompt-lab-server.mjs` 可写 server 与 `prompt-lab.html` 静态 UI（D4） |
| 未决 #3/#5：segmentMap 重复块展示 | UI 的 block 列表按实例渲染（#i + blockId + occurrence），A10 重复块逐实例可见 |
| §56/§59 版本绑定与 telemetry | 每次 analyze/optimize/patch/undo 写版本，绑定 engine/rule-pack/tokenizer/optimizer 版本；prompt_meta 计数器 |
| evaluate 诚实性（ADR-0010） | `PROMPTFOO_NOT_INSTALLED` 显式状态进入 UI（Eval 页在 Step 9 前显示 unavailable） |

## 2. Layout Engine（§16）

- 映射单一来源仍为 `segment-classifier.mjs`（KIND_SLOT / LAYOUT_SLOTS）；
  `layout.mjs` 补实例级能力，全部纯函数、不 mutate 输入（deepFreeze 测试覆盖）。
- `layoutReport`：8 lane 聚合（块数/token/refs）；逐实例 order（kind/lane/
  stability/effective/mutability/movable）；frontier = 首个 DYNAMIC/EPHEMERAL
  实例（复用 analyzeCacheStability 边界）；违规 = frontier 之后仍为稳定的实例
  + L7 user request 不在末尾（LAYOUT-002）。
- `moveCandidates`：仅当 `mutability === "SAFE_REORDER"` 且位于 frontier 之后，
  产出单条 MOVE op（含确定性 `to`），`autoApplicable=false` —— 布局 MOVE 永不
  自动 apply（顺序变化属 SEMANTIC_REWRITE，P10）；rule/instruction（SAFE_COMPACT）
  标 manual（sequence-sensitive），DO_NOT_TOUCH 标不可动。
- 41 fixture 全量扫描零抛错、lane 聚合自洽（evidence `fixtures_layout_scanned=41`）。

## 3. DB（§36 消费者驱动）

`lib/db/prompt-lab-schema.mjs`（`ensurePromptLabSchema` + 版本 1）在
`<projectRoot>/.contextmind/prompt-lab.db` 落地 8 张表（evidence `schema_tables=8/8`）：

- 文档 = source_hash 身份（同字节同一 doc，evidence `document_persisted=true`）；
- 版本链 `prompt://<doc>/<n>`（analyze / optimize / patch_apply / restore），
  绑定 ENGINE/RULE_PACK/TOKENIZER 版本（§56）；
- blocks（含 occurrence，支持重复块逐实例回放）、findings（含 requires_eval /
  auto_applicable）、fingerprints、patches（applied/reversed 状态）、
  provider_capabilities（静态注册表启动 upsert，§58）；
- §59 计数器在 prompt_meta：analyze/optimize/import/layout/safe_patch/
  semantic_patch/patch_apply/patch_rejected/patch_reverse/eval_run/
  eval_regression —— evidence `telemetry_*` 全绿；
- eval_* 3 张表推迟 Step 9（ADR-0008 消费者原则）。

## 4. API（§35 + §33 交互）

`lib/prompt-lab/api.mjs` 全部路由（纯函数，无 HTTP 知识）：

- analyze / optimize（mode A–D，返回完整 P6+layout bundle，持久化版本与 patch）
- diff / fingerprint / tokenize / layout / export（markdown/messages/anthropic/patch）
- history/list + history/detail；provider/capabilities
- **patch/apply**：STALE 守卫实例级 op 单条或子集应用 → child version + applied 行；
  坏 op 计入 patch_rejected（evidence `stale_op_rejected=true`）
- **patch/reverse**：快照还原为新 restore 版本（不伪造 op 级逆）
- evaluate：`PROMPTFOO_NOT_INSTALLED` 显式降级（evidence `route_evaluate_downgrade=true`）
- E01（SQL DO_NOT_TOUCH）Mode B 零 op（evidence `route_optimize_dnt_zero_ops=true`）

## 5. UI / Server（Step 8，ADR-0009 静态 HTML）

`prompt-lab-server.mjs`（node:http 零依赖，默认 8898 / `--port 0` 自动分配）
挂载 `/prompt-lab` 单文件页面 `prompt-lab.html` 与 JSON 路由、`/api/nav` 增加
`prompt_lab`。页面 6 个 tab：

| 页 | §32 行为 | §33 交互 |
|---|---|---|
| Analyze | 输入 + Blocks 三栏 + Findings | severity 过滤 chips；hover 块显示 kind/mutability；点 finding 跳到对应块高亮 |
| Optimize | Before\|After + Token/Quality/Cache 差值 + Risk | 逐条 op 接受 / Apply SAFE 子集（不含 Experimental/布局/红色阻断）/ 撤销；推荐横幅（SAFE_APPLY/EVAL_REQUIRED/BLOCKED…） |
| Cache | Stable Prefix 条 + breaker 标记 + §16 布局违规表 | 违规行显示 可移动/不可自动 与原因 |
| Token | §13 层表格（System/Rules/Tools/Project/Dynamic/User）+ kind 明细 | — |
| History | 版本列表（uri/kind/mode/分数） | 详情（blocks+findings+text）、复制、patch_apply 可撤销 |
| Provider Rules | §58 注册表 + engine/eval 状态 | — |

红色阻断规则：DELETE/REPLACE 命中 CRITICAL/HIGH finding 的块 → 单条按钮变为
"阻断"（evidence 由 HTTP E2E 页面可达性背书，`http_*` 全绿）。

## 6. Test Result

```
prompt-lab: 143/143 pass  (node --test "tests/prompt-lab/*.test.mjs")
全仓:       324/325 pass —— 唯一失败 tests/s8.test.mjs G-S8-06（预存在，
            handles/telemetry 链路，0 引用 prompt-engine，round-1 已排期）
```

新增测试 26 个：

| 文件 | 断言方向 |
|---|---|
| `tests/prompt-lab/layout.test.mjs`（7） | lane 表 8 段；kind→slot 正确；volatile rule=frontier 且 DO_NOT_TOUCH；SAFE_REORDER after frontier → MOVE 候选（非 auto）；SAFE_COMPACT manual；全静态零违规；LAYOUT-002 user-last；deepFreeze 不可变 + bundle 确定性 |
| `tests/prompt-lab/prompt-lab-store.test.mjs`（6） | schema+telemetry 零值+provider seed；文档 source-hash 身份；saveVersion 全量落库+history；acceptPatch child+applied 行；坏 op 拒绝并计数；undo 快照还原版本链 analyze→patch_apply→restore |
| `tests/prompt-lab/prompt-lab-api.test.mjs`（8） | analyze/optimize(E01 零 op)/diff/fingerprint/tokenize/layout/provider/evaluate 降级/export 全格式/import+版本过滤/patch apply+reverse 文本级还原 |
| `tests/prompt-lab/prompt-lab-server.test.mjs`（5） | 子进程 http：页面 200、analyze 持久化、optimize→apply→undo→history 链、nav+providers+404、evaluate 状态 |

## 7. Round-3 Gate（全部带机器证据，见 evidence 文件）

| # | 门槛 | 结果 | 证据 |
|---|---|---|---|
| 1 | Layout 映射单一来源（segment-classifier），layout 只补实例层 | ✅ | lane_labels_match_spec16 |
| 2 | frontier 语义与 cache analyzer 同边界 | ✅ | frontier_is_first_dynamic=true |
| 3 | MOVE 候选只给 SAFE_REORDER 且绝不自动 | ✅ | move_candidates_only_safe_reorder=true / layout_moves_never_auto=true |
| 4 | 41 fixture layout 扫描零抛错、聚合自洽 | ✅ | fixtures_layout_scanned=41（lane_agg=true） |
| 5 | 8 张表消费者驱动落地 | ✅ | schema_tables=8/8 |
| 6 | 版本链绑定 + telemetry 计数真实 | ✅ | version_no_sequence=1 / telemetry_*=1（analyze/apply/reverse/rejected） |
| 7 | §35 路由全部可达 | ✅ | route_* 全绿（analyze/optimize/layout/evaluate/caps/export/tokenize…） |
| 8 | patch apply 单条/子集 + STALE 拒绝 + undo 快照还原 | ✅ | patch_apply_single_op_ok=true / stale_op_rejected=true / patch_reverse_snapshot_ok=true |
| 9 | E01 DO_NOT_TOUCH Mode B 零 op（UI 不再误改 SQL） | ✅ | route_optimize_dnt_zero_ops=true |
| 10 | evaluate 显式降级，不静默 | ✅ | route_evaluate_downgrade=true / http 页展示状态 |
| 11 | 真实 HTTP 端到端可用 | ✅ | http_page_200 / analyze / optimize / history_persisted |
| 12 | 全量测试真实执行并通过 | ✅ | prompt-lab 143/143、全仓 324/325（仅剩 s8） |
| 13 | 零新增生产 runtime 依赖 | ✅ | 仅 node: 内置模块（node:http/sqlite/crypto…），未改 package.json |
| 14 | Step 9/10 不提前伪造（eval 表/LLM 改写未建未写） | ✅ | ADR-0012 D2/D5 + evaluate=PROMPTFOO_NOT_INSTALLED |

## 8. 修改文件清单

代码（新增）：
- `lib/prompt-engine/layout.mjs`（实例级 §16 布局引擎）
- `lib/db/prompt-lab-schema.mjs`（8 张表 + ensurePromptLabSchema）
- `lib/prompt-lab/store.mjs`（PromptLabStore：文档/版本/块/findings/patch/
  fingerprint/telemetry/provider 快照 + accept/undo）
- `lib/prompt-lab/api.mjs`（§35 路由处理器）
- `prompt-lab-server.mjs`（node:http 可写 server）
- `prompt-lab.html`（静态单文件 UI，6 tab）

测试/脚本/文档：
- `tests/prompt-lab/layout.test.mjs`、`prompt-lab-store.test.mjs`、
  `prompt-lab-api.test.mjs`、`prompt-lab-server.test.mjs`（新增 26 用例）
- `scripts/prompt-lab-round3-evidence.mjs`（自校验证据收集器）
- `docs/decisions/ADR-0012-step8-ui-routes-db-layout.md`
- `docs/reports/prompt-lab-round3.md`（本报告）+ `prompt-lab-round3-evidence.txt`

## 9. 未决问题（下一轮裁决/排期）

1. **Step 9 — Promptfoo / Builtin Eval**：接 Eval provider 后补 3 张 eval_* 表、
   Eval 矩阵页、critical_assertions 从 UNKNOWN 变 PASS 的路径；此前
   publish gate 保持关闭（round-1 gate #12 语义）。
2. **Step 10 — Conservative Rewrite adapter**：LLM rewrite + Eval 证据链；
   当前 Mode C 仍只排队 pendingEval。
3. **Step 11 — Export fidelity**：AGENTS.md/CLAUDE.md/Cursor Rule/SKILL.md
   序列化器与 `prompt://` 导出路由；UI 导出目前为块文本拼接 + markdown。
4. **Layout auto-move 保持关闭**是刻意决策（ADR-0012 D1）；若未来要在
   SAFE_REORDER 内自动推进，需先过 Eval 标定。
5. **评分标定**（quality 粗粒度二值档）留 Eval 轮反标定（round-2 未决 #4）。
6. **UI 性能**：22KB fixture 全链路 analyze+optimize+layout 本地毫秒级；
   100K token 目标（<800ms，§39）留 Step 12 runtime 压测。
7. **预存在失败**：`tests/s8.test.mjs` G-S8-06（handles/telemetry）待独立排期。
8. **全 prompt-engine/lib/prompt-lab 仍 git untracked**（入场即如此，本轮未提交）。

---

## 结论

> Step 8 冻结项落地：Layout Engine（实例级 + SAFE_REORDER 单条 MOVE）→
> 消费者驱动 8 张表 → §35 全路由 → 可写 server + 静态 UI（Analyze / Optimize /
> Cache / Token / History / Provider Rules）→ patch 单条接受/撤销 → §59 telemetry。
> 143/143 prompt-lab、324/325 全仓（仅剩预存在 s8）、零新增依赖、41 fixture
> layout 扫描全绿、HTTP E2E 全绿。下一轮进入 **Step 9 Promptfoo Adapter**
> （补 eval 表与 Eval 页），随后 **Step 10 Conservative Rewrite**。
