# ContextMind — AI 一体化开发与极致上下文优化总规范

> **文档类型**：AI 可直接执行的项目总开发规范 / 架构基线 / 测试闭环 / 验收门禁
>
> **文档版本**：1.1
>
> **冻结日期**：2026-09-01
>
> **修订**：1.1 按 Cursor 实机（Grok / Composer / Auto 不经 8787、动态 MCP schema、Hook 强制面、shejiuPro 会话浪费点）收口。架构不变；交付改为**可工作切片**，产品完成仍以 G0–G8 为准。
>
> **目标项目**：`ContextMind`
>
> **首个真实接入目标**：Cursor + Java 项目（当前典型项目为 `E:\workA\shejiuPro`）
>
> **主要用户路径**：Cursor Grok / Auto / Composer 等订阅模型；**不要求切换 BYOK 模型**。
>
> **核心原则**：**Eliminate > Retrieve Precisely > Isolate > Deduplicate > Compress > Compact**。
>
> **执行要求**：本文件不是“建议书”。交给 AI 后必须先理解项目和上游源码，再按 §0.3 切片实现、安装、实测。**切片可上线使用；整产品未过 Gate 不得宣称完成。**

---

# 0. 给接管 AI 的最高优先级执行指令

以下规则优先级高于本项目中的普通 TODO、README 建议和“先快速做个 demo”类冲动。

## 0.1 禁止未理解项目就开发

AI 在修改任何业务源码前，必须完成“项目认知门禁”。至少必须读取并记录：

1. `ContextMind` 当前目录树、入口、配置、测试、CI、安装脚本、文档。
2. 当前接入项目（如 `shejiuPro`）的：
   - `.cursor/mcp.json`
   - `.cursor/hooks.json`（若存在）
   - `.cursor/rules/**`
   - `.cursor/skills/**`
   - `.cursor/agents/**`
   - `AGENTS.md`
   - 现有 Headroom / CodeGraph / Context Compress / RTK 相关配置与脚本。
3. 本规范 §4 所有上游项目的：
   - README
   - LICENSE
   - 安装方式
   - MCP/CLI/Hook 接口
   - 核心源码入口
   - 配置模型
   - 测试目录
   - 与 ContextMind 计划复用部分直接相关的实现文件。
4. Cursor 官方当前版本的 Hooks / MCP / Rules / Skills / Subagents / Plugins 文档。
5. 实机环境：OS、Cursor 版本、Python、Node、Rust、Java/JDK、Maven/Gradle、`uv`、Git、可执行文件 PATH。

**禁止行为：**

- 只看 README 就开始“凭印象整合”。
- 根据旧对话假设上游接口仍未变化。
- 根据项目名字猜命令、参数、JSON schema、Hook 字段。
- 因为“理论上可行”就标记 PASS。
- 未运行真实命令就写“已验证”。
- 用 mock 冒充真实集成测试。
- 看到一个测试通过就跳过其余 Gate。
- 把本规范全文、整份 SKILL、整份 L0 粘进对话当“上下文”（规范应被索引/按节检索，禁止再灌 2800 行）。
- 每轮对 Cursor 动态工具目录做全量 `GetDynamicTools` / 等价全 catalog 扫描。只允许对**已知工具名**拉单工具 schema。

## 0.2 必须生成项目认知证据

首次接管时创建或刷新：

```text
docs/evidence/
├── ENVIRONMENT_SNAPSHOT.md
├── UPSTREAM_INVENTORY.md
├── UPSTREAM_LICENSE_MATRIX.md
├── UPSTREAM_API_MATRIX.md
├── CURRENT_CURSOR_STACK.md
├── CURRENT_CONTEXT_COST_BASELINE.md
└── ASSUMPTIONS_AND_UNKNOWNS.md
```

每份文件必须带：

- 采集时间；
- Git commit SHA / tag（上游若为 Git 仓库）；
- 实际命令；
- 真实输出摘要；
- 结论；
- 未确认项。

**任何关键事实没有证据，只能标记 `UNKNOWN`，不能脑补。**

## 0.3 产品完成 vs 切片上线

**架构冻结为单一产品**（6 工具、Hook 治理、Handle、预算、去重）。**实现必须按可工作切片交付**，禁止为了“一口气”同时拉起 8 个上游 MCP、Serena JDTLS、Dashboard、Rust hook——那会先把 schema/进程变重，短期 token 更差。

### 产品完成（宣布 ContextMind 完成）

必须连续走完并过 G0–G8：

```text
读懂项目 → 建基线 → 冻结架构
→ 按切片实现并每片实测
→ 全量回归 → 瘦身审计 → 再回归
→ 最终 Gate → 证据归档
```

### 切片上线（允许接入 shejiuPro 日常使用）

每片必须**单独可安装、可回滚、有 Gate**。默认顺序（后片可因 benchmark 跳过）：

```text
S0  事实冻结 + Cursor 实机复测（含 MCP 是否真在目录里）
S1  Read Guard + Dedup stub + Always Rule ≤400
S2  Shell 单层压缩（RTK 或 Context Compress 二选一实测）+ Output Gate + Handle
S3  MCP Output Guard（含 mysql 等内部 adapter）+ sessionStart 探活
S4  统一 6 工具；卸掉对 Agent 裸露的上游 MCP
S5  Canonical facts 进 context_get（口径/pin/热表；与图检索串行）
S6  CodeGraph adapter（按实装能力，缺的 API 不得假装有）
S7  Serena（仅当 S6 消歧不够；门槛触发，禁止 Day-1 双语义引擎）
S8  Telemetry 三列账 + 最小报告（Dashboard UI 最后）
```

S1–S3 是 **token 最大头**；未完成 S1 不得优先做 Serena/Dashboard。

若中途受外部硬阻断（上游不可用、缺凭据、Cursor 版本不支持已确认接口），必须：

1. 证明阻断；
2. 完成所有不依赖该阻断的切片；
3. 写入 `BLOCKERS.md`；
4. 不得把“被阻断”包装成“产品完成”。已上线切片仍可继续用。

## 0.4 AI 自修复循环

任何任务执行后必须进入：

```text
IMPLEMENT
  ↓
RUN REAL TEST
  ↓
MEASURE
  ↓
COMPARE WITH GATE
  ├─ PASS → 下一任务
  └─ FAIL → 定位根因 → 修改 → 重测
                         ↑        │
                         └────────┘
```

**无固定重试次数。**

只要还有明确可修复原因，AI 就继续修；不得因为“已经改了三次”停止。

---

# 1. 项目最终定位

`ContextMind` 不是 Headroom 的 fork，也不是单纯“Token 压缩器”。

它是：

> **面向 Cursor / Coding Agent 的上下文治理与 Token 极致优化基础设施。通过精准检索、上下文隔离、Hook 强制治理、工具输出预算、结果去重、可逆压缩、按需取回和真实指标闭环，在不降低开发正确率的前提下，最大限度减少无效 Context。**

## 1.1 ContextMind 要解决的问题

1. Agent 首轮整读大型 Service / Mapper / 日志。
2. grep / git / mvn / test 输出几千到几万 token 直接进入上下文。
3. MCP 返回巨型 JSON / rows / search result。
4. 同一事实、同一代码、同一工具结果被重复读入。
5. 多个 MCP 的工具 schema 本身常驻上下文。
6. Rules/AGENTS 中大量不必要常驻说明。
7. “建议 Agent 使用压缩工具”属于软约束，模型可能不执行。
8. 重型探索污染主 Agent context。
9. 没有统一 Token 预算和来源级统计。
10. Dashboard 只看到某个代理的流量，无法回答“Cursor Agent 到底在哪浪费上下文”。
11. 压缩结果如果不可取回，会损失关键事实并降低编码准确率。
13. 业务口径 / 已决事项被忘掉，同一根因被反复探索。
14. Cursor 动态工具目录、手动 @ 的巨型 SKILL、Always Rule 过肥，本身就是常驻税。
15. 规则写了 Forge/Headroom，但 MCP 进程未挂进当前会话（目录里没有该工具）。
16. CodeGraph explore 打偏后，仍 Grep/整读 `*ServiceImpl`，explore 已返源却当没读过。

## 1.2 明确不做的事情

### 不做 1：劫持 Cursor 订阅模型 HTTP

现有实机结论是 Cursor 会员主模型聊天并不经过本机 Headroom `127.0.0.1:8787`。因此 ContextMind **不以 MITM、证书注入、私有协议劫持、强制改 upstream** 为工程路线。

### 不做 2：为了“压缩率”破坏代码语义

活跃编辑目标、异常堆栈关键帧、测试失败断言、SQL 关键字段、Patch diff 关键行不得因为追求数字而被静默删除。

### 不做 3：把 8 个上游 MCP 全裸暴露给模型

最终对 Cursor 应暴露**极少数统一工具**，上游是 ContextMind 内部 adapter。

### 不做 4：复制受限许可证项目源码

许可证不允许直接整合的项目只能作为设计参考，除非项目所有者明确获得并满足对应许可。

### 不做 6：为省 token 重构业务 Java 架构

shejiuPro 的 `*ServiceImpl` 压缩率接近 0。ContextMind 治理 **Agent 读什么**，不拆微服务、不改表结构。仅当单文件大到 Read Guard 无法安全编辑时，才允许**业务仓**做文件级拆分，且须单独 ADR。

### 不做 7：Day-1 同时启用 Serena + 全功能 CodeGraph + 全部裸 MCP

第二套语义引擎（Serena/JDTLS）按 §19.5 门槛触发。CodeGraph adapter 只调用**实机存在的**工具。

---

# 2. 已知现实约束（开发前必须再次实测确认）

基于现有 Cursor × Headroom × shejiuPro 会话复盘，当前历史事实包括：

1. Headroom proxy `8787` 对 Cursor 订阅的 Grok / Auto / Composer 主聊天不构成通用透明代理。Override Base URL 只对 BYOK。
2. Headroom MCP 可用于工具结果压缩，但若依赖 Agent 主动调用，覆盖率不稳定；且 **MCP 可能根本不在当前会话工具目录中**（探活失败 = 规则失效）。
3. 本仓 CodeGraph 常见实装是 **少量工具（例如仅 `explore`）**，不得假设官方仓库的 `orient` / `packet_get` / `impact` 都已挂上。
4. Context Compress 已用于大 Shell 输出，与 Headroom/RTK **禁止三层 double wrap**。Shell 第一层只允许一个 owner（A/B 实测后锁定）。
5. 现有 Cursor Rules 属于软约束；Always Rule（含 L0）过长本身就是 token 税。
6. Cursor Agent 调 MCP 前可能被要求先发现 schema（`GetDynamicTools` 一类）。全量 catalog 扫描禁止；只允许单工具 schema。
7. 真实目标是：**不切主模型，也能明显降低进入 Agent Context 的无效内容。** Dashboard 不得用 8787 会话数代表 Grok 窗。

AI 必须把这些视为**待复测的历史基线**，而不是永远不变的真理。复测写入 `CURRENT_CURSOR_STACK.md`。

---

# 3. 核心工程原则

## P1. 消除优先于压缩

若某内容本就不应进入 Context，就不要先读入再压缩。

优先级：

```text
不读取
> 精确读取
> 独立 Context 读取
> 去重
> 结构化裁剪
> 可逆压缩
> 最后才是通用文本压缩
```

## P2. 精确证据优先于摘要

开发代码时，精确 symbol/source/callsite 优于“LLM 生成的代码摘要”。

## P3. 可逆

所有有损压缩必须：

- 生成 `handle_id`；
- 保存原始数据或可重新执行的 provenance；
- 支持 `context_fetch(handle_id, selector)` 精确取回；
- 记录压缩前后 token 数；
- 记录算法和保留项。

## P4. 预算是硬约束

每个工具调用都有预算，而不是“尽量少一点”。

## P5. 失败默认保真

压缩器异常时：

- 不得输出伪摘要；
- 必须选择明确的 fallback；
- 对错误/测试失败类数据优先保留完整关键证据。

## P6. 少工具

Cursor 对外核心 MCP 工具目标：**6 个**。

## P7. 本地优先

源代码、数据库返回、日志、索引、Telemetry 默认本机处理和存储。

## P8. 上游可替换

Serena / CodeGraph / RTK / Headroom 等必须经 adapter 接入，不允许业务核心直接依赖其私有内部结构。

## P9. 不做重复能力

同一职责只能有一个默认 owner。例如：

- Shell 第一层：RTK **或** Context Compress，**二选一**（A/B 锁定后写入 config）；禁止 RTK → CC → Headroom 连环压。
- 大型非结构化残余输出：ContextMind Output Gate（仅当第一层仍超预算）。
- Repo 图 / 第一跳：CodeGraph owner（按实装 API）。
- Symbol 精确体（门槛后）：Serena owner。
- 业务口径 / pin / 热表：Canonical facts owner（Forge/memory 类，经 `context_get`，禁止与图检索并行双搜）。
- 原文 Handle：ContextMind owner。
- SQL 只读查询：内部 adapter（对 Agent 不裸露 `mysql_query` schema，除非切片 S4 未完成的临时兼容）。

## P10. 先测基线，再优化

没有 baseline 的“节省 80%”一律无效。

## P11. Schema 税计入预算

Always Rule、MCP 工具描述、动态工具目录、用户手动 @ 的 SKILL，全部计入「可控 Context」。优化输出却放过 2k+ 常驻 schema，不算极致。

## P12. 失败路径禁止误用通用 log 压缩

测试失败、编译失败、Java 堆栈：优先 err/test 通道或 raw + Preservation Contract。禁止 `rtk log`（或等价“去重日志”）作为失败输出的默认路由。

---

# 4. 上游项目研究与整合矩阵

> **重要**：以下是 2026-09-01 调研基线。执行 AI 必须在真正开发时重新 `git rev-parse HEAD`、读取 LICENSE 和接口文档，写入证据文件。

## 4.1 Serena — 核心语义引擎

仓库：`https://github.com/oraios/serena`

已确认能力：

- MCP；
- LSP / Language Server；
- symbol overview；
- find symbol；
- find referencing symbols；
- 部分语言 find implementations；
- diagnostics；
- symbol body 替换/插入；
- Memory；
- Java 支持；
- MIT License。

ContextMind 用途：

- Java 精确 symbol retrieval；
- 引用/实现定位；
- 精确编辑上下文；
- 避免整文件读取。

**整合方式：adapter / process / MCP bridge，优先使用公开接口。**

禁止：复制 Serena 私有实现后在 ContextMind 中产生第二套相同 LSP 抽象。

## 4.2 CodeGraph — 核心仓库图引擎

仓库：`https://github.com/lzehrung/codegraph`

已确认能力：

- local CLI + TypeScript library；
- files/symbols/references/dependencies graph；
- MCP；
- `explore`；
- `orient`；
- `packet_get`；
- `search`；
- `workspace_symbols`；
- callers/callees；
- impact/review；
- freshness；
- bounded evidence；
- MIT License。

ContextMind 用途：

- 第一跳 repo map；
- 调用/依赖/影响范围；
- candidate tests；
- bounded context packet；
- 编辑后的 freshness 检查。

职责边界：

- CodeGraph 回答“涉及哪里 / 什么会受影响”。
- Serena 回答“这个 symbol 精确在哪 / 谁引用 / 精确内容是什么”（未启用 Serena 时，由 bounded `context_find` + CodeGraph explore 降级）。

**实装降级（强制）：** Adapter 启动时探测当前 MCP/CLI 实际工具列表。shejiuPro 常见只有 `codegraph_explore`。缺失的 `orient` / `packet_get` 等 **不得调用、不得在错误里假装已执行**；`context_orient` 映射到现有 `explore`（query 必须 FQCN/`*.java`，禁止短名 `handle`，`maxFiles` 单类=1、跨层≤2）。explore 返回的源码片段视为已 Read，适用 §14 Dedup stub。

## 4.3 RTK — Shell 输出第一压缩层

仓库：`https://github.com/rtk-ai/rtk`

已确认：

- Rust 单二进制；
- 面向常见开发命令压缩输出；
- 当前支持 Cursor `preToolUse` hook；
- 安装命令包含 `rtk init -g --agent cursor`；
- Apache-2.0 License。

ContextMind 用途：

- `git` / `grep` / `rg` / package manager / test / build 等可识别命令的透明改写；
- 避免模型依赖“记得自己加 rtk”。

原则：**优先调用 RTK，不重复重写 RTK 已成熟实现的命令解析器。**

## 4.4 jmunch-mcp — MCP Handle 化核心参考/可复用组件

仓库：`https://github.com/jgravelle/jmunch-mcp`

已确认：

- 透明 MCP proxy；
- 大返回结果 Handle 化；
- `peek / slice / search / aggregate / describe / list_handles`；
- 本地 handle DB；
- Dashboard；
- MIT License。

ContextMind 用途：

- 直接研究并按许可证允许范围复用其 Handle 化思想/组件；
- 特别关注大 JSON、大搜索结果、大 MCP response；
- 学习“先给小摘要+handle，再按需钻取”的协议。

ContextMind 最终仍需统一自己的 `context_fetch`，不要把 jmunch 全部 verbs 原样暴露给 Cursor。

## 4.5 Headroom — 压缩算法库，不再是项目中心

仓库：`https://github.com/headroomlabs-ai/headroom`

已确认：

- Python/TS/library/proxy/MCP；
- Content-aware compressor；
- JSON / log / diff / search / text 等专用压缩器；
- MCP 可独立使用，无需 proxy；
- reversible store / retrieval；
- Apache-2.0 License。

ContextMind 用途：

- 在 Output Gate 中作为可选 compressor backend；
- 复用成熟的日志/JSON/搜索结果压缩算法；
- 研究其安全保护和 content routing；
- 不把 8787 proxy 作为 Cursor 订阅模型主链核心。

## 4.6 Repomix — Baseline / Token 分布 / Repo Snapshot

仓库：`https://github.com/yamadashy/repomix`

已确认：

- repo packing；
- Tree-sitter `--compress`；
- token count tree；
- secret scanning；
- MCP；
- MIT License。

ContextMind 用途：

- Benchmark 基线生成；
- Token 分布诊断；
- repo snapshot；
- 结构压缩对照实验。

它不是日常主检索引擎。

## 4.7 jCodeMunch MCP — 仅设计研究，默认禁止复制源码

仓库：`https://github.com/jgravelle/jcodemunch-mcp`

值得研究：

- symbol-level retrieval；
- Tree-sitter AST；
- `plan_turn`；
- `assemble_task_context`；
- blast radius；
- token budget；
- tool tiering / compact schema；
- benchmark 设计。

**许可证边界：**当前为 Dual-Use License，个人非商业免费，商业用途需付费许可，并存在重命名/再发布等限制。

默认规则：

- **不将其源码复制进 ContextMind。**
- **不把它作为 ContextMind 的必需运行时依赖。**
- 只研究公开功能设计和 benchmark 思路。
- 若未来要直接集成，必须先重新审查当时 LICENSE，并由项目所有者明确决定。

## 4.8 TokView — Telemetry / Dashboard 设计参考

仓库：`https://github.com/headroomlabs-ai/tokview`

已确认：

- session/request/model/tool-call 级 Token 观察；
- 本地 proxy + dashboard；
- MIT License。

ContextMind 用途：

- 研究指标模型和 UI；
- 不依赖其 proxy 来统计 Cursor 订阅模型；
- ContextMind 应从 Hooks、Router、Adapter 自己采集可观测指标。

## 4.9 现有 Context Compress

当前环境已有用户级 `context-compress` skill/MCP。

处理策略：

1. 开发前读取其实际版本和源码/说明。
2. 与 RTK 做功能矩阵。
3. 禁止同一命令 RTK → Context Compress → Headroom 三次压缩。
4. 如果只在极大非结构化输出上有额外价值，则降级为 fallback adapter。
5. 如果 RTK + ContextMind Output Gate 已完全覆盖，则允许卸载，但必须先做 A/B 实测。

---

# 5. Cursor 官方能力基线

## 5.1 Hooks 是 ContextMind 的强制执行面

当前 Cursor Hooks 支持包括：

- `sessionStart`
- `sessionEnd`
- `preToolUse`
- `postToolUse`
- `postToolUseFailure`
- `subagentStart`
- `subagentStop`
- `beforeShellExecution`
- `afterShellExecution`
- `beforeMCPExecution`
- `afterMCPExecution`
- `beforeReadFile`
- `afterFileEdit`
- `beforeSubmitPrompt`
- `preCompact`
- `stop`
- `afterAgentResponse`
- `afterAgentThought`

关键能力：

- `preToolUse` 可 `allow/deny`；
- `preToolUse` 可返回 `updated_input` 修改工具输入；
- `postToolUse` 对 MCP 可返回 `updated_mcp_tool_output` 替换模型看到的结果；
- `stop` 可通过 follow-up 机制要求 Agent 继续工作。

因此 ContextMind 不再只靠 Rule 提醒。

## 5.2 Subagent 用于上下文隔离，不用于无脑并行

Cursor Subagent 有独立 context window。

ContextMind 只定义少量专职 Agent：

1. `context-explorer`：大范围仓库探索；
2. `verification-runner`：测试、日志、回归、benchmark；
3. `quality-auditor`：最终独立代码质量/重复/死代码/架构审计。

**默认 0 个并行 explore Subagent。** 大范围探索才允许 1 个 `context-explorer`。禁止用通用 Task/explore 子代理代替 CodeGraph（主 Agent 必须自己走 `context_orient`）。

Subagent 解决的是主上下文污染，不是 Token 免费。过多 Subagent 会提高总 Token。

## 5.3 Rules 必须短

Rules 会进入 prompt context。

目标：

- Always rule 总量目标 **≤ 400 tokens**；
- 只存硬约束和路由规则；
- 详细流程移到 Skills；
- Skill 默认 **不** always-on。单份 SKILL.md 正文目标 ≤800 tokens；超长放 `references/`，由 skill 内按需读。
- 用户手动 `@skill` 也计入 schema 税；安装器应对超限 skill 告警。

## 5.4 Skills 按需加载

Skills 是 progressive/on-demand 资源，适合：

- Java 开发；
- MyBatis；
- DB；
- 测试闭环；
- Benchmark；
- ContextMind 自身维护；
- Upstream 升级。

Skill 默认 **不** always-on。单份 SKILL.md 正文目标 ≤800 tokens；超长放 `references/`。

## 5.5 Cursor MCP 发现面（2026-09 实机）

当前 Cursor Agent 可能要求先发现动态工具 schema，再 `CallDynamicTool`。

强制：

- **禁止**每轮全量 namespace catalog。
- 只对 ContextMind 暴露的 6 个工具名做单工具 schema 查询（安装后 schema 应已短到可常驻）。
- 安装器把 Serena/RTK/Headroom/mysql/CodeGraph **从用户可见 MCP 列表卸下**，只留 ContextMind 一个 server（切片 S4 完成后）。S1–S3 过渡期允许临时并存，但 doctor 必须报告 schema 税。
- `sessionStart` hook：对依赖的内部 adapter 做 health；缺失则 ≤120 token 警告，写入 telemetry `adapter_missing`。

---

# 6. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         Cursor Agent                         │
│         Composer / Grok / Auto / 其他 Cursor 模型           │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│               ContextMind Cursor Integration                 │
│ Hooks: sessionStart 探活 · pre/post tool · read · shell · mcp · stop │
└───────────────┬──────────────────────┬───────────────────────┘
                │                      │
                ▼                      ▼
      ┌─────────────────┐     ┌────────────────────┐
      │ cmhook (thin)   │     │ Unified MCP       │
      │ fast hook bridge│     │ only 6 core tools │
      └────────┬────────┘     └─────────┬──────────┘
               │ local IPC             │
               └─────────────┬──────────┘
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                     ContextMind Core                         │
│ Router · Budget · Dedup · Output Gate · Handle · Policy     │
│ Freshness · Cache · Provenance · Telemetry                   │
└──────┬──────────────┬──────────────┬──────────────┬──────────┘
       │              │              │              │
       ▼              ▼              ▼              ▼
   Serena         CodeGraph          RTK        Compressors
 semantic          repo graph       shell      Headroom/custom
       │              │              │              │
       └──────────────┴──────────────┴──────────────┘
                             │
                             ▼
                    SQLite / Handle Store
                             │
                             ▼
                    Metrics / Dashboard
```

---

# 7. 推荐实现技术栈

## 7.1 核心服务

优先：**Python 3.13**。

原因：

- Serena / Headroom 生态天然兼容；
- MCP SDK 成熟；
- 快速组合外部 CLI / subprocess；
- Benchmark / token / SQLite 开发效率高。

要求：

- 类型完整；
- `pyproject.toml`；
- `uv` 管理；
- `ruff`；
- `mypy` 或 pyright（二选一并固定）；
- `pytest`；
- 不允许 requirements.txt / poetry / pipenv 多套依赖系统并存。

## 7.2 Hook 薄桥

为了降低 Windows 上每次 Hook 启 Python 的启动开销，推荐：

**Rust 单二进制 `cmhook`**。

职责仅限：

1. 从 stdin 读 Cursor Hook JSON；
2. 快速执行少量静态规则；
3. 向本地 ContextMind daemon 发送请求；
4. 输出严格 JSON；
5. daemon 不可用时按已定义 fallback 处理。

**禁止把 Router、Compression、Adapter 业务逻辑复制到 Rust。**

Rust 只做性能敏感的边缘适配。

若实测 Python 常驻/launcher 已满足 Hook 延迟 Gate，可取消 Rust；是否保留必须由 benchmark 决定，不凭审美。

## 7.3 数据

SQLite：

- WAL；
- handle store；
- dedup fingerprints；
- metrics；
- benchmark runs；
- adapter health；
- session facts。

不要一开始引入 Redis / PostgreSQL / Elasticsearch。

---

# 8. 目标仓库结构

```text
context-mind/
├── README.md
├── AGENTS.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── Cargo.toml                    # 仅在 cmhook 保留时
│
├── src/contextmind/
│   ├── __init__.py
│   ├── cli.py
│   ├── daemon.py
│   ├── config.py
│   ├── models.py
│   │
│   ├── router/
│   │   ├── intent.py
│   │   ├── planner.py
│   │   ├── policy.py
│   │   └── result_merge.py
│   │
│   ├── budget/
│   │   ├── token_counter.py
│   │   ├── allocator.py
│   │   └── thresholds.py
│   │
│   ├── output_gate/
│   │   ├── classifier.py
│   │   ├── pipeline.py
│   │   ├── preservers.py
│   │   └── fallback.py
│   │
│   ├── handles/
│   │   ├── store.py
│   │   ├── selectors.py
│   │   └── provenance.py
│   │
│   ├── dedup/
│   │   ├── fingerprint.py
│   │   └── cache.py
│   │
│   ├── adapters/
│   │   ├── base.py
│   │   ├── serena.py
│   │   ├── codegraph.py
│   │   ├── rtk.py
│   │   ├── headroom.py
│   │   ├── context_compress.py
│   │   └── repomix.py
│   │
│   ├── hooks/
│   │   ├── pre_tool.py
│   │   ├── post_tool.py
│   │   ├── read_policy.py
│   │   ├── shell_policy.py
│   │   ├── mcp_policy.py
│   │   └── stop_gate.py
│   │
│   ├── mcp/
│   │   ├── server.py
│   │   ├── tools.py
│   │   └── schemas.py
│   │
│   ├── telemetry/
│   │   ├── events.py
│   │   ├── metrics.py
│   │   ├── db.py
│   │   └── report.py
│   │
│   └── security/
│       ├── secrets.py
│       ├── paths.py
│       └── redaction.py
│
├── crates/cmhook/                # 若 benchmark 证明需要
│
├── cursor/
│   ├── hooks/
│   ├── rules/
│   ├── skills/
│   └── agents/
│
├── dashboard/
│   ├── server/
│   └── web/
│
├── scripts/
│   ├── install.ps1
│   ├── uninstall.ps1
│   ├── doctor.ps1
│   ├── benchmark.ps1
│   └── smoke.ps1
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── hooks/
│   ├── adapters/
│   ├── golden/
│   ├── regression/
│   └── e2e/
│
├── benchmarks/
│   ├── corpus/
│   ├── tasks/
│   ├── baselines/
│   ├── runners/
│   └── reports/
│
└── docs/
    ├── architecture/
    ├── decisions/
    ├── evidence/
    ├── operations/
    └── reports/
```

**目录不是越多越好。**执行 AI 实际开发时若发现某目录只有一个薄文件且没有独立职责，应合并。

---

# 9. ContextMind 对 Cursor 只暴露 6 个核心 MCP 工具

## 9.1 `context_orient`

用途：

- 第一次理解仓库/模块/需求；
- 调用 CodeGraph `orient/explore`；
- 返回有限的目标文件、symbol、依赖、候选测试、下一步。

约束：

- 默认输出 ≤ 800 tokens；
- 禁止返回完整大文件；
- 包含 freshness/provenance。

## 9.2 `context_find`

用途：

- 精确 symbol / implementation / reference 搜索；
- Serena 为主要后端；
- 必要时 CodeGraph 辅助消歧。

约束：

- 结果优先 symbol 级；
- 不把 50 个匹配全部塞回；
- 默认 top-k 受预算控制。

## 9.3 `context_get`

用途：

- 在一个 token budget 内组装当前任务真正需要的代码证据；
- 类似“我们自己的 `assemble_task_context`”。

输入核心字段：

```json
{
  "task": "string",
  "anchors": ["optional symbol/path"],
  "budget_tokens": 1600,
  "freshness": "required"
}
```

输出必须包含：

- evidence blocks；
- source path；
- symbol；
- line/byte range（能拿到时）；
- freshness；
- omitted count；
- follow-up selector。

## 9.4 `context_impact`

用途：

- change blast radius；
- callers/callees；
- tests；
- DB/SQL 相关影响（若数据可取得）。

主要后端：CodeGraph；必要时 Serena 验证 symbol。

## 9.5 `context_run`

用途：统一执行开发命令并治理输出。

流程：

```text
command
→ classify
→ 能 RTK 则 RTK
→ execute
→ Output Gate
→ handle raw output
→ 返回关键结果
```

必须完整返回：

- exit code；
- command；
- duration；
- failure summary；
-关键 error lines；
- handle；
- output token before/after。

## 9.6 `context_fetch`

用途：取回被 Handle 化/压缩/省略的原始证据。

支持：

- handle + line range；
- handle + JSON path；
- handle + regex/search；
- handle + offset/page；
- handle metadata。

### 禁止再增加什么

不要为了“方便”继续暴露：

- `headroom_compress`
- `jmunch_peek`
- `serena_find_symbol`
- `codegraph_explore`
- `rtk_exec`

这些都是 ContextMind 内部 adapter 的职责。

只有真实 benchmark 证明统一 6 工具无法表达某关键能力时，才允许增加第 7 个工具，并必须写 ADR。

**不要**为口径单独加 `context_pin` 工具。pin/facts 是 `context_get` 的一等候选源（场景 G）。

---

# 10. Router 设计

Router 必须是**确定性优先**，不要把每次工具选择都再交给一个 LLM。

## 10.1 路由优先级

### 场景 A：仓库总体问题

```text
orient/explore → CodeGraph
```

### 场景 B：精确 symbol

```text
Serena → 必要时 CodeGraph 验证关系
```

### 场景 C：影响范围

```text
CodeGraph impact/review → Serena 精确引用确认
```

### 场景 D：Shell

```text
RTK supported?
  yes → RTK
  no  → raw execution
→ Output Gate
```

### 场景 E：MCP 大回包

```text
postToolUse
→ size/token threshold
→ content classifier
→ structured reducer / handle / compressor
```

### 场景 F：大文件直接 Read

```text
preToolUse(Read)
→ 文件类型策略（§15.2）
→ 文件大小/行数阈值
→ 是否明确范围读取？
→ 是否活跃编辑目标？
→ 同 hash 是否已在本 session 出现（Dedup stub）
→ 若无正当理由，deny
→ agent_message 指向 context_find/context_get
```

### 场景 G：业务口径 / 已决 / 热表 / memory pin

```text
canonical facts（Forge / decided / hot-tables）
→ 命中则停止同题二搜
→ 与 CodeGraph/Serena **串行**（先口径或先符号由 intent：坑/流程走 facts，改 Java 走图）
→ 禁止同一用户问题上 CG + facts 并行双开
→ 0-hit 才允许一次降级检索
```

### 场景 H：MCP 进程失踪

```text
sessionStart health
→ 规则依赖的 adapter 不在工具目录
→ 短提示 + telemetry warning
→ fail-open 普通开发；fail-closed 仅无界 Read 静态规则仍可本地判定
```

---

# 11. Token Budget Engine

## 11.1 必须使用真正 token counter

字符数只能用于超早期快速估计。

最终 benchmark 必须固定 tokenizer，并记录 tokenizer 名称/版本。

## 11.2 默认预算

以下只是初始默认值，最终由真实 benchmark 调优：

| Surface | 默认预算 |
|---|---:|
| `context_orient` | 800 tokens |
| `context_find` | 1000 tokens |
| `context_get` | 1600 tokens |
| `context_impact` | 1200 tokens |
| 普通 Shell 成功输出 | 800 tokens |
| Shell 失败输出 | 1600 tokens |
| 普通 MCP 返回 | 1200 tokens |
| 错误/异常 MCP 返回 | 1800 tokens |
| Always rules 总量 | ≤ 400 tokens |
| ContextMind 6 tools schema 总量 | 目标 ≤ 2500 tokens |
| 动态工具目录 + 用户 @ SKILL 单次注入 | 目标 ≤ 1500 tokens（超则 doctor FAIL / 拒绝挂载） |
| sessionStart 探活失败时的提示 | ≤ 120 tokens，必须点名缺失 server |

## 11.3 动态预算

可根据：

- task complexity；
- content type；
- error/success；
- active edit target；
- current session context pressure；
- whether a raw handle exists；
- whether same evidence already appeared；

动态增减。

## 11.4 绝不以“截断前 N token”作为唯一策略

粗暴 head truncation 会丢掉错误尾部、总结、diff 后段等关键内容。

---

# 12. Output Gate

Output Gate 是 ContextMind 最关键模块之一。

## 12.1 Pipeline

```text
raw output
→ normalize encoding
→ secret/path redaction policy
→ token count
→ fingerprint
→ duplicate detection
→ classify content
→ critical evidence extraction
→ handle raw output
→ choose reducer/compressor
→ verify preservation contract
→ emit bounded result
→ record metrics
```

## 12.2 Content types

至少支持：

- JSON object/array；
- tabular rows；
- build log；
- test log；
- stack trace；
- git diff；
- git log；
- grep/search results；
- source code；
- generic text；
- binary/unsupported metadata。

## 12.3 Preservation Contract

### 测试失败输出必须保留

- failing test name；
- assertion expected/actual；
- first meaningful stack frames；
- root cause chain；
- exit code；
- summary counts。

### build 输出必须保留

- module；
- compiler error；
- file:line；
- fatal error；
- final status。

### git diff 必须保留

- changed file names；
- hunks relevant to task；
- deletion/addition semantics；
- mode/rename info（若有）。

### JSON 必须保留

- schema/keys；
- errors；
- outliers；
- count；
- representative rows；
- handle。

## 12.4 Compression safety

代码正文不是默认 aggressive compression 对象。

对于活跃代码：

- 优先 symbol retrieval；
- 如果必须压缩，只做结构抽取，不伪造逻辑摘要；
- 精确修改前必须取回原 source。

---

# 13. Handle Store

## 13.1 数据结构

至少：

```text
handle_id
session_id
source_type
tool_name
created_at
expires_at
raw_hash
raw_tokens
compressed_tokens
content_type
compression_method
provenance
storage_path/blob
metadata_json
```

## 13.2 Handle ID

要求：

- 短；
- 不泄露路径；
- 随机/哈希冲突安全；
- 可在日志中追踪。

## 13.3 TTL

默认可配置。

建议：

- session 活跃期一定可取；
- 默认 6~24 小时范围由实测确定；
- 用户可配置立即删除/更长保留；
- 敏感项目允许 session end 清空。

## 13.4 原文不是永远存储

需要：

- size cap；
- TTL cleanup；
- WAL/vacuum 策略；
- 明确磁盘上限；
- `contextmind gc`。

---

# 14. Dedup 与 Context Cache

## 14.1 去重对象

- 同一个文件相同 hash 的重复读取；
- 同一个 symbol source；
- 相同工具结果；
- 相同 JSON rows；
- 相同错误重复输出；
- 相同 CodeGraph packet。

## 14.2 去重不能隐藏变化

必须关联：

- file mtime/hash；
- git worktree state；
- CodeGraph freshness；
- Serena project state；
- tool input fingerprint。

编辑后旧缓存自动 stale。

## 14.3 重复返回格式

不要再次输出全文，只返回：

```text
[duplicate evidence]
handle: ...
source: ...
unchanged_since: ...
key facts: ...
```

**强制：** CodeGraph/Serena/`context_get` 已返回过的同一 `path+hash`（或同一 symbol body），随后 `Read`/`Grep` 整文件必须走 stub，不得再灌源码。explore 返源 = 已 Read。

---

# 15. Read Guard：彻底阻止无界大文件读取

## 15.1 preToolUse(Read) 规则

对 Read 工具检查：

- path；
- file size；
- line count；
- requested range；
- whether exact symbol/range known；
- whether file is generated/vendor/binary；
- current task intent。

## 15.2 按文件类型的初始阈值（须用 shejiuPro 校准）

通用：

- generated/vendor/minified：默认阻止；
- lockfile：除非任务需要，阻止全读。

Java：

- `*ServiceImpl.java` / `*Service.java`：**未指定 range 且 >80 行** → deny（对齐现网 L0：无成功 explore 禁整读大 Service）。
- 其他 `.java`：>400 行且无 range → deny。
- 用户 `@` 且 ≤80 行：允许。

MyBatis / Mapper：

- `*Mapper.java` ≤120 行：允许。
- `*Mapper.xml`：**禁止整份灌入**。允许按 `<select|insert|update|delete id="...">` 切片，或 Read 带 offset/limit 对准目标 statement。动态 SQL/`<include>` 只带相关 fragment。

文档 / 规则：

- `workflows.md` / `pitfalls-*.md` 等长口径：**deny 整读**，走场景 G canonical facts。
- Always-applied `.mdc` 总量安装后必须 ≤400 tokens；超则 `doctor` FAIL。

Escape 与 override 见 §15.4。

## 15.3 deny 后必须给 Agent 明确下一步

示例：

```text
Large unbounded read blocked by ContextMind.
Use context_orient/context_find/context_get to retrieve bounded evidence.
If full content is truly required, request a bounded range or explicit override with reason.
```

## 15.4 Escape hatch

不能完全禁止 full read。

允许：

- 用户明确要求；
- 文件很小；
- 结构化配置必须全量审查；
- 编译/生成问题确实需要全文件；
- 经过 `override_reason`。

所有 override 计入 Telemetry，方便发现规则误杀。

---

# 16. Shell Guard

## 16.1 preToolUse Shell 自动改写

优先使用 Cursor `updated_input`。

可安全重写的命令进入 RTK。

## 16.2 不可盲目重写

以下情况必须谨慎：

- 命令本身有 side effect；
- 重定向/管道影响语义；
- shell quoting 复杂；
- interactive command；
- 用户明确要 raw output。

## 16.3 post execution

无论是否 RTK，结果都进入 Output Gate。

但必须避免 double compression：

```text
第一层（RTK 或 CC，config 锁定的唯一 owner）已压缩且 < budget
→ passthrough

第一层输出仍 > budget 或第一层不支持该命令
→ handle + Output Gate 结构化裁剪（第二层只处理超预算残余）
```

失败路径（非零 exit、FAIL、Exception、javac error）：

- 预算用 `shell_failure`（默认 1600）；
- 禁止通用 log 去重作为默认；
- Preservation Contract 未满足则 **回退原文**（ABSTAIN），宁多花 token。

---

# 17. MCP Output Guard

## 17.1 使用 `postToolUse`

对于 MCP tool：

1. token count；
2. 若在预算内，原样返回；
3. 若超预算，先 Handle 化；
4. 分类压缩；
5. 返回 `updated_mcp_tool_output`。

## 17.2 工具 profile

允许 per-tool profile，例如：

```yaml
MCP:mysql_query:
  max_tokens: 1400
  preserve:
    - columns
    - row_count
    - nulls
    - errors
  rows: handle_body

MCP:codegraph_explore:
  max_tokens: 1600
  preserve:
    - paths
    - symbols
    - stale_banner
  source_bodies: count_as_read_for_dedup
```

## 17.3 未知 MCP

未知工具使用 generic safe profile：

- 不重排危险结构；
- 先 handle；
- 保留类型和 top-level keys；
- 提供 fetch 指引。

---

# 18. `context_get` 任务上下文组装算法

不要直接复制 jCodeMunch 实现；自己实现统一算法。

## 18.1 输入解析

提取：

- task intent；
- explicit symbols；
- file hints；
- error identifiers；
- API/DB names；
- test names。

## 18.2 候选生成

候选来源：

1. Canonical facts（口径/pin/热表/decided）——场景 G，可短路；
2. CodeGraph explore/search（实装有则用）；
3. Serena symbols/references（仅 adapter enabled）；
4. changed files；
5. recent failures；
6. explicit user paths。

## 18.3 Ranking

基础分数必须可解释：

```text
score =
  canonical_fact_hit
+ exact_symbol_match
+ explicit_path_match
+ graph_proximity
+ reference_strength
+ changed_file_boost
+ test_relevance
+ freshness
- duplication_penalty
- large_block_penalty
- same_question_dual_search_penalty
```

`canonical_fact_hit` 为真时，同题禁止并行图检索（场景 G）。

无需一开始引入 embedding。

只有 deterministic ranking 证明不足时才考虑 semantic vector。

## 18.4 Packing

在预算内按证据价值排序打包。

要求：

- 不切断 symbol 中间；
- 不重复 imports/header；
- 共享前缀只保留一次；
- 每块有 provenance；
- 明确 omitted 数量。

---

# 19. Serena Adapter

## 19.1 必须先跑官方 smoke

确认：

- Serena 安装成功；
- 项目激活成功；
- Java language server 正常；
- 能获取 symbol overview；
- 能 find symbol；
- 能 find referencing symbols；
- 编辑后状态可刷新。

## 19.2 Adapter 只使用公开稳定面

不得 import 深层私有模块作为默认方案。

## 19.3 超时与降级

Serena/JDTLS 首次启动较重时：

- health 状态可显示 warming；
- 允许 CodeGraph fallback；
- 不允许因为一次 cold-start 就永久禁用 Serena。

## 19.4 Java 专项测试

至少覆盖：

- interface → implementation；
- service → mapper；
- overloaded method；
- inherited method；
- annotation-heavy Spring class；
- inner class；
- Lombok 场景（能力边界需真实确认）；
- cross-module reference。

## 19.5 门槛触发（默认 Day-1 关闭）

仅当下列**全部**满足才启用 Serena adapter：

1. S6 CodeGraph 实装能力下，代表性 Java 任务正确率或返工次数劣于基线，且证据写明「缺精确 symbol/引用」；
2. JDTLS 冷启动延迟单独统计，不计入 hook fast-path；
3. 对 Agent 仍只暴露 6 工具，Serena 不出现在 Cursor MCP 列表。

未启用时：`context_find` → CodeGraph explore + bounded file range。不得因为规范点名 Serena 就默认安装。

---

# 20. CodeGraph Adapter

## 20.1 使用 bounded primitive

优先（**仅当实机探测存在**）：

- `explore`（shejiuPro 常见唯一切面）
- `orient` / `packet_get` / `workspace_symbols` / `calls` / `impact` / `review`

探测为 0 的 API：Router 走降级，禁止报错伪装成功。`explore` 的 query 约束见 §4.2。

## 20.2 Freshness

编辑后所有关键调用必须检查 freshness。

若 stale：

- refresh；
- 重跑；
- 不得把旧 graph 当新代码证据。

## 20.3 Warm-up

真实基准同时测：

- cold；
- warm；
- changed-file refresh。

不要只报最好看的 warm 数字。

---

# 21. Headroom Adapter

## 21.1 只用它擅长的内容

优先候选：

- JSON；
- logs；
- search results；
- diff；
- general text。

## 21.2 活跃源码保守

不要开启 aggressive code compression 后就把所有函数体砍掉。

代码节省主要应来自：

- Serena/CodeGraph 精确取证；
- Read Guard；
- Dedup。

## 21.3 压缩前后验证

每种 compressor 必须 golden test：

- 错误是否保留；
- 数值是否被伪造；
- key 是否丢失；
- 顺序是否重要；
- 原文是否可 fetch。

---

# 22. Repomix Adapter

用途仅限：

- benchmark baseline；
- token tree；
- snapshot；
- large-repo structure comparison。

不要在日常每轮任务都 repomix 整仓库。

---

# 23. Rules / Skills / Agents 的最终布局

## 23.1 Always Rule

只保留类似：

```text
1. Prefer ContextMind bounded tools; no unbounded Java/XML dumps.
2. Large shell/MCP output is governed by hooks, not by "remember to compress".
3. Reuse duplicate evidence stubs; do not re-read unchanged hash.
4. Canonical facts vs code graph: serial, never same-question dual search.
5. Heavy verify may use verification-runner; default zero parallel explorers.
6. Do not declare product-complete until ContextMind gates pass.
```

目标 ≤ 400 tokens。

## 23.2 Skills

建议：

```text
.cursor/skills/
├── contextmind-maintain/
├── java-context/
├── test-closure/
├── token-benchmark/
└── upstream-upgrade/
```

详细流程放 skill references，不放 always rule。

## 23.3 Agents

```text
.cursor/agents/
├── context-explorer.md
├── verification-runner.md
└── quality-auditor.md
```

每个 Agent prompt 要短、职责单一。

---

# 24. Telemetry 与 Dashboard

## 24.1 ContextMind 要回答的问题

Dashboard 必须能回答：

1. 今天 ContextMind 拦了多少次大 Read？
2. Shell 原始 token / 返回 token？
3. MCP 原始 token / 返回 token？
4. 哪个工具最浪费？
5. 哪些文件被重复读取最多？
6. Serena/CodeGraph 命中率？Canonical facts 命中率？
7. full-read override 次数？
8. Handle fetch 率？
9. 压缩后又 fetch，说明是否压得过头？
10. 每个任务总 savings？
11. Token 减少是否伴随任务成功率下降？
12. Hook/Router 增加多少延迟？
13. **三列账是否拆开**（见 §24.5）？
14. 哪些 adapter `sessionStart` 缺失？

## 24.2 关键指标

至少记录：

```text
input_tokens_raw
output_tokens_emitted
tokens_avoided
reduction_ratio
handle_created
handle_fetched
dedup_hit
read_blocked
read_override
rtk_rewrite
adapter_used
adapter_latency_ms
hook_latency_ms
router_latency_ms
compression_latency_ms
task_id
session_id
tool_name
content_type
success/failure
adapter_missing
```

## 24.3 不允许伪造“节省 Token”

`tokes_avoided` 必须有明确定义：

```text
tokens_avoided = measured_raw_payload_tokens - measured_emitted_payload_tokens
```

对于“因为 Read Guard 没读文件而避免的 token”，必须使用同一 tokenizer 对“若正常读入的内容”进行离线测量，标记为 `prevented_read_tokens`，不要混入实际 tool output savings。

## 24.4 三列账（会员窗必读）

禁止用单一「节省 token」糊弄 8787 Dashboard。必须分列：

| 列 | 含义 | Grok/Composer/Auto |
|---|---|---|
| `prevented_read_tokens` | Read Guard/Dedup 没让进窗的量 | **有** |
| `tool_emitted_savings` | Shell/MCP Output Gate 前后差 | **有** |
| `proxy_llm_savings` | 8787/对话压缩 | **通常为 0**（BYOK 才非 0） |

Grok 窗 `proxy_llm_savings=0` 是预期，不是安装失败。

## 24.5 Dashboard 不是第一优先

先保证数据模型正确，再做 UI。

UI 最低要求：

- Overview；
- Sessions；
- Tool/Adapter breakdown；
- Before/After；
- Errors；
- Benchmark；
- Overrides。

---

# 25. Security / Privacy

## 25.1 默认本地

- 不上传 source；
- 不上传 raw tool result；
- 不把文件路径/代码放 telemetry 外部服务。

## 25.2 Secrets

Handle store 写盘前：

- 检测常见 token/key/password；
- 可配置 redact；
- 不把 secret 打到 Dashboard。

## 25.3 Path Safety

`context_fetch` 必须防：

- `../` traversal；
- symlink escape；
- 任意文件读；
- handle 猜测。

## 25.4 Shell Safety

ContextMind 不是提权工具。

- 不改变命令权限；
- 不绕过 Cursor 原有安全确认；
- 不为了 RTK 重写而改变 side effect。

---

# 26. 配置设计

单一主配置，例如：

```yaml
contextmind:
  project_root: "E:/workA/shejiuPro"
  mode: "balanced"

budget:
  orient: 800
  find: 1000
  get: 1600
  impact: 1200
  shell_success: 800
  shell_failure: 1600
  mcp_default: 1200
  always_rules: 400
  mcp_schema_total: 2500
  catalog_plus_skills: 1500

read_guard:
  enabled: true
  max_unbounded_lines: 400
  max_unbounded_bytes: 65536
  java_service_unbounded_lines: 80
  mapper_xml: "statement_slice"

shell:
  first_layer: "auto"   # rtk | context_compress | auto(A/B lock)
  forbid_rtk_log_on_failure: true

adapters:
  serena:
    enabled: false      # §19.5 门槛后才开
  codegraph:
    enabled: true
    probe_tools: true
  rtk:
    enabled: true
  headroom:
    enabled: true
    as: compressor_backend
  context_compress:
    enabled: auto
  facts:
    enabled: true       # Forge/memory/decided/hot-tables

handles:
  ttl_hours: 12
  max_disk_mb: 1024

telemetry:
  enabled: true
  local_only: true
  columns: [prevented_read_tokens, tool_emitted_savings, proxy_llm_savings]
```

要求：

- 有 schema validation；
- `doctor` 能发现错误；
- 不允许 20 个环境变量和 4 个 yaml 相互覆盖到无法理解。

---

# 27. CLI

最少提供：

```text
contextmind install
contextmind uninstall
contextmind start
contextmind stop
contextmind status
contextmind doctor
contextmind benchmark
contextmind report
contextmind gc
contextmind config validate
```

要求：

- Windows PowerShell 一等支持；
- 路径含空格；
- 非管理员安装优先；
- 安装/卸载幂等；
- 不破坏用户现有 Cursor 配置；
- 修改配置前自动 backup；
- 卸载只移除 ContextMind 自己加入的部分。

---

# 28. 安装器要求

## 28.1 自动发现

检查：

- Cursor；
- Python/uv；
- Rust（仅源码构建需要）；
- Serena；
- CodeGraph；
- RTK；
- Headroom；
- existing context-compress；
- Java/JDK；
- Git；
- Node（如需要）。

## 28.2 不强行覆盖用户配置

对 `.cursor/hooks.json` / `mcp.json`：

- parse；
- merge；
- backup；
- conflict detect；
- round-trip test。

## 28.3 Doctor

`contextmind doctor` 至少输出：

```text
PASS/WARN/FAIL
- core daemon
- hook integration
- Cursor config
- MCP server
- Serena
- Java LSP
- CodeGraph
- RTK
- Headroom compressor
- Handle DB
- Metrics DB
- project index freshness
- write permissions
```

---

# 29. 代码质量“极致水准”硬规范

## 29.1 少代码优先

每次完成功能后必须问：

- 能否删一层 wrapper？
- 是否已有上游能力？
- 是否重复封装？
- 是否出现“一行函数只转发一行函数”且没有契约价值？
- 是否把配置变成了代码？
- 是否有通用框架只服务一个 case？

## 29.2 禁止过度抽象

只有满足以下至少一项才新建 abstraction：

1. 两个以上真实实现；
2. 明确稳定契约需要隔离上游；
3. 测试替换需要；
4. 安全/性能边界需要。

## 29.3 删除死代码

最终必须运行：

- Python dead-code/static checks（选定并固定工具）；
- unused imports；
- unreachable；
- Rust clippy（若有）；
- duplicate detection；
- 未使用 config；
- 未使用 adapter；
- TODO/FIXME 扫描。

任何 TODO/FIXME 必须：

- 删除；或
- 转成已记录 issue/known limitation；
- 不允许用 TODO 掩盖核心未完成。

## 29.4 异常处理

禁止：

```python
except Exception:
    pass
```

禁止：

- 静默 fallback；
- 吞掉 subprocess stderr；
- 无 context 的 `RuntimeError("failed")`。

## 29.5 类型与数据模型

- 外部 JSON 全部 schema 验证；
- Cursor Hook 输入输出有明确 model；
- 上游 adapter response 有统一 normalized model；
- DB schema migration 可追踪。

## 29.6 日志

日志级别：

- debug：详细；
- info：关键生命周期；
- warning：降级；
- error：真实失败。

禁止把大 tool payload 直接打日志。

---

# 30. 测试总策略

不能只做 unit test。

必须有六层：

```text
L1 Unit
L2 Golden preservation
L3 Adapter integration
L4 Cursor Hook contract
L5 Real repository E2E
L6 A/B benchmark + regression
```

---

# 31. L1 — Unit Tests

覆盖：

- tokenizer；
- budget allocation；
- content classifier；
- dedup；
- handle CRUD/TTL；
- selector；
- path security；
- rule matching；
- shell rewrite safety；
- output normalizer；
- config validation；
- metrics math。

要求：核心 pure function 高覆盖，但不追求“为了 100% 覆盖率写无价值测试”。

---

# 32. L2 — Golden Preservation Tests

准备真实 fixture：

- Maven compile failure；
- Maven test failure；
- Java stack trace；
- 大 git diff；
- 大 JSON rows；
- MySQL result；
- grep 1000 行；
- duplicated log；
- success build；
- UTF-8 中文日志；
- Windows CRLF。

每个 fixture 有 golden assertions：

- 哪些信息必须存在；
- 哪些噪声可删；
- handle 能否还原；
- token reduction。

---

# 33. L3 — Adapter Integration

## Serena

真实启动、真实 Java 项目、真实 symbol。

## CodeGraph

真实 index、explore、impact、freshness。

## RTK

真实命令对比 raw vs RTK。

## Headroom

真实 compressor，不 mock。

## Repomix

真实 token tree / compress 对照。

测试中允许对故障注入 mock，但**至少一套真实集成必须通过**。

---

# 34. L4 — Cursor Hook Contract Tests

用真实 Cursor 当前 hook schema fixture：

- `preToolUse Read` allow；
- `preToolUse Read` deny；
- `preToolUse Shell` updated_input；
- `postToolUse MCP` updated_mcp_tool_output；
- hook malformed input；
- daemon down；
- timeout；
- exit code behavior；
- `stop` gate follow-up。

要求：输出必须是 Cursor 可接受 JSON，stdout 不能混 debug 文本。

---

# 35. L5 — 真实 Java 项目 E2E

至少设计以下任务：

## E2E-01 精确查方法

给出一个 Java service 方法名，要求找到：

- implementation；
- mapper；
- caller；
- tests。

对比 baseline Cursor 方式和 ContextMind。

## E2E-02 大 Service 修改

目标文件 > 1000 行。

要求 Agent 不全读文件，仍正确修改指定方法。

## E2E-03 MyBatis 链路

Controller → Service → Mapper XML → DB field。

验证跨文件上下文。

## E2E-04 编译失败

主动制造可恢复 compile failure，验证 Output Gate 仍保留准确 file:line/error。

## E2E-05 测试失败

验证 assertion 和 root cause 不丢。

## E2E-06 大数据库结果

让 MCP 返回大量 rows，验证 Handle + fetch。

## E2E-07 Git diff

大 diff 经 RTK/Output Gate 后，仍能完成 review。

## E2E-08 编辑后 freshness

修改 symbol 后立即再次 impact/search，确保不是旧索引。

## E2E-09 重复读取

连续请求同一证据，验证 dedup。

## E2E-10 Override

用户明确要求 full read，验证不会被错误永久阻止。

---

# 36. L6 — A/B Benchmark

## 36.1 绝对禁止“只跑 ContextMind，不跑 baseline”

同一任务、同一仓库 commit、同一模型设置、同一输入条件。

A：未启用 ContextMind 的当前流程。

B：启用 ContextMind。

## 36.2 记录指标

每任务：

```text
task_success
functional_correctness
files_read
raw_file_tokens
tool_output_tokens
mcp_output_tokens
rule/schema_tokens
contextmind_emitted_tokens
handle_fetch_tokens
subagent_tokens (能测则测)
latency
retries
wrong_turns
```

## 36.3 不能只看“返回 payload”

最终目标是**任务级上下文成本**，不是某个压缩器单次 95%。

---

# 37. 最终硬性 Gate

以下是第一次正式发布的硬 Gate。若真实基线证明某阈值物理不合理，可以调整，但必须：

- 给出原始数据；
- 写 ADR；
- 用户可看到；
- 不能为了 PASS 偷偷降低标准。

## G0 项目理解 Gate

- [ ] 8 个上游项目已记录 SHA/tag/license/API。
- [ ] 当前 Cursor 官方 Hook schema 已复核。
- [ ] 当前环境已快照。
- [ ] 当前 shejiuPro token 基线已跑。
- [ ] Cursor 当前会话工具目录已快照（哪些 MCP **实际可见**，不只 mcp.json 声明）。
- [ ] Always Rule 现网 token 数已测（含 L0/decided/user-core）。

## G1 功能 Gate

- [ ] 6 个 MCP tools 全部真实工作。
- [ ] Hooks 安装并实际触发。
- [ ] Read Guard 工作。
- [ ] Shell rewrite 工作。
- [ ] MCP Output Gate 工作。
- [ ] Handle fetch 可恢复原文。
- [ ] CodeGraph adapter 按**实装探测**工作（缺的 API 有降级，无假装调用）。
- [ ] Serena + Java：**仅当 §19.5 门槛满足并启用**才强制；未启用则 `context_find` 降级路径 E2E PASS。
- [ ] sessionStart 探活：缺失 adapter 有短警告 + telemetry。
- [ ] 报告能看到三列账（Dashboard UI 可后做）。

## G2 正确性 Gate

- [ ] E2E 必测任务全部 PASS。
- [ ] ContextMind 相比 baseline **不得降低任务成功率**。
- [ ] Golden preservation 关键字段 100% 保留。
- [ ] 压缩结果不存在伪造字段/数值。
- [ ] 修改代码后原项目编译/测试不回归。

## G3 Token Gate

目标分层：

### 强制最低

- [ ] 大 Shell 输出中位减少 ≥ 60%。
- [ ] >4K token 的大 MCP 输出中位减少 ≥ 70%。
- [ ] 大文件代码探索输入 token 中位减少 ≥ 50%。
- [ ] 重复证据二次注入减少 ≥ 90%。
- [ ] Always Rule ≤ 400 tokens。
- [ ] ContextMind 核心 MCP schema 总预算 ≤ 2500 tokens。
- [ ] 动态目录 + 手动 @ SKILL 单次注入 ≤ 1500 tokens（doctor）。
- [ ] 失败 Shell **未**走通用 log 去重导致丢堆栈/断言（golden）。
- [ ] 同 hash 二次 Read 走 Dedup stub ≥ 90% 覆盖（抽样会话）。
- [ ] `proxy_llm_savings` 与 `tool_emitted_savings` 分列，会员窗前者为 0 不判 FAIL。

### 任务级硬目标

- [ ] 代表性真实开发任务整体**可控 Context 输入中位减少 ≥ 40%**，且正确率不下降。

### 极致目标

- [ ] 在适合 ContextMind 的 retrieval/tool-heavy 任务上，整体可控 Context 输入中位减少 **≥ 60%**。

> “可控 Context”指我们能从 Read/Tool/MCP/Rules/Schema 等测量和治理的部分，不声称能看到 Cursor 服务端隐藏 system tokens。

## G4 性能 Gate

- [ ] Hook fast-path 不产生肉眼可感卡顿。
- [ ] 本地静态 allow/deny 决策 p95 目标 ≤ 25 ms（若当前硬件可达）。
- [ ] warm Router 本地非重索引操作 p95 目标 ≤ 250 ms。
- [ ] 压缩/外部 adapter 的额外延迟单独统计，不伪装成 hook 延迟。
- [ ] cold-start 单独报告。

若 Rust `cmhook` 与 Python hook 的真实差异不足以证明维护价值，删除 Rust 层，保留更简单实现。

## G5 稳定性 Gate

- [ ] 连续 100 次 Hook fixture 无 schema error。
- [ ] 连续 50 次 MCP call 无 handle corruption。
- [ ] daemon restart 后数据一致。
- [ ] Cursor 重启后配置仍有效。
- [ ] 上游 adapter 单个挂掉不会拖死全部 ContextMind。
- [ ] 故意卸掉一个 MCP 时 sessionStart 记录 `adapter_missing`，且 Read Guard 仍可用。

## G6 代码质量 Gate

- [ ] formatter/linter/typecheck 全 PASS。
- [ ] unit/integration/e2e 全 PASS。
- [ ] dead code 审计完成。
- [ ] duplicate code 审计完成。
- [ ] 无未解释 TODO/FIXME。
- [ ] 无吞异常。
- [ ] 无不必要 wrapper。
- [ ] 无重复配置源。
- [ ] public API 最小化。

## G7 安装/回滚 Gate

- [ ] clean install PASS。
- [ ] repeated install 幂等 PASS。
- [ ] uninstall PASS。
- [ ] uninstall 后 Cursor 原配置恢复/保留 PASS。
- [ ] Windows 路径/空格 PASS。

## G8 证据 Gate

必须存在：

```text
docs/reports/FINAL_GATE_REPORT.md
docs/reports/TOKEN_BENCHMARK_REPORT.md
docs/reports/CORRECTNESS_REGRESSION_REPORT.md
docs/reports/CODE_QUALITY_AUDIT.md
docs/reports/INSTALLATION_VALIDATION.md
docs/evidence/*
```

没有证据文件 = 没完成。

---

# 38. Stop Gate：防止 AI 提前结束

ContextMind 自身开发时，建议项目级 `stop` hook 执行一个轻量 `verify_completion.py`。

逻辑：

1. 检查本次任务 manifest；
2. 检查必需测试状态；
3. 检查最终 Gate evidence；
4. 若未完成，返回 follow-up message：

```text
ContextMind completion gate is not satisfied.
Continue the task. Read docs/reports/current_gate_state.json,
fix all failing gates, rerun the required validation,
and do not declare completion until every hard gate passes.
```

## 38.1 防死循环

Stop Gate 不能“永远无脑挡住”。

如果是外部不可修复 blocker：

- Gate 状态必须标记 `BLOCKED_EXTERNAL`；
- 附证据；
- stop hook 允许退出；
- 最终回答必须明确未完成项。

这和“测试失败但懒得修”是两回事。

---

# 39. 开发任务图（切片可上线，产品完成仍看 G0–G8）

> T00–T20 是依赖与验收编号。S1–S3 完成后允许接入日常 Cursor；**不得**在 S1 之前优先 Serena/Dashboard。宣布产品完成仍须 G0–G8。

映射：

```text
S0 → T00 T01
S1 → T10(Read) T12 T13
S2 → T07 T08 T09（第一层单 owner）
S3 → T10(MCP+sessionStart) + mysql 等内部 adapter
S4 → T03 T14（卸裸 MCP）
S5 → T06 facts 候选
S6 → T04
S7 → T05（门槛）
S8 → T15
然后 T16–T20
```

## T00 — 接管与事实冻结

- 读取 ContextMind/目标项目/8 上游/官方 Cursor docs；
- 记录 SHA/license；
- 环境 doctor；
- **实机探测**当前会话 MCP 目录 vs mcp.json；
- 形成 evidence。

**退出条件：G0 PASS。**

## T01 — Baseline

- 建 A/B task corpus；
- 记录当前 Cursor 流程；
- 记录 raw Read/Shell/MCP/Rules；
- 生成 baseline。

## T02 — Core Models + Config + SQLite

- normalized contracts；
- config schema；
- handle DB；
- metrics DB；
- migration。

## T03 — Unified MCP 6 Tools Skeleton

- schema 最小化；
- tool dispatch；
- error contract；
- token schema measurement。

## T04 — CodeGraph Adapter

- 探测实装工具列表；
- 仅调用存在的 API；`explore` query 纪律（FQCN/`*.java`）；
- freshness / timeout / fallback；
- explore 返源计入 Dedup「已 Read」。

## T05 — Serena Adapter（门槛，默认可 SKIP）

- 先写 §19.5 门槛证据；未满足则本任务标记 `SKIPPED_THRESHOLD`，降级路径必须绿。
- 满足后：Java project、find/reference、JDTLS health；仍不向 Cursor 裸露 Serena MCP。

## T06 — Router + Context Packing

- deterministic intent（含场景 G 串行）；
- candidate merge（facts 一等）；
- rank / budget pack / provenance。

## T07 — Shell Guard（单层 owner）

- A/B：RTK vs Context Compress，锁定 `shell.first_layer`；
- 失败路径禁止 `rtk log`；
- safe rewrite / raw fallback / metrics。

## T08 — Output Gate + Handle

- classify；
- dedup；
- JSON/log/diff/search；
- fetch；
- golden tests。

## T09 — Headroom Adapter

- 启用适合 compressor；
- preservation tests；
- 禁止 active-code aggressive default。

## T10 — Cursor Hooks

- sessionStart health；
- preToolUse Read（分类型阈值）；
- preToolUse Shell；
- postToolUse MCP `updated_mcp_tool_output`；
- failure hooks；
- stop gate；
- hook contract tests。

## T11 — cmhook 性能裁决

- 先测纯 Python/launcher；
- 若 Gate 已满足，不写 Rust；
- 若不满足，写最薄 Rust bridge；
- A/B latency 后裁决保留/删除。

## T12 — Dedup/Freshness

- file hash；
- tool fingerprint；
- stale invalidation；
- edit tests。

## T13 — Cursor Rules/Skills/Subagents

- Always Rule 瘦到 ≤400 tokens（现网 L0 迁 skill）；
- 默认 0 并行 explorer；最多 3 个专职 subagent；
- SKILL.md ≤800 tokens；
- 不重复 AGENTS 内容。

## T14 — Install/Doctor/Uninstall

- PowerShell；
- backups；
- merge Cursor configs；
- S4 起卸用户可见上游 MCP；
- idempotency。

## T15 — Telemetry/Report/Dashboard

- 三列账数据模型先于 UI；
- report CLI；
- dashboard 最小可用（S8，勿抢 S1）；
- no cloud by default。

## T16 — Full E2E

执行 §35 全部任务。

## T17 — A/B Benchmark

执行 §36；
生成 `TOKEN_BENCHMARK_REPORT.md`。

## T18 — 优化回路

对未过 Gate 的项目逐项修。

优先次序：

```text
正确性
> 数据保真
> 稳定性
> Token
> 延迟
> 代码体积
> UI
```

## T19 — 极致代码瘦身

在全部功能通过后：

- 删除重复逻辑；
- 合并薄 wrapper；
- 删除死 adapter；
- 合并重复 config；
- 降低 schema；
- 缩短规则；
- 删除无价值注释；
- 清 TODO；
- 再测。

## T20 — Final Gate

运行 G0–G8。T05 `SKIPPED_THRESHOLD` 时 G1 Serena 项记 N/A，不挡产品完成。

全部适用项 PASS 后才生成最终报告。S1–S3 允许提前接入，报告须标明「切片上线 / 产品未完成」。

---

# 40. 每个任务的标准执行模板

AI 对 T00-T20 每一项都必须使用这个闭环：

```text
[1] Goal
本任务的唯一目标是什么？

[2] Evidence Before Change
现状是什么？用什么命令/代码证明？

[3] Design
最小实现是什么？是否已有上游可复用？

[4] Change
实际修改哪些文件？

[5] Test
真实运行什么？

[6] Measure
正确性 / token / latency / coverage / size 数据是什么？

[7] Verdict
PASS / FAIL / BLOCKED_EXTERNAL

[8] If FAIL
根因 → 修复 → 重新从 [5] 开始

[9] Evidence
结果写入哪个 evidence/report？
```

---

# 41. Anti-Fake-Completion 规则

以下句子**不能当完成证据**：

- “理论上已经支持”；
- “应该可以”；
- “代码看起来没问题”；
- “测试预计通过”；
- “由于时间原因未跑”；
- “假设 Serena 正常”；
- “如果配置正确就会工作”；
- “大概率减少 80%”。

完成证据必须长这样：

```text
Command:
  uv run pytest tests/e2e/test_large_java_service.py -q
Exit:
  0
Result:
  8 passed
Artifacts:
  docs/evidence/e2e-large-service-20260901.json
Metric:
  baseline 14,820 tokens
  contextmind 5,910 tokens
  reduction 60.12%
Correctness:
  same target method changed; mvn test PASS
Verdict:
  PASS
```

---

# 42. Benchmark 设计原则

## 42.1 不允许 cherry-pick

任务集必须在优化前冻结。

## 42.2 至少三类任务

- retrieval-heavy；
- output-heavy；
- normal coding。

ContextMind 不能只挑大 JSON 证明自己厉害。

## 42.3 结果分布

报告：

- median；
- p75；
- p95；
- min/max；
- per-task；
- failure cases。

不要只报平均值。

## 42.4 正确率优先

如果节省更多 token 但错误率上升，属于 FAIL。

---

# 43. 真实项目验证重点：Java / Spring / MyBatis

针对首个接入项目必须专门测：

1. Controller endpoint → Service → ServiceImpl。
2. ServiceImpl → Mapper interface → Mapper XML。
3. DTO/VO/Entity 关系。
4. MyBatis `resultMap`。
5. XML `<include>` / 动态 SQL。
6. 多模块依赖。
7. 同名 method overload。
8. Spring annotation injection。
9. SQL 表名/字段检索。
10. 大 `*ServiceImpl.java` 不全读仍能安全编辑。
11. 巨型 `*Mapper.xml` 按 statement id 切片，禁止整文件进窗仍能改对 SQL。
12. 热表/已决口径命中后，同题不再二次 semantic_search。
13. CodeGraph 第一次 explore 打偏时，第二次必须收窄 query，且已返源文件不得再整读。
14. `mysql_query` 超预算：列名/行数/错误保留，行 body 走 Handle。

如果 Serena 未启用或 XML/MyBatis 能力不足，由 CodeGraph/statement-slice/text search adapter 补齐，不强迫一个引擎解决所有问题。不把「未开 Serena」当 G1 失败。

---

# 44. 失效/降级设计

## Serena down

```text
CodeGraph + bounded file search fallback
```

## CodeGraph stale/down

```text
若 Serena enabled → Serena + targeted search
否则 → statement-slice / bounded Grep（xml）+ 明确 stale 状态，禁止静默用旧图
```

## Canonical facts down

```text
0-hit 允许一次降级检索；禁止假装命中。状态：NO_MATCH / NO_INDEX
```

## MCP 不在当前会话目录

```text
sessionStart warning + telemetry adapter_missing
Read Guard 静态规则仍 fail-closed
其余 fail-open
```

## RTK 不支持命令

```text
raw command → Output Gate
```

## Headroom compressor fail

```text
safe structural reducer / handle only
```

## SQLite locked/corrupt

- 明确 error；
- 自动诊断；
- 不丢 raw stdout；
- 有 repair/backup 路径。

## daemon down

Hook 必须有清晰 fail-open/fail-closed 分类：

### fail-closed

- 明显危险/无界读取政策（若本地静态规则可判定）；

### fail-open

- ContextMind 内部观测失败不能阻断用户所有正常开发。

但 fail-open 必须计入 warning（daemon 恢复后可见）。

---

# 45. 性能优化原则

## 45.1 Fast path

如果 payload 已小于预算：

```text
count/estimate
→ passthrough
```

不要跑复杂压缩。

## 45.2 Lazy load

- Headroom heavy compressor 按需；
- Serena/JDTLS 预热但不阻塞所有普通 Hook；
- CodeGraph warm-up 在 workspace/session 合理时机。

## 45.3 IPC

若 daemon 模式：

- 连接复用；
- timeout 短；
- 本机 loopback/named pipe；
- payload size limit。

## 45.4 SQLite

- WAL；
- batch metrics writes；
- 不让每个 Hook fsync 大量数据。

---

# 46. Upstream 更新策略

不要复制后永远不管。

维护：

```text
upstreams.lock
```

记录：

```yaml
serena:
  repo: ...
  commit: ...
  license: MIT
  integration: mcp/process

codegraph:
  ...
```

升级流程：

1. diff changelog/API；
2. license 再检查；
3. adapter contract test；
4. A/B benchmark；
5. 更新 SHA；
6. 不允许自动追 latest 后直接进生产。

---

# 47. 文档事实源

最终至少维护：

```text
README.md                         用户入口
docs/architecture/OVERVIEW.md    当前架构
docs/architecture/CONTRACTS.md   6 tools + hooks
docs/decisions/*.md              ADR
docs/operations/INSTALL.md       安装
docs/operations/TROUBLESHOOT.md  排障
docs/reports/*                   实测报告
docs/evidence/*                  原始事实
upstreams.lock                    上游版本事实
```

禁止 README、AGENTS、开发文档各写一套冲突架构。

---

# 48. 最终交付清单

开发完成时仓库必须至少包含：

- [ ] 可运行 ContextMind core；
- [ ] 6 个 MCP 工具；
- [ ] Cursor hooks；
- [ ] Serena adapter；
- [ ] CodeGraph adapter；
- [ ] RTK adapter；
- [ ] Headroom compressor adapter；
- [ ] Handle store；
- [ ] dedup/freshness；
- [ ] token budget；
- [ ] PowerShell install/uninstall/doctor；
- [ ] 3 个专职 subagent；
- [ ] 极短 Always Rule；
- [ ] skills；
- [ ] telemetry；
- [ ] report/dashboard；
- [ ] unit/golden/integration/hook/e2e/benchmark；
- [ ] final reports；
- [ ] upstream lock/license matrix；
- [ ] rollback 方法。

---

# 49. 最终验收报告必须这样写

`FINAL_GATE_REPORT.md` 不允许写宣传文案，必须包含：

## 49.1 Environment

- OS
- Cursor
- model/session setup
- JDK
- Python
- ContextMind commit
- upstream commits

## 49.2 Gate table

| Gate | Result | Evidence |
|---|---|---|
| G0 | PASS | ... |
| G1 | PASS | ... |
| ... | ... | ... |

## 49.3 Token Results

按任务逐项 raw vs ContextMind。

## 49.4 Correctness

编译/测试/行为。

## 49.5 Latency

cold/warm 分开。

## 49.6 Failures Found During Development

必须写实际遇到过哪些失败、怎么修，不得把历史擦掉。

## 49.7 Remaining Limitations

如果真实存在就写。

## 49.8 Verdict

只允许：

- `PASS`
- `PASS_WITH_NON_BLOCKING_LIMITATIONS`
- `BLOCKED`
- `FAIL`

---

# 50. 代码完成后的“第二遍审计”

第一次全 Gate PASS 后，**不能立刻结束**。

必须再做一次只读审计：

## 50.1 架构审计

- 是否出现新的重复 router？
- adapter 是否泄漏上游私有类型？
- ContextMind 是否意外变成 Headroom fork？
- 是否有多套 Handle store？
- 是否有两套 token counter？

## 50.2 代码瘦身审计

- 可删文件；
- 可合并函数；
- 可去 wrapper；
- dead branch；
- unused dependency；
- duplicate regex/config；
- 过长函数；
- 过度 class hierarchy。

## 50.3 Token 反向审计

检查 ContextMind 自己是否制造新浪费：

- tool descriptions 是否太长；
- errors 是否重复；
- provenance 是否过长；
- rules 是否重复；
- subagent prompt 是否过长；
- Dashboard telemetry 是否进入模型 context（不应该）。

## 50.4 再跑完整回归

任何瘦身改动之后再跑 G1-G8。

---

# 51. AI 的最终工作纪律

1. **先证据，后判断。**
2. **先现状，后修改。**
3. **先复用成熟能力，后自研。**
4. **先正确性，后 Token 数字。**
5. **先消除上下文，后压缩上下文。**
6. **先小接口，后扩接口。**
7. **失败就修，不做“理论完成”。**
8. **开发完成后必须亲自实测。**
9. **实测失败必须继续修。**
10. **优化后必须重新测，防止越优化越差。**
11. **不能因为代码能跑就停止，还要做 dead code / duplicate / latency / token / regression 审计。**
12. **不能为了压缩率牺牲开发答案准确性。**
13. **不能用 mock 代替全部真实集成。**
14. **不能把一个上游的宣传 benchmark 当成 ContextMind 自己的成绩。**
15. **最终每一个结论都能追到命令、测试或证据文件。**

---

# 52. 给执行 AI 的可直接复制总指令

下面文本可直接作为开发任务入口：

```text
接管 ContextMind 项目，严格按《ContextMind — AI 一体化开发与极致上下文优化总规范》v1.1 执行。

架构是单一产品；实现按 §0.3 切片。S1–S3 可接入日常 Cursor。未过 G0–G8 不得宣布产品完成。

开始编码前必须理解并写入 evidence：
1. ContextMind 当前代码（若空仓则按本规范建仓）；
2. 目标 Cursor 项目配置、Always Rule token 数、**当前会话实际 MCP 目录**；
3. 上游 README/LICENSE/接口；CodeGraph 只按实装 API 做 adapter；
4. Cursor 当前 Hooks / MCP 发现（禁止每轮全量 catalog）。

不得凭记忆猜接口。必须记录 SHA、许可证、实测命令。禁止把本规范全文粘进对话。

随后：baseline → 按 S0→S8 / T00–T20 实现。T05 Serena 默认 SKIPPED_THRESHOLD。Shell 第一层只能有一个 owner。

遵守：Eliminate > Retrieve Precisely > Isolate > Deduplicate > Compress > Compact。

对 Cursor 默认只暴露 6 个 MCP 工具。facts 走 context_get，不加第 7 工具。Headroom 只做压缩 backend，不劫持 Grok/Composer/Auto HTTP。Telemetry 必须三列账。jCodeMunch 默认只做设计研究。

每片做完立即真测。Gate 失败则修到过。会员窗 proxy_llm_savings=0 不是失败。

瘦身审计后再回归。证据文件齐且 G0–G8 过才允许宣布完成。外部阻断写 BLOCKED_EXTERNAL。

现在从 S0/T00 执行，不要空泛计划替代工作。
```

---

# 53. 参考来源（执行时必须重新核验最新状态）

## Cursor 官方

- MCP: https://cursor.com/docs/mcp
- Hooks: https://cursor.com/docs/hooks
- Rules: https://cursor.com/docs/rules
- Skills: https://cursor.com/docs/skills
- Subagents: https://cursor.com/docs/subagents
- Plugins: https://cursor.com/docs/plugins

## 上游项目

- Serena: https://github.com/oraios/serena
- CodeGraph: https://github.com/lzehrung/codegraph
- RTK: https://github.com/rtk-ai/rtk
- jmunch-mcp: https://github.com/jgravelle/jmunch-mcp
- Headroom: https://github.com/headroomlabs-ai/headroom
- Repomix: https://github.com/yamadashy/repomix
- jCodeMunch MCP: https://github.com/jgravelle/jcodemunch-mcp
- TokView: https://github.com/headroomlabs-ai/tokview

---

# 54. 最终冻结结论

`ContextMind` 的成功标准不是“集成了很多开源项目”，而是：

> **在 Cursor 真实开发任务中，用更少、更新鲜、更精准、可恢复的上下文完成同样或更高质量的开发结果，并且这个结论有 A/B 数据、真实测试、回归结果和代码质量证据。**

最终架构的中心必须始终是：

```text
ContextMind Core
    ├── 强制治理（Hooks：Read/Shell/MCP/sessionStart）
    ├── 精确检索（CodeGraph 实装 + 门槛 Serena）
    ├── 口径短路（canonical facts → context_get）
    ├── 输出治理（单层 Shell owner + Output Gate）
    ├── 可逆取回（Handle Store + Dedup stub）
    ├── 预算 / Schema 税
    ├── 上下文隔离（默认 0 并行 explorer）
    └── 真实测量（三列账 + Benchmark）
```

而不是：

```text
“再装一个 Token 压缩器”
```

**只有在正确性不下降的前提下，Token 节约才算成功。只有经过真实开发任务验证的优化，才算优化。**

---

# 55. v1.1 修订对照（相对 1.0）

| 主题 | 1.0 | 1.1 |
|---|---|---|
| 交付 | 一口气做完全部模块才许用 | 架构单一产品；S1–S3 可上线；完成仍看 G0–G8 |
| Serena | Day-1 核心 | §19.5 门槛；默认关闭 |
| CodeGraph | 假设 orient/packet/impact 齐全 | 实装探测；缺则降级 |
| Shell | RTK 第一层 | 与 CC 二选一锁定；失败禁 log 通道 |
| 口径 | 未单列 | 场景 G；进 `context_get`；不加第 7 工具 |
| Read | 统一 400 行 | Java Service 80 行；Mapper XML 按 statement 切片 |
| Dedup | 重复读弱约束 | explore 返源 = 已 Read；二次 stub |
| 观测 | 易与 8787 混为一谈 | 三列账；会员窗 proxy=0 为预期 |
| MCP | 未写发现税 | 禁全量 catalog；sessionStart 探活 |
| Schema | 6 工具 ≤2500 | 另计 Always/SKILL/动态目录 |
| 业务仓 | 未写 | 不为 token 重构 Java |
