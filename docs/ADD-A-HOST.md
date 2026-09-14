# 适配一个新 Host（给 agent 看的 playbook）

这份文档写给**下一个要适配新 Coding Agent（Trae / Codex / 新 IDE / 新版本）的 agent**。

核心原则只有一条：

> **先拿到实机证据，再改配置。**
> 一个猜出来的路径会让 `install` 把治理写到没人读的地方 —— 装上了、不报错、什么都不做。
> 这比「装不上」更糟，因为它看起来是好的。

`hosts.json` 是 Host 注册表 SSOT：**加 Host 是改数据，不是改代码**。
如果发现自己要写 `if (host === "xxx")`，说明数据模型缺字段，应该补字段。

---

## 反例先行：WorkBuddy 的翻案过程

值得先读，因为它展示了「调研失败」长什么样。

**第一次调研（2026-09-13）结论**：WorkBuddy 有 hook 引擎，但通道被关
（`CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS=1`），所以 `capabilities.hooks: false`。

**第二次实测（2026-09-14）推翻它**：真实入口是 `~/.workbuddy-ai/settings.json` 的 `hooks` 键，
hook 完全可用，而且**热加载**。

第一次错在哪？探针放在三个位置 —— `.codebuddy/hooks.json`、`.workbuddy/hooks.json`、
插件级 `hooks/hooks.json` —— **一个都不是 Host 真正读的位置**。

**教训**：探针没触发 ≠ 能力不存在。在把「不支持」写进注册表之前，先证明你放对了地方。
「三个位置都没反应」只说明那三个位置不对，不说明 Host 不支持。

---

## Step 1 — 找到配置落点（不要猜）

先确定这个 Host 的用户目录叫什么。**名字往往不是产品名**：

```bash
ls -d ~/.<product>* ~/.<vendor>* 2>/dev/null
# 例：WorkBuddy → ~/.workbuddy-ai/（不是 ~/.workbuddy/，那是另一个产品）
```

再确认哪个文件是**真的被读**的 —— 看日志，别靠文件名推测：

```bash
# 在 Host 的日志里找配置文件路径
grep -roh "[A-Za-z]:[\\\\/][^\"' ]*\(mcp\.json\|settings\.json\)" ~/.<host>/logs/ | sort -u
```

WorkBuddy 的日志里出现 `McpConfigManager.list:` 直接带出 `~/.workbuddy-ai/mcp.json` —— 这就是证据。

**MCP 与 hook 的位置经常不同**，要分别确认：

| 类型 | 常见落点 |
|---|---|
| MCP | `~/.<host>/mcp.json` 或 `<project>/.<host>/mcp.json`，`mcpServers` 键 |
| Hook | `<project>/.<host>/hooks.json`，或 **用户 settings 文件里的 `hooks` 键** |

---

## Step 2 — 探测 hook 是否真的派发

写一个**只写日志、永远 exit 0、不输出 stdout** 的探针，放到候选位置，然后触发一次工具调用：

```js
// hook-probe.mjs —— 只记录，绝不阻塞
import { readFileSync, appendFileSync } from "node:fs";
let raw = ""; try { raw = readFileSync(0, "utf8"); } catch {}
const p = (() => { try { return JSON.parse(raw); } catch { return null; } })();
appendFileSync("hook-probe.log", JSON.stringify({
  event: p?.hook_event_name, tool_name: p?.tool_name,
  keys: p ? Object.keys(p) : [], rawLen: raw.length,
}) + "\n");
process.exit(0);
```

配置里先用**最宽松的匹配**（空 matcher / `*`），确认能触发后再收紧。

**一次只改一个变量。** 同时换位置 + 换命令形状，触发了也不知道是哪个起了作用。

---

## Step 3 — 探测命令形状（最容易翻车的一步）

逐项确认，**每项单独测**：

| 要确认 | 怎么测 | 反例 |
|---|---|---|
| 命令是字符串还是 `command`+`args` | 各配一次，看日志有没有生成 | WorkBuddy 只认单字符串，`args` 被忽略 |
| 是否经 shell 派生（Git Bash / sh / cmd） | 用 `cmd.exe /d /c` 试；不触发就换 `//d //c` | Git Bash 的 MSYS 会把 `/d` 转成盘符 |
| 路径分隔符 | 反斜杠 vs 正斜杠各试一次 | — |
| 事件名大小写 | `PreToolUse` vs `preToolUse` | WorkBuddy 要 PascalCase |
| 环境变量注入 | 看 `env` 字段是否传到脚本 | — |

> 判定标准：**探针日志文件出现了**才算通过。配置文件写进去了不算。

---

## Step 4 — 探测输入 / 输出契约

**输入**（stdin JSON）要记录：事件名、`tool_name` 的**拼写风格**、工具载荷的键名。

`tool_name` 拼写很关键：同一产品不同入口可能不同（IDE 用 `execute_command`，CLI 用 `Bash`）。
**matcher 必须按实际收到的拼写写**，否则一条 hook 都不会匹配。

**输出**要分别验证三件事：

| 能力 | 探针返回 | 判定 |
|---|---|---|
| 拦截 | `hookSpecificOutput.permissionDecision = "deny"` | 工具调用被挡下 → 支持 |
| 改写结果 | `hookSpecificOutput.updatedToolOutput` | 看到替换后的内容 → 支持 |
| 注入上下文 | `hookSpecificOutput.additionalContext` | 内容进入下一轮 → 支持 |

**注意载荷内容本身**：WorkBuddy 的 Bash `tool_response` 只有元信息（`exitCode`/`signal`/截断字节数），
**没有 stdout** —— 这直接决定了 Shell 输出压缩在该 Host 上**不可用**。
这类边界必须记进注册表，否则后续会有人反复怀疑配置写错了。

---

## Step 5 — 写进 `hosts.json`

一个 profile 需要填：

```jsonc
{
  "id": "newhost",
  "label": "NewHost",
  "verified": true,                       // 只有实机核对过才置 true
  "capabilities": { "hooks": true, "mcp": true, "failClosed": false, "outputRewrite": false },
  "detect": {
    "transcriptPaths": ["\\\\.newhost"],   // 用于 telemetry 认领事件
    "toolPayloadKey": "tool_response",     // 该 Host 放工具结果的键名
    "eventCase": null,                     // "upper" / "lower" / null
    "mcpToolPrefix": "mcp__"
  },
  "hooks": {
    "file": { "scope": "user", "path": ".newhost/settings.json",
              "keyPath": "hooks", "entryShape": "claude-nested",
              "leafCommandString": "cmd.exe //d //c \"{script}\"" },   // 需要时
    "eventNames": { "preToolUse": "PreToolUse", "postToolUse": "PostToolUse" },
    "asyncEvents": [],                     // 只记录、不做决策的事件才放这里
    "matcherEvents": ["PreToolUse", "PostToolUse"],
    "toolMatcher": "^(Bash|Read|Write|...)$",
    "env": { "CONTEXTMIND_HOST": "newhost" }
  },
  "mcp": { "scope": "user", "path": ".newhost/mcp.json", "keyPath": "mcpServers",
           "entryShape": "stdio", "mountBrain": true, "cwdSupported": false },
  "notes": "把实测结论、已知边界、探测日期写在这里 —— 下一个 agent 靠它少走弯路。"
}
```

几条经验：

- `verified: false` 的 profile 会被 `doctor` 列出但 `install` **拒绝写配置**（防猜路径）。实机核对后再置 `true`。
- `mountBrain` / `cwdSupported` 是 **Host 条件字段**，不要写死在某些代码分支里。
- `notes` 一定要写：**结论 + 日期 + 已知边界**。「不支持」必须写成「有证据的不支持」。

---

## Step 6 — 加测试，跑起来

1. 在 `contextmind/tests/install-plan.test.mjs` 加一个 `describe("<host> (verified contract)")`，
   断言**生成的条目形状**（事件名、命令字符串、matcher、env），而不只是断言 profile 字段。
2. 跑测试：**串行**跑，并行会有 flaky。

   ```bash
   node --test --test-concurrency=1 "contextmind/tests/*.test.mjs"
   ```

3. 端到端：`install` → 触发工具 → `report` 看有没有记录到该 Host 的事件。

---

## 陷阱清单

| 陷阱 | 后果 | 规避 |
|---|---|---|
| 把「探针没触发」当成「不支持」 | 注册表里留下错误结论，后人被误导 | 先证明探针放对了位置 |
| 同时改多个变量 | 无法归因 | 一次一个变量 |
| 用猜的路径填 `verified: true` | 治理写到没人读的地方 | 看 Host 日志确认真实路径 |
| 忘了 `args` 可能被忽略 | hook 静默不执行 | 单字符串 / `args` 两种都测 |
| 忘了 shell 派生会改参数 | 命令整条失效 | `//d //c` 这类绕法 |
| 假设所有 Host 的 `tool_name` 拼写一样 | matcher 全不匹配 | 打印实际收到的 `tool_name` |
| 没记录载荷边界（如 Bash 无 stdout） | 后人反复怀疑配置 | 写进 `notes` |
| 并行跑测试 | flaky，误判回归 | `--test-concurrency=1` |
| 提交前没跑全量测试 | 破坏既有 Host | 跑全量，对比基线失败数 |

---

## 检查清单（提交前过一遍）

- [ ] `hosts.json` 的 `notes` 写了结论 + 日期 + 已知边界
- [ ] `verified: true` 有实机证据支撑（日志/探针输出）
- [ ] 契约测试断言的是**生成条目**，不是 profile 字段
- [ ] 全量测试串行跑过，失败数与基线一致
- [ ] `install` + `doctor` 在该 Host 上 PASS
- [ ] `report` 里能看到该 Host 的事件
- [ ] 文档（`AGENT-HOST-COMPAT.md` / `INSTALL.md`）同步更新
- [ ] 没有在代码里留下 `if (host === "xxx")`
