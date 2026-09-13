# Agent Host 兼容标准（ContextMind / Token-Mind）

> **读者**：维护 Token-Mind 的人类开发者；在任意 AI IDE 里改本仓代码的 Agent。  
> **目的**：统一「已适配哪些 Agent / IDE」「改代码该碰哪里、别碰哪里」「新 Host 怎么接」。

全栈位置见 [STACK-CONTRACT.md](./STACK-CONTRACT.md)。Host 注册表的机器真源是 [`contextmind/hosts.json`](../contextmind/hosts.json)。

---

## 1. 当前适配状态

| Host ID | 产品名 | verified | Hooks | MCP | 说明 |
|---------|--------|:--------:|:-----:|:---:|------|
| `cursor` | Cursor | ✅ | ✅ | ✅ | 项目级 `.cursor/hooks.json` + `.cursor/mcp.json` |
| `qoder` | Qoder | ✅ | ✅ | ✅ | Hooks 在 `.qoder/settings.json`；MCP 在 **用户级** `~/.qoder-cn/settings.json` |
| `codebuddy` | CodeBuddy | ✅ | ❌ | ✅ | 仅 MCP（`~/.codebuddy/mcp.json`），无 hook 治理 |
| `workbuddy` | WorkBuddy | ✅ | ❌ | ✅ | 仅 MCP；路径 `~/.workbuddy/connectors/*/mcp.json`（uid 目录用 glob 解析，见 §3.4）；profile 声明 `mountBrain` + `cwdSupported:false` |
| `codex` | Codex | ❌ | — | — | 占位；`unverifiedReason` 写明缺实机路径，**install 不会写配置** |
| `trae` | Trae | ❌ | — | — | 同上 |

**verified 的含义（load-bearing）**

- `verified: true` — 有人在真实安装上核对过配置路径与 JSON 形状；`contextmind install` 会写入该 Host 的 hooks/MCP。
- `verified: false` — 仅出现在 `doctor` / 看板 Host 列表；**install 拒绝写入**，避免「装上了但从不执行」的假治理。

Cursor 与 Qoder 是 **双 Host 同库治理** 的第一批正式适配；后续 IDE 走同一套数据驱动流程，**禁止**在业务逻辑里再写 `if (host === 'cursor')` 分叉。

---

## 2. 分层：什么该动、什么别动

### 2.1 只改数据（新 Host 的默认路径）

| 文件 | 职责 |
|------|------|
| [`contextmind/hosts.json`](../contextmind/hosts.json) | **唯一** Host 清单：能力、检测信号、配置路径、事件名映射、matcher、async 事件 |
| [`docs/evidence/CURSOR_HOOK_CONTRACT.md`](./evidence/CURSOR_HOOK_CONTRACT.md) | Cursor 官方 hook 契约证据（改 Cursor 相关 matcher/字段时对照） |

在 `hosts.json` 增加一条 profile → 跑实机验收 → `verified: true`。**不应**为此改 install-plan / cli / runtime 里的 Host 分支。

### 2.2 Host 中立（治理策略 — 所有 Host 共用）

改 **策略** 时只动这些；输出必须是 **内部 canonical 形状**，由 egress 层翻译：

| 区域 | 内容 |
|------|------|
| `contextmind/lib/runtime/pre-handler.mjs` | Shell / Read / MCP 预检、deny/allow 决策 |
| `contextmind/lib/runtime/post-handler.mjs` | MCP Output Guard、handle 化 |
| `contextmind/lib/adapters/*.mjs` | Shell / MCP / grep / git 适配 |
| `contextmind/lib/policy/` | 预算、TaskBundle 范围 |
| `contextmind/lib/install-plan.mjs` 的 `HOOK_ENTRIES` | **Canonical 事件名**（`preToolUse` 等）与 matcher **语义**；不含 Host 拼写 |
| `contextmind/lib/mcp-tools.mjs` | ContextMind MCP 工具面 |

内部决策字段约定（pre）：

```json
{ "permission": "allow|deny", "user_message": "...", "agent_message": "...", "updated_input": {} }
```

post 改写：

```json
{ "updated_mcp_tool_output": <与输入同形> }
```

### 2.3 Host 翻译层（双信封 — 动之前先读测试）

| 文件 | 职责 |
|------|------|
| [`cursor/hooks/cm-rpc.mjs`](../cursor/hooks/cm-rpc.mjs) | `toHostOutput()`：同时 emit Cursor 扁平和 Qoder `hookSpecificOutput` |
| [`native/cmhook.rs`](../native/cmhook.rs) | 原生 fast path；必须与 `toHostOutput` 保持 **同一双信封** |
| [`contextmind/lib/install-plan.mjs`](../contextmind/lib/install-plan.mjs) | `hookEntryFor()` / `dedupeEntriesForHost()`：按 profile 写 flat vs claude-nested |
| [`contextmind/lib/hosts.mjs`](../contextmind/lib/hosts.mjs) | 读 registry；`detectHost` / `hostFromClientInfo` 仅做识别，**禁止**写策略 |

**禁止**：在 pre-handler / post-handler 里根据 Host 拼不同 deny 理由；在 egress 层补 Host 分支即可。

### 2.4 部署布局（所有 Host 共用 `.cursor/` 目录名）

`contextmind install` 把 **库 + hook 脚本 + skills/rules** 装进目标项目的 `.cursor/`：

```
<project>/
  .cursor/
    contextmind/     # 运行时库（各 Host 的 hook 都指向这里）
    hooks/           # cm-*.mjs / cmhook.exe
    mcp.json         # Cursor MCP
    hooks.json       # Cursor hooks
  .qoder/settings.json   # Qoder hooks（nested 形状）
```

目录名 `.cursor` 是 **本层安装约定**，不是「仅 Cursor 可用」。Qoder 的 hook 命令仍执行 `.cursor/hooks/cm-pre-tool.mjs`。

**别动（除非全栈迁移）**

- 不要把 hook 脚本拆成 `qoder/hooks/` 第二套拷贝 — 双份必漂移。
- 不要在 `cli.mjs` 里为单个 Host 硬编码第二套 install 路径；走 `hosts.json` + `mcpConfigFile()` / `hooksConfigFile()`。

### 2.5 明确不碰

| 区域 | 原因 |
|------|------|
| `context-compress-main/`、`bench/` 历史 A/B | 证据仓，非 Host 适配面 |
| `docs/reports/*` 快照 | 门禁证据，改 Host 不必改报告 |
| 消费者仓库 `shejiuPro/.cursor/*` | 由 `contextmind install` 生成；改 Token-Mind 源再 reinstall |

---

## 3. Canonical 契约（跨 Host 统一）

### 3.1 事件名（内部 → 外部）

内部始终用 **小驼峰 canonical**（`install-plan` / `HOOK_ENTRIES`）：

`preToolUse` · `postToolUse` · `sessionStart` · `sessionEnd` · `beforeSubmitPrompt` · `stop`

写入 Host 配置时，经 `hosts.json` → `hookEventName()` 映射，例如 Qoder：

| Canonical | Qoder 配置键 |
|-----------|----------------|
| `preToolUse` | `PreToolUse` |
| `postToolUse` | `PostToolUse` |
| `beforeSubmitPrompt` | `UserPromptSubmit` |

### 3.2 Hook 输出双信封

| 语义 | Cursor（flat） | Qoder / Claude-nested（`hookSpecificOutput`） |
|------|----------------|--------------------------------------------------|
| 允许/拒绝 | `permission` | `permissionDecision` |
| 理由 | `agent_message` / `user_message` | `permissionDecisionReason` |
| 改 tool 输入 | `updated_input` | `updatedInput` |
| 改 tool 输出 | `updated_mcp_tool_output` | `updatedToolOutput` / `updatedMCPToolOutput` |
| 会话上下文 | `additional_context`（sessionStart） | `additionalContext` |

实现：`toHostOutput()` + `cmhook.rs` 的 `sanitize()`。**一次改两处 + 跑测试**。

### 3.3 MCP matcher 差异

| Host | 工具名前缀 | post 输入字段 |
|------|------------|---------------|
| Cursor | `MCP:<tool>` | `tool_output` |
| Qoder | 无 `MCP:` 前缀；regex 见 profile | `tool_response` |

`hosts.json` → `detect.toolPayloadKey` / `detect.mcpToolPrefix`；**matcher 字符串写在 profile**，不要写死在 guard 里。

### 3.4 MCP 配置 scope

| Host | hooks 配置 | MCP 配置 |
|------|------------|----------|
| Cursor | 项目 `.cursor/hooks.json` | 项目 `.cursor/mcp.json` |
| Qoder | 项目 `.qoder/settings.json` | **用户** `~/.qoder-cn/settings.json` |
| CodeBuddy | — | 用户 `~/.codebuddy/mcp.json` |
| WorkBuddy | — | 用户 `~/.workbuddy/connectors/*/mcp.json`（**uid 通配**） |

`contextmind install` 会对 **每个 verified 且具备能力的 Host** 注册 ContextMind MCP + project-brain（stdio）。Qoder 用户级 MCP 是已知差异 — 修 MCP 挂载看 [`contextmind/lib/mcp-repair.mjs`](../contextmind/lib/mcp-repair.mjs)。

**WorkBuddy 两个专属约定（都落在 profile，不落代码分支）**

1. **uid 通配路径** — WorkBuddy 把 connector 配置放在 `connectors/<uid>/`，uid 每装机不同。
   `hosts.json` 里写 `path: ".workbuddy/connectors/*/mcp.json"`，由 `hosts.mjs:resolveConfigFile()`
   展开：优先取 `default`（本层既有注册所在处），其次字典序第一个；无同级目录时回退字面路径，
   保证 `backupOnce` 仍有具体目标。**不要**再写死 `connectors/default/`。
2. **Brain 挂载不再按 host 名判定** — 原先 `mcp-repair.mjs` 用 `profile.id === "cursor"` 决定是否注入
   `project-brain`，已改为读 `profile.mcp.mountBrain`。WorkBuddy 是第一个「用户级 + 要挂 Brain」的 Host，
   正是这行硬编码会漏掉它的场景。
3. **`cwd` 条件化** — `profile.mcp.cwdSupported: false` 时 `brainStdioEntry()` 省略 `cwd` 键。
   Brain 靠 `server.py` 的 `__file__` 自解析 `src` 根，无 `cwd` 也能起（详见 Brain 仓
   [`AGENT-HOST-COMPAT.md`](../../project-brain-agent/docs/AGENT-HOST-COMPAT.md) §3.1）。

> **Hook 治理不适用**：WorkBuddy 的 `capabilities.hooks: false`，`dedupeEntriesForHost()` 对它返回 `[]`。
> 要拿到压缩 / pre-deny，需要先在该 Host 上取得 hook 事件与输出契约的**实机证据**（`~/.workbuddy/settings.json`
> 目前无 hooks 段），再按 §2.1 走数据流程。**不要**在拿到证据前填 `hooks` 段。

### 3.5 识别与 telemetry

- Hook 行：`detectHost(input)` — 用 payload 字段 / 事件大小写 / transcript 路径打分。
- MCP 连接：`hostFromClientInfo(initialize.clientInfo.name)` — 查 `mcpClientInfo`。
- 子 Agent：`detectAgent(input)` — transcript 的 `subagents/` 路径等。

Ledger 列：`host` + `agent`。新 Host 只扩展 `hosts.json` 的 `detect`，勿在 telemetry 写死 Host 名列表。

---

## 4. 新 Host 接入清单

1. **实机摸底** — 记录：hooks 文件路径、JSON 形状、事件名、是否 async、tool 名字符串、MCP 文件与 scope、post 载荷字段名、`clientInfo.name`。
2. **编辑 `hosts.json`** — 新建 profile，`verified: false`，填 `unverifiedReason`。
3. **对照契约** — 若走 Claude-nested：读 Qoder profile + [`contextmind/tests/hooks.test.mjs`](../contextmind/tests/hooks.test.mjs) 里 Qoder 用例。
4. **Egress** — 若 Host 读第三套字段名：扩展 `toHostOutput()` / `cmhook.rs`（保持 Cursor+Qoder 不退化）。
5. **测试** — `node --test contextmind/tests/hooks.test.mjs`；nested Host 加 deny/post 改写用例。
6. **Install 实机** — `contextmind install <dir>` → 在该 Host 内触发 preToolUse deny / postToolUse 压缩，确认生效。
7. **Doctor** — `contextmind doctor <dir>` 全 PASS/WARN 可接受项有文档。
8. **置 verified** — 仅实机通过后 `"verified": true`，删除 `unverifiedReason`。

**Codex / Trae 模板**：profile 已在 `hosts.json` 占位；缺的是 **可 cite 的配置路径**，不是代码框架。

---

## 5. Agent 改代码时的决策树

```
要改的是治理规则（deny 什么、压缩多少）？
  → pre-handler / post-handler / adapters / policy
  → 不要加 Host 分支

要改的是「装到 Qoder 的配置长什么样」？
  → hosts.json + install-plan.hookEntryFor
  → 不要改 pre-handler

要改的是「hook  stdout  JSON 字段名」？
  → cm-rpc.toHostOutput + native/cmhook.rs + hooks.test.mjs
  → 不要改 install-plan 的策略 matcher

要改的是 MCP 服务器列表 / project-brain 路径？
  → cli.mjs install 段 + mcp-repair.mjs
  → 用 hosts.json 的 mcp.scope/path，不要写死 ~/.cursor 唯一路径

要改的是看板/ledger 按 Host 分栏？
  → hosts.mjs hostDirectory + dashboard
  → 新 Host 自动出现（含 unverified）
```

---

## 6. 验收命令

```bash
node --test "contextmind/tests/*.test.mjs"
node contextmind/cli.mjs doctor <projectDir>
node contextmind/cli.mjs install <projectDir>    # 幂等
native/build-cmhook.cmd && node contextmind/cli.mjs install <projectDir>  # 原生 client
```

Hook 契约证据：[CURSOR_HOOK_CONTRACT.md](./evidence/CURSOR_HOOK_CONTRACT.md)  
集成门禁历史：[INTEGRATION_GATE_CURSOR.md](./reports/INTEGRATION_GATE_CURSOR.md)

---

## 7. 相关仓库

| 仓库 | Host 相关职责 |
|------|----------------|
| **Token-Mind（本仓）** | Host registry、hooks、MCP 治理、install |
| [project-brain-agent](../project-brain-agent/docs/AGENT-HOST-COMPAT.md) | stdio MCP；工具面无 Host 分支（见该仓文档） |
| `A-skill/shared/pipeline-contract.yaml` | 五层栈 Gate + **`agent_hosts`** 机器清单 |
| [`A-skill/shared/docs/AGENT-HOST-CHEATSHEET.zh.md`](../../../shared/docs/AGENT-HOST-CHEATSHEET.zh.md) | 中文一页速查 |

**维护原则**：Host 差异 **数据化**（`hosts.json`）；策略 **一次实现**；输出 **双信封翻译**。这样 Cursor、Qoder 已兼容，第三个 Host 主要是 **验 profile + 测 egress**，而不是复制第六份 install 分叉。
