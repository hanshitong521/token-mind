# Prompt Lab 第二轮整改报告（Step 7：四档 Mode Safe Optimizer + 实例级 Patch）

> 日期：2026-09-09 ｜ 范围：规范 §14/§26/§50 Step 7，解 round-1 §12.1–§12.3
> 裁决：按 round-1 冻结顺序执行 Safe Optimizer → Patch → 四档 Mode → 不可变输入 →
> Reversible Transform → Risk-aware Recommendation（决策落 ADR-0011）
> 机器可验证证据：`docs/reports/prompt-lab-round2-evidence.txt`
> （`contextmind/scripts/prompt-lab-round2-evidence.mjs` 生成，自校验失败即非零退出）

---

## 1. 本轮要关掉的三个硬伤（round-1 §12.1–§12.3）

| # | 硬伤 | 修法 | 证据（evidence §…） |
|---|---|---|---|
| 12.1 | `optimizeSafe` 浅拷贝就地写 `b.text/hash`，违反 §P6 不可变 | 全管线纯函数；所有变更走 patch op，applyPatch 只产出新块；deepFreeze 输入全流程不被写 | CORE_REGRESSIONS `input_manifest_not_mutated=true` |
| 12.1 | DO_NOT_TOUCH 保护走正则而非 `block.mutability` | 统一判定 `block.mutability === "DO_NOT_TOUCH"`；parser 的 `untouchableLabels`（§15 内容类）已负责标记；optimizer 不再持有第二份正则 | CORE_REGRESSIONS `dnt_sql_zero_ops=true`；OPTIMIZER_SWEEP_SAFE `dnt_blocks_checked=66` |
| 12.1 | optimizer 内私有 `countEstimated` 标签造假 | token 计数全部复用 `lib/tokens.mjs`（`countTokens`），与块上标注的 `heuristic:chars/4` 一致；NORMALIZE 后由 `rebuildBlock` 用同一函数重算 | — |
| 12.2 | 四档 Mode 只实现 Mode B | 完整 A/B/C/D 分发，见 §4 | MODE_MATRIX |
| 12.3 | content-address 重复块共享 id → DELETE 误删整组 | patch op 以 `(blockId, occurrence)` 寻址实例；A10 两块只删 occ=1 | INSTANCE_ADDRESSING `a10_delete_occ1_keeps_first=true` |

> **§12.3 的严重性（round-1 未爆出）**：旧 `optimizeSafe` 对 A10 这类双重复块会**把两块全删**
> ——`blocks.filter(b => !removeIds.has(b.id))` 对共享 id 的两块同时命中。本轮实例级寻址
> 直接消除该数据竞争面。

## 2. Patch 模型（`patch.mjs` 重写）

- **实例寻址**：op 目标 = `{ blockId, occurrence }`；occurrence 0-based，按 base manifest
  中同 id 块的先后序确定（确定性、跨会话可复现）。内容寻址 IR 与指纹语义不变。
- **分阶段 apply**（occurrence 永远对 base 快照解析）：
  1. 删除 → 对 base 标记移除集合；
  2. 内容（NORMALIZE/REPLACE）→ base 解析后映射到存活数组；`rebuildBlock` 重算
     content id / hash / tokenCount（文本变则 id 变，保持 content-address 自洽）；
  3. 布局（MOVE/MERGE）→ 对存活数组顺序执行。
- **STALE 保护不变**：live root ≠ baseFingerprint 即 `STALE_PATCH`（throw 或软返回）。
- **可逆性诚实化**：`reverseOps` 只对可表达逆操作的 op（NORMALIZE/MOVE/REPLACE）
  产出逆序列；DELETE 因 §26 词表无 INSERT 原语而被显式计数
  （`fullyReversible=false`），恢复路径 = P6 保留的 original 快照 —— 不伪造可逆。

## 3. 不可变输入 + P6 bundle

`optimizeManifest(manifest)` 第一步 `structuredClone`，任何 pass 不写输入；返回：

```text
original / normalized / optimized   三个 manifest + fingerprint + tokens
patch / patchOps / reverse
findings / suggestions / pendingEval
verification / recommendation / summary
```

- `normalized` = 只 apply NORMALIZE op 的中间产物（P6 的 "normalized" 层）；
- `optimized` = apply 全量 op 的产物；
- 每一层都有指纹，任意两步可用 `diff()` 复核。

## 4. 四档 Mode（规范 §14，静态核心语义见 ADR-0011 D2）

| Mode | 名称 | 行为 | Recommendation |
|---|---|---|---|
| A | ANALYZE ONLY | 零 op，不改变 manifest | `ANALYZE_ONLY` |
| B | SAFE（默认） | exact dedup + 安全空白规范化；schema 去重仅**建议** | `SAFE_APPLY`（验证过） |
| C | CONSERVATIVE REWRITE | B 子集 + near-dup 等语义候选进入 `pendingEval`；静态核心**不伪造 LLM 改写** | 有 pending → `EVAL_REQUIRED` |
| D | EXPERIMENTAL | 无有损压缩适配器 → 显式降级，零 op | `EXPERIMENTAL_UNAVAILABLE` |

要点：
- **schema 去重在 B/C 都不自动 apply**：`tool_schema` 块按 §15 是 DO_NOT_TOUCH，
  规范 §14 Mode B 原文即"重复 schema 去重**建议**"（evidence `schema_dup_auto_applied=false`）。
- **Mode C 的诚实边界**：语义合并需要 LLM + Eval（§P10），Step-7 静态核心只负责把
  候选找出来排队（`requiresEval`），改写本身留到 Step 10 Conservative Rewrite。
- **Mode D 不静默**：没有 LLMLingua/Headroom 之类压缩器适配器就明确返回
  `EXPERIMENTAL_UNAVAILABLE`（ADR-0010 同款"未装=显式降级"）。

## 5. Verification（机械证明，区别于 Eval）

`verifyOptimization` 的 4 项硬检查 + 2 项规则侧检查：

```text
dnt_preserved         每个 DO_NOT_TOUCH 实例字节级存活（hash 多重集相等）
patch_applies_clean   applyPatch ok 且 0 skipped
ops_risk_safe         patch 内无高于 SAFE 的 op
token_not_increased   估算总量未增
rules_complete_before / rules_complete_after（可选，index 层注入）
```

41 个 fixture 全量 Mode B 扫描：`verify_ok_fixtures=41/41`（evidence）。

## 6. Risk-aware Recommendation（与 Publish Gate 分离，ADR-0011 D4）

两个问题分开答：

- **Publish Gate（§17.6）**：能否晋升上线。无 Eval 证据 → `critical_assertions_pass=
  UNKNOWN` → `recommendable=false`（round-1 gate #12 语义，本轮未改）。
- **Recommendation**：这份 patch 现在能不能 apply 到文件。P10 只对
  SEMANTIC_REWRITE 及以上要求 Eval —— SAFE op 不需要；只要机械验证通过 +
  规则完整执行 + 风险在容差内 → `SAFE_APPLY`。

实测（evidence §OPTIMIZER_SWEEP_SAFE）：41 fixture 中 `SAFE_APPLY=2`（重复类）、
`ANALYZE_ONLY=39`；`plaintext_secret_leaks_in_optimized_output=0`（F* 组优化输出
不含任何 secret 原文）。

## 7. Test Result

```
prompt-lab: 117/117 pass  (node --test "tests/prompt-lab/*.test.mjs")
全仓:        298/299 pass —— 唯一失败 tests/s8.test.mjs G-S8-06（预存在，
            handles/telemetry 链路，0 引用 prompt-engine，round-1 已排期）
```

新增测试文件：

| 文件 | 断言方向 |
|---|---|
| `tests/prompt-lab/patch.test.mjs` | 实例寻址（同 id 两块删 occ1 只留 1 块 / 4 副本删 occ1,2 留 2）；输入不 mutate；STALE_PATCH；NORMALIZE 重算 id/hash/tokenCount；REPLACE 换/插；MOVE 确定性；reverseOps 可逆边界；patchOpsBetween |
| `tests/prompt-lab/optimizer.test.mjs` | 四档 Mode；A10 2→1；deepFreeze 不可变；DO_NOT_TOUCH（E01 零 op + 全 fixture 字节保留）；schema 建议不自动 apply；Mode C pendingEval；Mode D 降级；optimizeSafe 兼容；recommendation 与 gate 分离（含带 Eval 证据后全绿晋升用例）；全 fixture sweep；P6 bundle |

## 8. Round-2 Gate（全部带机器证据，见 evidence 文件）

| # | 门槛 | 结果 | 证据 |
|---|---|---|---|
| 1 | 输入 manifest 全流程不可变 | ✅ | deepFreeze + `input_manifest_not_mutated=true` |
| 2 | DO_NOT_TOUCH 由 block.mutability 决定 | ✅ | E01 零 op；66 个 DNT 实例扫描 |
| 3 | 重复块只删真副本（A10 2→1） | ✅ | `a10_delete_occ1_keeps_first=true` |
| 4 | 同 id 多实例可精确寻址 | ✅ | patch.test 4 副本留 2 |
| 5 | NORMALIZE 后 id/hash/tokenCount 重算 | ✅ | patch.test `NORMALIZE recomputes…` |
| 6 | 四档 Mode A/B/C/D 全部可达且语义正确 | ✅ | MODE_MATRIX 全绿 |
| 7 | schema 去重=建议，绝不自动 apply | ✅ | `schema_dup_auto_applied=false` |
| 8 | 41 fixture Mode B 验证全过 | ✅ | `verify_ok_fixtures=41/41` |
| 9 | 优化输出 0 secret 泄漏 | ✅ | `plaintext_secret_leaks_in_optimized_output=0` |
| 10 | token 不增（lossless 才有 delta<0） | ✅ | `total_delta_tokens=-35`、每 fixture `tokens_not_increased=true` |
| 11 | STALE patch 拒绝 | ✅ | `stale_patch_refused=true` |
| 12 | P6 bundle（original/normalized/optimized/patch/fingerprint）齐备 | ✅ | `p6_bundle_complete=true` |
| 13 | Recommendation 不绕过 publish gate | ✅ | gate#12 语义保留 + optimizer.test 分离用例 |
| 14 | 全量测试真实执行并通过 | ✅ | prompt-lab 117/117 |
| 15 | 零新增生产 runtime 依赖 | ✅ | 仅 node: 内置模块，未改 package.json |

## 9. 修改文件清单

代码（`contextmind/lib/prompt-engine/`）：
- `patch.mjs`（重写：实例寻址、分阶段 apply、rebuildBlock、reverseOps、patchRiskOf、patchOpsBetween 重做）
- `optimizer.mjs`（重写：四档 Mode、纯函数管线、exactDedupOps/normalizeOps/schemaDupSuggestions/semanticCandidates、verifyOptimization、recommendFor、finalizeOptimization、optimizeSafe 兼容壳）
- `index.mjs`（optimize 入口接新引擎 + mode/assertions/allowExperimental；输出 P6 + verification + recommendation；导出 OPTIMIZE_MODE/RECOMMENDATION/reverseOps 等）

测试/脚本/文档：
- `contextmind/tests/prompt-lab/patch.test.mjs`（新增 12 用例）
- `contextmind/tests/prompt-lab/optimizer.test.mjs`（新增 16 用例）
- `contextmind/scripts/prompt-lab-round2-evidence.mjs`（新增证据收集器，自校验）
- `docs/decisions/ADR-0011-optimizer-instance-addressing-modes.md`（新增）
- `docs/reports/prompt-lab-round2.md`（本报告）+ `prompt-lab-round2-evidence.txt`

## 10. 未决问题（下一轮裁决/排期）

1. **Layout / Reorder（§16 Stable Layout Engine、§14 B 的"确定性排序/分区"）**：本轮
   SAFE 只做 dedup + normalize；真正的 MOVE/EXTRACT 排序 pass 需等 layout 语义与
   mutability 映射定稿（DO_NOT_TOUCH 块不可搬、EPHEMERAL 尾置等），属独立子模块。
2. **Mode C 的 LLM 改写（Step 10 Conservative Rewrite）**：静态核心只排队不改写；
   需要引入 LLM rewrite adapter 并强制 Eval 证据后才允许标记"推荐应用"（§P10）。
3. **Mode D 压缩器适配器**：LLMLingua/Headroom 接入契约未定（ADR-0010 保持"未装=显式
   降级"）；`compressorAdapter` 目前只是开关位，接真实适配器时改为回调注入。
4. **评分标定**：quality 维度二值档仍粗（A10 去重导致 structure 子分下降从而
   `quality_after_ge_before=FAIL` 是已知启发式副作用，不是语义回退）；留 Eval 轮反标定。
5. **重复块语义与 segmentMap**：content-address 下 1 id / 2 块在 diff/segmentMap 展示上
   仍显"少一个实例"；本轮 patch 层已可精确寻址，UI 展示层留 Step 8。
6. **预存在失败**：`tests/s8.test.mjs` G-S8-06（handles/telemetry）待独立排期。
7. **§36 十张表、§35 路由、UI（Step 8）**：ADR-0008/0009 保留，待 DB/UI 轮。

---

## 结论

> round-1 冻结的 Step 7 顺序已全部落地：Safe Optimizer（重写）→ Patch（实例级寻址）→
> 四档 Mode → 不可变输入 → Reversible Transform → Risk-aware Recommendation。
> 41 fixture 全量验证通过、0 secret 泄漏、0 DO_NOT_TOUCH 触碰、0 假 apply 推荐、
> prompt-lab 117/117、全仓仅剩预存在 s8。下一轮按冻结顺序进入 **Step 8 UI / 路由 / DB**
> 与 **Step 10 Conservative Rewrite adapter**，布局引擎（未决 1）建议作为 Step 8 前置
> 小步先落 MOVE/EXTRACT 的 mutability 映射。
