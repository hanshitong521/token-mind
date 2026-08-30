# Token-Mind 深度开发计划（DEEP-DEV-PLAN）

> 版本：v1.0（2026-08-30 定稿）
> 用途：供任意后续会话直接开工的自包含开发文档。开工前只需读本文件 + `bench/report.md`。
> 依据：两轮代码盘点（两侧均精确到文件行号）+ `bench/report.md` 实测基线。行号对应盘点当日代码，若后续代码改动以函数名为准。

---

## 0. 一句话瓶颈

当前三层（CC balanced 工具输出压缩 / Save-The-Token 指令层 / RTK 手动）全部是**通用文本压缩**——不认识输出语义、不知道预算、压错了没有兜底判定。下一阶段就是把"压文本"升级成"**提事实 + 带预算 + 有充分性兜底 + 有回归门**"。

---

## 1. 前提与实测基线（不许跳过）

来自 `bench/report.md`（2026-08-30 实测）：

| 层 | 工具输出节省 | 事实丢失 | 结论 |
|---|---|---|---|
| RTK | 98.9% | 丢 pytest 计数、Java 堆栈类名/行号、BUILD SUCCESS、req-ID | 高收益高风险，只留手动非证据场景 |
| CC balanced | 94.6% | 仅 big_log 丢一个 req-ID | 当前主力，hook 已接入 `~/.claude/settings.json` |
| CC aggressive | 94.6% | 同 balanced | **零增益，禁用** |

会话回放（122,240 tok）：CC 省 72%（近零丢失）；RTK 省 95%（丢 git log/错误证据）。

**三条已定位的改进缝**：
1. pytest/build 用例 CC 省 0%、RTK 省 97% 但丢证据 → 需要结构化适配器（两全）。
2. big_log 丢 `req-002747` → 压缩器不知道模型在追踪什么 → 需要意图保护。
3. 回放里 CC 剩余 28% 大半是重复命令输出 → 需要增量/delta。

**work-mind（E:\workA\A-skill\work-mind，产品名 ContextForge）盘点结论**："壳重核轻"。重的是壳（Docker+Redis+BullMQ+Ollama+HTTP API，烂尾主因），核心资产 **Tier A ≈ 5700 行纯 Node stdlib，零 npm 依赖、零服务依赖**，可整体搬进本项目。

---

## 2. 目标与明确不做

### 目标（本期做）
1. **结构化适配器**：对 pytest/gradle/npm/go test 等已知工具输出确定性 JSON 摘要（计数、失败用例、首错行、文件:行号）。
2. **预算门 + 意图保护**：token 计价的输出预算；模型当前任务里的实体（ID、报错串）进保护名单。
3. **充分性门 + ABSTAIN**：压缩结果过 term-recall 判定，不足即回退原文。
4. **准确性回归门**：金标 + holdout + CI 红线，让每次迭代有数字背书。

### 明确不做（防重演 work-mind 失败）
- **不做** Redis / Ollama / BullMQ / Docker / HTTP API——目标形态是零服务、零部署、随 CLI/进程跑。
- **不做** 代码索引——CodeGraph 已覆盖（`mcp__codegraph__*`）。
- **不做** topK 加宽换召回——work-mind 实测 +1.5pp R@5 换 ~800 token/次，已废弃；缺召回用 Quality Guard 预算重试解决（见 §6）。
- **不做** 通用 RAG 产品定位漂移——检索层只在 P5 门槛触发时评估。

---

## 3. 资产移植清单（work-mind → 本项目）

目标目录：**`context-compress-main/src/forge/`**（与 CC 同 esbuild 构建链，同进程调用）。评估资产放 `bench/forge-golden/`。

### Tier A — 复制即用（零 npm 依赖，纯 crypto/fs/path/env）

| 包 | 文件（行数） | 提供什么 |
|---|---|---|
| 搜索 Gate | `mcp-client/lib/search-gate.mjs`(267)、`query-intent.mjs`(176)、`query-normalize.mjs`(15)、`release.mjs`(4)、`src/lib/doc-read-traps.mjs`(123) | token 深度预设（800/1400/2000）、自适应 top_k、LOW_SCORE_ABORT(阈值0.30)/SMALL_FILE_READ/overview 引导等阻断语义，全部纯函数返回文本 |
| 工具回包 Gate 栈 | `tool-result-gate.mjs`(395)、`sql-result-compress.mjs`(152)、`context-dedup.mjs`(141)、`context-ledger.mjs`(181)、`token-estimate.mjs`(9, `ceil(utf8/4)`)、`gate-envelope.mjs`(34, wrapIfSaves 负收益旁路)、`incremental-read.mjs`(129)、`evidence-store.mjs`(143)、`search-repeat-guard.mjs`(102)、`retrieval-ledger.mjs`(100)、`replay-metrics.mjs`(64)、`embed-codec.mjs`(59)、`transcript-parse.mjs`(119)、client `search-cache.mjs`(164) | **≈1700 行**：类型检测(json/sql/log/md/code)、JSON 收缩(串>400裁/数组cap12/键cap40)、日志错误窗保留、budgetTruncate+get_evidence 指针、sha256 去重、变更文件 delta 读 |
| 充分性 | `src/retrieval/sufficiency.mjs`(126)、`outcome.mjs`(58) | 规则阶梯判定 + band-ABSTAIN（置信饱和 bug 已修，用 rerank_score 非位置分） |
| 语料哈希 | `src/lib/index-identity.mjs`(99) | sha256 语料摘要（增量缓存指纹可用） |
| （P5 才搬）检索核心 | `src/lib/store.mjs`(1261, 含 `tokenAwarePack`:773-814 贪心背包 + Quality Guard:987-1001)、`document-reranker.mjs`(162, 密度.40/词法.20/意图.20/版本.10/时序.10)、`chunker/markdown-strategy.mjs`(101)、`chunker/strategy.mjs`(88, stub 一处 pino) | 贪心打包 skip-too-big-and-continue、预算不足 1.5x 重试 cap 8000 |

### Tier B — 离线评估（零服务，lexical 模式确定性）

| 文件 | 说明 |
|---|---|
| `scripts/bench-retriever-gold.mjs`(327) | **可移植回归 harness**：直连 chunker+store 进程内跑；`--ci` 模式 Recall@5 掉 >2pp 即 FAIL；`--semantic` 自动降级 lexical |
| `.contextforge/benchmarks/golden/*.json`、`.contextforge/state/current-baseline.json` | 金标用例 + 基线 |
| `.contextforge/evaluation/evaluation-contract-v2.json`(58, 入口 contract 7 行是指针) | 基线 id、forbidden_capabilities（禁 case 特化/禁评测泄漏）、red line 定义 |
| `scripts/lib/session-replay-judge.mjs`(119, 零 import) | 纯判定器 |
| `test/unit/v15-token-gate.test.mjs` | token gate 单测，直接复用 |

### Tier C — 抛弃（不要搬）
`src/api/`(1021)、`src/queue/`(BullMQ)、`src/lib/redis.mjs`、`src/embed/*`、`watcher.mjs`、`rebuild*.mjs`、`token-accounting.mjs`(487, Redis)、`security/*`、`mcp-client/server.mjs`(549)、在线 eval 脚本（硬依赖 `TOKEN_SKILL_API_BASE`）。

> 注：上游 `docs/MCP-AI-FINDINGS.md` 已在 commit `d100f92` 被删，恢复：`git show d100f92^:docs/MCP-AI-FINDINGS.md`。仅作教训引用（见 §6），不移植。

---

## 4. 缝位地图（file:line，改哪里）

以下 `CC` = `E:\workA\A-skill\Token-Mind\context-compress-main`，`STT` = `E:\workA\A-skill\Token-Mind\Save-The-Token-main`。

### 4.1 预算门（P2）
- 计价入口：`CC/src/util/byte-budget.ts` — `assembleBudgetedResponse:148` / `BlockBudget:51` / `truncateToBytes:30`。**现状只有字节没有 token**，新增 token 计价层（口径统一 `max(1, floor(chars/4))`，与 bench/STT/token-estimate.mjs 三处一致）。
- 单漏斗：`CC/src/util/exec-status.ts` `assembleExecResponse:60`（execute/execute_file/batch_execute 响应必经）。
- 管线侧：`CC/src/executor.ts:632-715 settle()`（smartTruncate 之前插 gate）与 `CC/src/cli/filter.ts:47 compressOutput`。
- 配置：`CC/src/config.ts` Config 接口(:8)/ConfigSchema(:99)/LEVEL_OVERRIDES(:79)/loadEnvConfig(:235) 加键（如 `CONTEXT_COMPRESS_TOKEN_BUDGET`、`CONTEXT_COMPRESS_PRESERVE`）。

### 4.2 结构化适配器（P1）
- 注册缝：`CC/src/filters.ts` `applyCommandFilter:72` 按命令 token 分发（现有 git/npm/pytest/gradle/docker/grep 等 10 个分支，但 pytest 走 `filterTestOutput:517` 的 FAIL_MARKER_RE 启发式、gradle 走粗粒度 `filterBuildOutput:569`）。**新增 per-tool 适配器注册表，仿 filterTestOutput 模式，命令串已随 `compressOutput(stdout, originalCmd, mode)` 传入**。
- shape 兜底：`CC/src/format-filter.ts` `applyFormatFilter:340`（json/ndjson/logs/plain 检测），适配器未命中时走这里。
- 安全网必须保留：`withFloor:59`（永不返回空）、`withOmissionNote:505`（省略计数）。

### 4.3 意图保护（P2）
- 已有基础：`CC/src/util/intent-filter.ts:36 createIntentFilter`——大输出入索引、按 intent 检索、内联 top hits（`intentBudgetBytes` 默认 1800，PER_HIT_CAP 700 / FLOOR 120），**错误行已强制透出**(:61-66)。
- 扩展点：hook 已拿到 `tool_input.command` + `cwd`（`CC/src/hooks/pretooluse.ts:218-229`），把会话意图实体（最近报错串/ID）经 env 或 wrap 参数传给 gate，进保护名单；配置键挂 §4.1。

### 4.4 充分性门 + ABSTAIN（P3）
- TS 移植源：STT `src/save_the_token/evaluation.py` `_variant:121`（term-recall + `sufficiency_status`：recall==1.0 且 missing_fact==0 才 sufficient；`_regressions:147` 标记丢必需项）——纯 stdlib，机械移植；`_tokenize:179` 同步移植。
- 迭代模型参考：STT `active_retrieval.py`（有界重检索，stop reasons 含 iteration_budget_exhausted）。
- ABSTAIN 语义：压缩结果判定不充分 → **回退原始输出**（宁多花 token 不丢事实）；Node↔Python 桥已有先例 `bench/self_bench.py:47-49`，但目标形态是纯 TS 移植，不留 Python 运行时依赖。
- band-ABSTAIN 规则参考：work-mind `sufficiency.mjs`（lexical anchor <0.35 / dense anchor <0.55 / intent+rerank≥0.5 三通道，默认 ON）。

### 4.5 hook 层（P1/P2 顺带）
- `CC/src/hooks/pretooluse.ts`：`WRAP_TARGETS:114-131`（wrap 触发命令表）、`shouldWrap:164-195`（重定向/管道/watcher 排除 + package.json 脚本解析）、`buildWrapCommand:204`、响应契约 `respond():240`（hookSpecificOutput/permissionDecision/updatedInput/additionalContext）。
- 构建链：hook 产物 `npm run build:hooks` → `dist/hooks/`；主 CLI esbuild → `dist/cli/index.js`。改 src 后两链都要构建。

### 4.6 回归设施（P4）
- 现有：`bench/run_bench.py`（case 注册表 `cases():140`，加 case = 加一个 tuple；critical_substrings 即断言）+ `CC/src/bench/quality.ts`（`BenchCase` mustContain/minSurvival，已被 `CC/tests/unit/quality-bench.test.ts` 强制）。
- 移植：Tier B 的 golden/contract/red-line 模式并入 bench/（P4）。

---

## 5. 分期计划（每期：变更面 / 验收 / 红线）

### P0 抢救性 vendor【阻塞项，删 work-mind 之前必须执行】✅ 2026-08-30 完成
- 变更面：复制 §3 Tier A（除检索核心）+ Tier B → `CC/src/forge/` + `bench/forge-golden/`；不改任何现有代码；搬运时文件头注明来源路径与 commit（当前 HEAD `19cbfff`）。
- 实际执行调整：因 work-mind 即将删除，**检索核心（store.mjs/chunker/reranker 等）一并 vendor**（纯逻辑、零依赖，搬运≠接线，P5 才启用）；目录树按原样保留使相对 import 零改写；pino logger 以 stub 替换（`FORGE_LOG=1` 可开）。
- 验收调整并已通过：work-mind 金标语料绑其自身仓库文档路径，无法在 Token-Mind 跑绿；改为 `node bench/forge-golden/smoke.mjs`（store 词法检索 / tokenAwarePack 预算 / tool-result gate 预算+去重 / wrapIfSaves 负收益旁路 / search-gate 阻断语义 / sufficiency 阶梯，六机制断言全绿）。golden 数据与 contract 已随仓库保存，P5 如需启用再适配语料。
- 另：`.gitignore` 已改为跟踪 context-compress-main 源码（含 forge/），node_modules/dist 仍忽略——vendor 资产必须随仓库走。
- 红线：不搬 Tier C 任何文件；不引入任何 npm 新依赖；**work-mind 目录删除后源码不可恢复（含未被上游 git 托管的部分），P0 未完成前禁止删除**。

### P1 结构化适配器
- 变更面：`filters.ts` 适配器注册表 + pytest/gradle/npm(go test 可选) 三到四个适配器，输出确定性 JSON 摘要 `{passed, failed, failed_tests:[{name, first_error_line, file:line}], build_result, total_time}`；bench 加对应用例。
- 验收：新 bench 用例 + `quality.ts` mustContain 全绿；pytest_fail_log 用例从"CC 省 0%"变为双高（计数保留 + 大幅节省）；RTK 丢的证据类子串（`1 failed, 127 passed`、`OrderServiceImpl.java:142`）零丢失。
- 红线：适配器**必须确定性**（禁 LLM 调用）；未命中工具一律走原管线；`withFloor/withOmissionNote` 不得绕过。

### P2 预算门 + 意图保护
- 变更面：token 计价进 `byte-budget.ts` + `config.ts` 新键（`*_TOKEN_BUDGET`、`*_PRESERVE`）；`assembleExecResponse`/`settle()` 接 gate；**从第一天内置 Quality Guard**：预算内丢块 → 1.5x 预算重试（cap 8000 tok）并标记 `quality_guard="budget_retry"`；intent 实体保护名单接通。
- 验收：bench big_log 用例 req-ID 在设置 preserve 后零丢失；预算触发时输出带省略语义与 get_evidence 式指针；节省率回退幅度 ≤ work-mind 实证值（~2.8pp）。
- 红线：Quality Guard 不可关闭为默认 OFF（work-mind 血泪：贪心背包丢金标 chunk，准确率掉 9pp，加 Guard 换回 3pp）；负收益旁路（wrapIfSaves）必须保留——压完更大就直通。

### P3 充分性门 + ABSTAIN
- 变更面：`evaluation.py::_variant` TS 移植 → `CC/src/forge/sufficiency.ts`；压缩结果判定不充分回退原文；空/无匹配结果带状态语义（NO_MATCH / NO_INDEX / INDEX_BUILDING / INDEX_VERSION_MISMATCH）。
- 验收：构造"压缩丢必需项"用例集，判定全部拦截并回退；术语 recall 计算与 STT Python 版对拍一致（同输入同输出）。
- 红线：ABSTAIN 只允许"回退原文"，不允许静默放行低置信结果。

### P4 准确性回归门
- 变更面：移植 evaluation-contract-v2 结构到 `bench/`（golden 用例 + baseline 文件 + contract JSON + holdout split）；`run_bench.py` 加 `--ci` 模式；CC 侧 `quality.ts` 用例对齐。
- 验收：`python bench/run_bench.py --ci` 退出码反映红线；人为劣化一个适配器能被 CI 拦下（反向验证）。
- 红线（沿用 work-mind 实证值）：**金标 Recall/关键子串保留掉 >2pp 或节省率掉 >5pp = FAIL**；holdout 用例答案不得写进被测代码可达的元数据（防评测泄漏，contract 的 forbidden_capabilities 条款照搬）。

### P5（可选）文档检索层【门槛触发制】
- 启动条件（全部满足才开工）：(1) 真实文档任务上 Grep+CC 组合实测不够用（记录对比数据）；(2) 纯本地 lexical 起步，不引入 embedding 服务；(3) 单项目索引，不做多租户。
- 变更面：搬 store.mjs + chunker + reranker → `CC/src/forge/`；`tokenAwarePack` 直接复用（Quality Guard 已含）。
- 红线：语义检索宣称**必须写明对比基线**（vs 全库扫描 ≠ vs 单文件 Read——work-mind 实测对已知路径场景 MCP 检索比直接 Read 贵 3-25 倍）；bge-m3/Ollama 单点瓶颈（~2 QPS@并发5）的教训 = 默认不做 semantic。

---

## 6. 质量红线（work-mind 教训汇总，所有期通用）

1. **节省宣称必带基线**：README 式"省 60-85%"只在 Gate+minimal vs 全库扫描成立；vs 单文件 Read 是负收益。本项目所有报告沿用 bench 的明确基线写法。
2. **Quality Guard 默认 ON**：任何预算裁剪必须有"丢块→1.5x 重试"兜底；准确率优先于节省率的极端情况直接 ABSTAIN 回退原文。
3. **空结果必须带状态语义**：禁止裸空串/空数组——"查了没有"和"没查"对模型是完全不同的信号。
4. **disk = truth**：任何缓存（auto-cache、forge search-cache、增量索引指纹）以磁盘为准，缓存键命中不等于内容新鲜；写路径后必须 publish 新版本。
5. **确定性优先**：适配器/判定器禁 LLM 调用（`auto-mode.ts` 的 LLM 通道只允许用于模式选择，不用于事实裁剪）。
6. **中英混合语料分词坑**（KI-001）：term-recall 的 `_tokenize` 对中文要按字/二元切，纯空格分词会让中文用例 recall 虚低——移植 `evaluation.py::_tokenize` 时保留其分词逻辑并对拍。
7. **CI 双指标红线**：质量（recall/关键子串）与效率（节省率）任一回退超阈值即 FAIL，不允许"用质量换节省"的单边报告。

---

## 7. Handoff（按 ai-design 规定字段）

| 字段 | 内容 |
|---|---|
| 变更面 | 本期仅新增 `docs/DEEP-DEV-PLAN.md`；代码零改动 |
| plan | 本文件 §5 分期计划；每期开工前以该期为唯一 scope（一次一事） |
| 验收行 | P0 vendor 跑绿 / P1 双高用例+零丢证据 / P2 req-ID 保留+Guard ON / P3 拦截回退+Python 对拍 / P4 --ci 反向验证 / P5 门槛数据 |
| identity | 不改 CC/STT 对外契约（MCP 工具面、hook 响应格式、CLI 子命令）；新能力只增不改 |
| 接缝 | §4 全部 file:line |
| 验证档 | `bench/report.md` + `run_bench.py --ci` + `CC/tests/unit/*` + `npm test`（mcp-client 模式）|
| 待确认 | 已收敛为零 TBD；两条已定决策见 §8，可由后续会话携带数据推翻 |
| 规则演进 | 每期完成后把新红线补进 §6；bench 基线数字随版本更新 |
| 下一步 | 立即执行 P0（阻塞项）→ P1 → P2 → P3 → P4 →（视门槛）P5 |

---

## 8. 已定决策记录（2026-08-30）

| 决策 | 选择 | 理由 | 可推翻条件 |
|---|---|---|---|
| 移植代码放哪 | `context-compress-main/src/forge/` | 与 CC 同 esbuild 构建链、同进程调用、零跨包开销；CC 本就是自持 fork | 若出现多消费方（如 STT 侧也需要），升格为独立 packages/forge/ |
| 文档检索层去留 | 可选 P5，门槛触发制 | 读文档场景可能被 Grep+CC 覆盖；防 work-mind 式定位漂移与重服务复发 | P5 门槛数据证明 Grep+CC 不够用 |
| Bash 拦截层 | CC hook 已替代 rtk hook | RTK 丢调试证据；双 hook 会双重改写 | 无（bench 数字不支持回头） |
| aggressive 模式 | 禁用 | 实测与 balanced 同节省率 | 无 |

---

*本文档由 2026-08-30 会话产出；资产盘点与缝位行号来自当日两轮代码探索，bench 数字来自 `bench/report.md` 同日实测。*
