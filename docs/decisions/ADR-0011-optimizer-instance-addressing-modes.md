# ADR-0011: Optimizer Instance Addressing + Four-Mode Semantics + Risk-Aware Recommendation

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（Prompt Lab 第二轮执行裁决，对应规范 §50 Step 7）
- 关联: 规范 §14/§15/§26/§P5/§P6/§P10；ADR-0007（Behavior SSOT）；ADR-0010（Eval Provider 显式降级）

## 背景

Round-1 报告冻结了下一轮顺序：**Safe Optimizer → Patch → 四档 Mode → 不可变输入 →
Reversible Transform → Risk-aware Recommendation**，并留下三个未决硬伤（§12.1–§12.3）：

1. **§12.1 优化器浅拷贝就地改输入**：`b.text = normalized` 直接写原对象，违反 §P6
   与 round-1 "manifests are never mutated" 契约。
2. **§12.1 DO_NOT_TOUCH 走正则而非 `block.mutability`**：保护逻辑依赖 inspectSafety
   的第二份正则（且漏掉 JSON Schema 类），与 parser 已产出的 mutability 分叉。
3. **§12.3 content-address 重复块共享 id**：字节相同的两个块 id 相同（§9.3 设计要求），
   按 id 寻址的 DELETE 会把整组重复块全部删掉；segmentMap 也出现 1 id / 2 块。
4. **§12.2 四档 Mode 只有 Mode B**：`optimize()` 硬编码 SAFE。

## 决策

### D1. Patch 按 (blockId, occurrence) 定位实例，不改 content-address IR

块 `id` 保持内容哈希（§9.3，跨会话稳定、可 diff）。每个 patch op 的目标改为
**实例引用** `{ blockId, occurrence }`：occurrence = 该 id 在 base manifest 中第几次
出现（0-based）。applyPatch 分三阶段，全部对 base 快照解析后落位：

1. 删除（DELETE_DUPLICATE_BLOCK）→ 对 base 解析 occurrence，标记删除集合；
2. 内容变更（NORMALIZE_BLOCK / REPLACE_BLOCK）→ 对 base 解析后映射到存活数组；
   文本变更的块用 rebuildBlock 重算 content id / hash / tokenCount；
3. 布局（MOVE_BLOCK / MERGE_BLOCKS）→ 对存活数组顺序执行。

DELETE 的逆操作在 §26 op 词表里没有 INSERT 原语，因此 reverseOps 对 DELETE 显式
计数为不可逆；恢复路径 = P6 保留的 original 快照，而不是伪造可逆。NORMALIZE/
MOVE/REPLACE 提供可表达逆操作。

### D2. 四档 Mode 的静态核心语义（规范 §14）

| Mode | 规范名 | 静态核心行为 |
|---|---|---|
| A | ANALYZE ONLY | 零 op，只返回分析（P6 bundle + recommendation=ANALYZE_ONLY） |
| B | SAFE | exact dedup + 安全空白规范化（全部 op risk=SAFE）；schema 去重只出**建议** |
| C | CONSERVATIVE REWRITE | B 子集 + 语义候选（near-dup merge 等）进入 pendingEval；静态核心**不伪造 LLM 改写**（P10） |
| D | EXPERIMENTAL | 静态核心无有损压缩器适配器 → 显式 EXPERIMENTAL_UNAVAILABLE 降级（ADR-0010 同款，不静默 no-op） |

schema 去重在 B/C 均不自动 apply：tool_schema 块按 §15 是 DO_NOT_TOUCH，规范 §14
Mode B 对 schema 去重的措辞本来就是"建议"。

### D3. DO_NOT_TOUCH 保护统一走 block.mutability

保护判定 = `block.mutability === "DO_NOT_TOUCH"`。parser 在 §15 content 类
（SQL/diff/JSON Schema/验收/危险操作/secret，`untouchableLabels`）命中时已把块标为
DO_NOT_TOUCH，优化器不再持有第二份正则（round-1 P0-2 同思路）。删除组整体跳过
当任一块为 DO_NOT_TOUCH；normalize 跳过 DNT 及 code/diff/tool_schema 等 kind。

### D4. Risk-aware Recommendation ≠ Publish Gate

两者问题不同，分开建模：

- **publish gate（§17.6）**回答"能否上线/晋升"：critical_assertions_pass 缺 Eval 证据
  即 UNKNOWN 并阻断 recommendable（round-1 gate #12，不变）。
- **recommendation**回答"这份 patch 现在能不能 apply 到文件"：op 全为 SAFE 且机械
  验证（DO_NOT_TOUCH 字节保留、patch 干净可应用、token 未增、两侧规则完整执行）
  通过 → SAFE_APPLY。P10 只对 SEMANTIC_REWRITE 及以上要求 Eval，SAFE op 不需要。

Mode C 有 pendingEval → EVAL_REQUIRED（apply=false）。Mode D 无适配器 →
EXPERIMENTAL_UNAVAILABLE。规则损坏/验证失败/风险超限 → BLOCKED。

## 后果

- 优点：§12.1–§12.3 全部关闭；A10 类重复块只删真副本；输入在任何路径下不可变；
  token 计数全部复用 lib/tokens.mjs；UI/CLI 未来可以无歧义地把 patch 应用到文件
  （baseFingerprint 防 STALE）。
- 代价：DELETE 不可从 ops 反向（需 original 快照）；schema 去重在 SAFE 下只能是建议；
  Mode C/D 的"真正改写"要等 Step 10（LLM rewrite adapter）与 Eval Provider 接入。
- 回退：若未来出现需要移动重复块（同 id 多实例）的场景，可在 op 上再加 `fromIndex`
  显式坐标，不影响本模型兼容性（旧 op 无该字段时退化为 occurrence 解析）。
