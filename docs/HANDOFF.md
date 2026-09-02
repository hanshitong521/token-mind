# Token-Mind / ContextMind 交接文档（Handoff）

> 生成日期：2026-09-01
> 基准版本：`c58f9ea`（HEAD，最新 5 个提交见下）
> 文档用途：供后续会话 / 接手者快速判断「已开发完」与「未开发完」的内容，直接开工。
> 口径：**切片上线 / 产品未完成**。所有结论以本仓 `docs/` 规划文档 + 实际代码为据。

> ⚠️ 关于 commit `fa7ba9a9b64642158b7bb21871c739f6`：
> 该哈希在 Token-Mind 本地仓库、关联仓库（work-mind / agent-forge）以及 gitee 远程（`origin` 已 `fetch` 验证）**均不存在**，无法定位。本交接以当前 HEAD `c58f9ea` 为准——它已是本仓最新且最完整的状态，与 `docs/DEEP-DEV-PLAN.md`、`docs/decisions/DECISIONS-2026-09-01.md`、`docs/reports/SLICE_REPORT_S2_S3.md` 一致。若你手上的 `fa7ba9a…` 来自另一份克隆/远程分支，请提供来源，我可重新对齐。

---

## 0. 项目一句话

Token-Mind 是 **ContextMind** 的开发仓：面向 Cursor / Coding Agent 的「上下文治理 + token 优化」基础设施。核心理念是把「压文本」升级成「**提事实 + 带预算 + 有充分性兜底 + 有回归门**」，且**零新增运行时依赖、零服务、零部署**（Node 22.5+ 内置 `node:sqlite` 做三列账）。

---

## 1. 当前提交时间线（HEAD 起近 5 笔）

| 提交 | 主题 | 性质 |
|---|---|---|
| `c58f9ea` | add shejiuPro live A/B bench for RTK vs context-compress | 最新（HEAD） |
| `fdfdab2` | review fixes: repair vendored gold-bench imports… | 修正 |
| `26b38a0` | P0 vendor forge assets from work-mind + P1 structured tool adapters | **P0 完成** |
| `a413254` | wire CC balanced hook + persist DB, install Save-The-Token skill | hook 接线 |
| `c7f184f` | add measured token-saving bench for RTK / context-compress / Save-The-Token | 基线 |

---

## 2. 已开发完成（Developed / Shipped）

### 2.1 S2 + S3 切片：ContextMind 治理层 ✅
路径：`contextmind/` + `cursor/`。三条 token 大头路径（Shell / MCP / Read）由 Cursor hooks 强制治理：

- **Shell 单 owner**：锁定 `cc_balanced`（A/B 实测后锁定，见 `docs/evidence/SHELL_FIRST_LAYER_AB.md`）；RTK 无代码路径、失败路径禁止路由到 `rtk log/err`。
- **Output Gate**：分类 → 去重 → handle 化 → 首层压缩 → 结构化裁剪 → 保真校验 → 不足即 ABSTAIN 回原文。
- **Read Guard**：`*ServiceImpl.java` >80 行无 range 拒读；`*Mapper.xml` 禁整读；生成物/锁文件拒读；`override_reason` 可豁免且留痕。
- **MCP Output Guard**：超预算载荷替换为有界结果 + handle（matcher 必须是 `MCP:<tool>`）。

核心库 `contextmind/lib/`（15 个模块，全部零运行时依赖）：
`config / tokens / classify / output-gate / handles / dedup / read-guard / shell-guard / mcp-guard / probe / traps / telemetry / runtime / engine / install-plan`

Hooks `cursor/hooks/cm-*.mjs`：preToolUse / postToolUse / sessionStart / sessionEnd / stop + `cm-lib.mjs` 定位层。

实测（完整数据 `docs/evidence/SLICE_S2_S3_BENCH.md`）：Output Gate 对 bench fixtures **108,899 → 2,646 tok（97.6%）**；`pytest_fail` 2632 → 126 tok（95.2%）且 handle 取回原文逐字节一致。

### 2.2 CLI 工具集 ✅
`contextmind/cli.mjs`：`install / uninstall / doctor / status / report / gc / fetch / config / benchmark`，全部幂等；`uninstall` 只删自己加的，保留 `hooks.json` 其余条目。

### 2.3 测试 ✅
`contextmind/tests/` 共 **77 用例**（L1 / L4 契约 / G7 安装）。CC 侧 `context-compress-main` 含既有 46 测试文件（其中 30 个 Windows 可移植性 fail 非本切片引入，见 §4.9）。

### 2.4 工具级 A/B 实测基线与推荐组合 ✅
`bench/` 已对 RTK 0.46、context-compress 2026.8.1、Save-The-Token 0.1 做工具级 A/B，结论（详见 `bench/FINAL_REPORT.md`）：

| 层 | 工具 | 实测节省 | 保真 | 判定 |
|---|---|---:|---|---|
| Tool Output | context-compress (balanced) | 94.6% | 错误证据完整保留 | PASS（默认） |
| Tool Output | RTK | 98.9% | `err/test` 保真；`log` 丢证据 | PASS（仅手动非证据） |
| Instructions/MCP | Save-The-Token | 65% | 零事实丢失 | PASS（推荐启用） |

**推荐组合：CC balanced + Save-The-Token**（两层互补，Agent 无需改行为）。

### 2.5 P0：forge 资产 vendor ✅（2026-08-30 完成）
把 work-mind（ContextForge）的 Tier A≈5700 行纯 Node stdlib 核心资产 + Tier B 离线评估资产复制到 `context-compress-main/src/forge/`（40 个 .mjs），并写 `bench/forge-golden/smoke.mjs` 六机制断言全绿（store 词法检索 / tokenAwarePack 预算 / tool-result gate / wrapIfSaves 旁路 / search-gate 阻断 / sufficiency 阶梯）。
**关键：此步为「搬运≠接线」，forge 资产已随仓库走但 P5 才启用**（见 §4.7）。

### 2.6 shejiuPro 真实环境 A/B bench ✅
最新提交 `c58f9ea` 新增 shejiuPro 线上 live A/B 对比 RTK vs context-compress（复测「CC 在 shejiu live 为何仅 5.2%」根因：测量路径未传 `--cmd`、两巨案属非 Shell 域、RTK 测量假象），数据见 `bench/shell_owner_retest.md` 与 `docs/evidence/SHELL_FIRST_LAYER_AB.md`。

---

## 3. 未开发完 / 未启动（Undeveloped）

### 3.1 产品完成度 G0–G8：未执行 ❌
规划文档明确定调「**S2+S3 切片上线，产品未完成（spec G0–G8 未全部执行）**」。G0–G8 的「产品就绪」验收项整体**不达标**，不宣称产品完成。

### 3.2 S4 六工具 MCP 层：未实现 ❌
决策 `DECISIONS 2026-09-01 #5C`：对 Cursor 只暴露 6 个名字 `context_orient / find / get / impact / run / fetch`，内部 dispatch 到 CC 实现 + CodeGraph 实装探测（shejiu 常只有 explore，缺 API 降级禁止假装调用）；schema 总量实测 ≤2500 tokens；CC 旧 8 工具名不对 Agent 暴露。
**现状**：`context-compress-main/src` 下无 `mcp/` 六工具层实现（仅 `forge/mcp-client/` 占位目录，0 字节，属 vendored 未接线）。CC 自身已有 8 个 MCP 工具（ADR-0001 背景），但「面向 Cursor 的 6 工具对外层 + CodeGraph probe + schema ≤2500 实测」尚未做。S4 前置「schema ≤2500 tok 实测」**未开始**。

### 3.3 S5 canonical facts：未启动 ❌
S2/S3 报告 §4 明确列为边界外。规范中的 canonical facts 层尚未设计/实现。

### 3.4 S6 CodeGraph adapter：未启动 ❌
同上，列为本切片不做。CodeGraph 检索（`mcp__codegraph__*`）已由规范覆盖，但本仓未做 adapter 接入。

### 3.5 S8 Dashboard UI：SKIP（仅三列账 SQLite + report CLI）⚠️
决策 `DECISIONS #2C / #7A`：S8 只做三列账 SQLite + report CLI，**不做 Dashboard UI**。
三列账已实现（`prevented_read_tokens` / `tool_emitted_savings` / `proxy_llm_savings`，会员窗第三列为 0 是预期），但**可视化 Dashboard 明确不做**。

### 3.6 DEEP-DEV-PLAN 的 P1–P5 阶段：规划中、未实现 ❌
`docs/DEEP-DEV-PLAN.md` 给出五期计划，除 P0 已完成外，**P1–P4 均未动代码**，P5 门槛触发制（默认不启动）：

| 期 | 内容 | 状态 |
|---|---|---|
| P1 结构化适配器 | per-tool 适配器注册表（pytest/gradle/npm/go test）→ 确定性 JSON 摘要 | ❌ 未实现 |
| P2 预算门 + 意图保护 | token 计价进 `byte-budget.ts`+`config.ts` 新键；Quality Guard 1.5x 重试；intent 保护名单 | ❌ 未实现 |
| P3 充分性门 + ABSTAIN | STT `evaluation.py::_variant` TS 移植 → `sufficiency.ts`；不足回退原文 | ❌ 未实现 |
| P4 准确性回归门 | evaluation-contract-v2 + golden + `--ci` 红线；Recall/节省率回退 >2pp/>5pp=FAIL | ❌ 未实现 |
| P5 文档检索层 | 搬 store/chunker/reranker，**门槛触发制**，默认不做 | ⏸ 可选 |

### 3.7 forge 资产：已 vendor 但**未接线** ⚠️
`context-compress-main/src/forge/` 已落地 40 个 .mjs，但**没有任何生产代码 import 它**（`*.ts` 中出现的 `forge` 字符串均为巧合匹配，非接线点）。启用需 P5 触发或在 P1–P4 中引用。

### 3.8 明确 SKIP / OUT 项 ❌
来自 `DECISIONS 2026-09-01` 与 ADR-0003：
- **Serena**（spec §19.5 门槛未触发）→ SKIP
- **Rust cmhook**（§7.2 无延迟证据）→ SKIP；且 CLI **不提供 `start`/`stop`**（占位即说谎，ADR-0003）
- **Dashboard UI** → SKIP
- **shejiu Java 业务重构** → OUT
- **8787 劫持订阅模型 / 每轮全量 GetDynamicTools catalog 扫描** → OUT
- **工作-mind Docker/Redis/Ollama/BullMQ/HTTP API** → 移植时已主动抛弃（Tier C）

---

## 4. 已知局限 / 风险（必读）

1. **G4 延迟不达标**：hook p50 **269ms**（Node 启动占 172ms/64%），目标 25ms → `KNOWN_LIMITATION`（ADR-0003）。重议条件：实机会话出现可感知卡顿。
2. **`updated_mcp_tool_output` 形态待实机确认**：实现按「输入什么形态回什么形态」，需在 Cursor 实机验证一次。
3. **上游 CC 测试 30 fail（Windows 可移植性）**：非本切片引入，未修；不计入切片验收但已列明。
4. **tokenizer 为 `heuristic:chars/4`**：与 bench 可比，但非真 tokenizer；若后续换，必须连基线一起重跑，不许混报。
5. **RTK 失败路径危险**：`rtk err` 对异常堆栈伪造成功并丢弃证据（实测复现）；已全仓禁用，仅留 rtk.exe 手动非证据场景。
6. **work-mind 已删除风险**：P0 vendor 是「删除 work-mind 前抢救资产」的阻塞项；若 work-mind 目录已删，forge 源码不可恢复（含未被上游 git 托管部分）。

---

## 5. 关键决策 / ADR 摘要

| 编号 | 决策 | 落地 |
|---|---|---|
| ADR-0001 | Node/TS CC 为核心引擎，禁止 Python 引擎重写 | `context-compress-main/` |
| ADR-0002 | 配置用 JSON 而非 YAML（零新依赖） | `contextmind/` 配置 |
| ADR-0003 | 不做 daemon / Rust cmhook；不提供 start/stop | hook 无状态子进程 |
| DEC 2C | 顺序硬约束 S2→S3→S4→S8(data+CLI)；无 UI | 各切片 |
| DEC 3C | 半天复测即锁 `shell.first_layer=cc_balanced`；禁 rtk log；禁双层连环压 | `SHELL_FIRST_LAYER_AB.md` |
| DEC 4A | shejiu 三个 gate hook 迁入 `cursor/hooks/`，trap vendor 进本仓 | `cursor/hooks/` |
| DEC 5C | 对 Cursor 暴露 6 工具名，内部 dispatch；schema ≤2500；不加第 7 工具 | S4 待实现 |

完整 ADR：`docs/decisions/ADR-0001~0003.md`；决策收敛：`docs/decisions/DECISIONS-2026-09-01.md`。

---

## 6. 环境与运行入口

```bash
# 治理层安装到目标 Cursor 项目
node contextmind/cli.mjs install <projectDir>   # 幂等；先备份 hooks.json
node contextmind/cli.mjs doctor  <projectDir>   # PASS/WARN/FAIL 体检
node contextmind/cli.mjs report                  # 三列账
node contextmind/cli.mjs fetch <handle> --lines 1-80

# 测试
node --test "contextmind/tests/*.test.mjs"       # 77 用例
node contextmind/cli.mjs benchmark                # Output Gate 实测
node bench/hook_latency.mjs 15                    # hook 延迟归因

# 工具级 A/B
python bench/run_bench.py      # 工具输出压缩 A/B → bench/report.md
python bench/self_bench.py     # Agent 会话输出回放实测

# P0 forge 冒烟
node bench/forge-golden/smoke.mjs
```

零新增运行时依赖；telemetry 用 Node 22.5+ 内置 `node:sqlite`。Swift 构建链：`context-compress-main` 用 esbuild（主 CLI → `dist/cli/index.js`；hooks → `dist/hooks/`），改 `src` 后两链都要构建。

---

## 7. 给接手者的下一步建议

**最近可做（按决策硬约束顺序）**：
1. **S4 六工具 MCP 层**（DEC 5C）：在 `context-compress-main/src` 新增对外 6 工具层，内部 dispatch 到现有 CC 8 工具 + CodeGraph 探测；实测 schema ≤2500 tok。这是决策已拍板但唯一尚未落地的「切片延续」项。
2. **DEEP-DEV-PLAN P1**：结构化适配器注册表（最高 ROI，直接把 pytest_fail 从「CC 省 0%」变成双高），且 P0 forge 已就位可复用。
3. **P2 预算门 + Quality Guard**：务必默认 ON（work-mind 血泪：贪心背包丢金标 chunk 掉 9pp）。
4. **P3 充分性门 + ABSTAIN**：纯 TS 移植 STT `evaluation.py`，与 Python 版对拍。
5. **P4 回归门**：`run_bench.py --ci` 红线，防止后续迭代用质量换节省。

**不要做**（避免重演 work-mind 失败）：Redis / Ollama / BullMQ / Docker / HTTP API / 代码索引 / 通用 RAG 漂移 / Serena / Rust cmhook / Dashboard UI / 宣称 G0–G8 产品完成。

**开工前必读**：`docs/DEEP-DEV-PLAN.md` + `bench/report.md` + 本文件 §4 局限 + `SHELL_FIRST_LAYER_AB.md`（shell owner 已锁，改动须新 evidence + owner 批准）。
