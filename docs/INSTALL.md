# ContextMind 安装手册

面向「在一台新机器上把 ContextMind 装到某个 Coding Agent 里」的操作手册。
每个 Host 的**实测契约**与**踩过的坑**都写在下面 —— 照着做能少走弯路，
尤其是 WorkBuddy 那一节，它的配置位置和常规直觉不一样。

> 想新增一个 Host（Trae / Codex / 别的 IDE）？看 [ADD-A-HOST.md](ADD-A-HOST.md)，
> 那是给 agent 看的适配 playbook。

---

## 0. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node | **≥ 22.5** | telemetry 用内置 `node:sqlite`，低于 22.5 起不来 |
| Python | **3.11**（仅 Brain 需要） | 3.14 建 venv 会缺 wheel，别用 |
| 平台 | Windows / macOS / Linux | Windows 下 hook 经 **Git Bash** 派生，见 §3 |

装完自检：

```bash
node -v          # 必须 >= 22.5
node contextmind/cli.mjs doctor <projectDir>
```

---

## 1. 安装（通用流程）

```bash
cd <token-mind 仓库根>

node contextmind/cli.mjs install <projectDir>     # 幂等；写 hook + MCP，先备份
node contextmind/cli.mjs mcp repair <projectDir>  # 补挂 project-brain（可选）
node contextmind/cli.mjs doctor <projectDir>      # PASS/WARN/FAIL 逐项体检
```

`install` 会做三件事：

1. 把 hook 脚本复制到 `<projectDir>/.cursor/hooks/`（脚本目录对所有 Host 通用）
2. 按**每个已验证且具备 hook 能力**的 Host，把 hook 条目写进**该 Host 自己的配置文件**
3. 写 ContextMind 的 MCP 条目

`--hosts=a,b` 可以只装指定 Host；不加则自动选择「verified 且配置目录已存在」的 Host。

### 卸载

```bash
node contextmind/cli.mjs uninstall <projectDir>   # 只删自己写的条目，用户手写的不动
```

---

## 2. 各 Host 的配置落点

**这是最容易装错的地方** —— 装到 Host 不读的文件里，表现为「装好了但毫无效果」。

| Host | Hook 配置位置 | MCP 配置位置 | 作用域 |
|---|---|---|---|
| **Cursor** | 项目 `.cursor/hooks.json` | 项目 `.cursor/mcp.json` | 项目 |
| **Qoder** | 项目 `.qoder/settings.json` | 用户 `~/.qoder-cn/settings.json` | 混合 |
| **WorkBuddy** | 用户 `~/.workbuddy-ai/settings.json` 的 `hooks` 键 | 用户 `~/.workbuddy-ai/mcp.json` | 用户 |
| **CodeBuddy** | —（无 hook 治理） | 用户 `~/.codebuddy/mcp.json` | 用户 |
| **Trae** | 项目 `.trae/hooks.json` | 用户 `AppData/Roaming/Trae CN/User/mcp.json` | 混合 |

以上路径是 `hosts.json` 里的 SSOT，代码不写死 Host 名 —— 要改就改数据。

---

## 3. WorkBuddy 专项（重点，和其他 Host 都不一样）

### 3.1 两个目录名不要搞混

```
~/.workbuddy-ai/     ← WorkBuddy 读这个
~/.workbuddy/        ← 另一个产品的目录，不是它
~/.codebuddy/        ← CodeBuddy 的目录，也不是它
```

**Hook 位置**：`~/.workbuddy-ai/settings.json` 里的 **`hooks` 键**（Claude Code 嵌套形状）。
不是独立的 `hooks.json`，不是插件里的 `hooks/hooks.json` —— 那两个位置**都不触发**。

**MCP 位置**：`~/.workbuddy-ai/mcp.json`（`mcpServers` 键）。
不是 `~/.workbuddy/connectors/<uid>/mcp.json`（那是旧记录，指向另一个产品目录）。

### 3.2 三条硬约束

**① hook 命令必须是单个字符串，不能有 `args` 数组**

```jsonc
// ✅ 能跑
{ "type": "command", "command": "cmd.exe //d //c \"C:\\path\\cm-pre-tool.cmd\"", "timeout": 5 }

// ❌ 静默不执行 —— args 被忽略，只剩裸 cmd.exe
{ "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "..."] }
```

**② 必须写 `//d //c`，不能写 `/d /c`**

WorkBuddy 在 **Git Bash** 里派生 hook，MSYS 会把 `/d` 当路径转换成盘符，
整条命令直接失效。`//d //c` 是绕开转换的写法。
（`hosts.json` 里靠 `leafCommandString: 'cmd.exe //d //c "{script}"'` 表达。）

**③ 事件名是 PascalCase**

`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop`。
写成小写 `preToolUse` 不会被识别。

### 3.3 生效方式：热加载

改完 `settings.json`，**下一次工具调用就生效**，不需要重启会话。
（对比：MCP 配置需要重开会话，见 §4。）

### 3.4 实测能力边界

| 能力 | 状态 | 说明 |
|---|---|---|
| PreToolUse 拦截 | ✅ | `permissionDecision: "deny"` 能拦下 Bash 和 Read |
| PostToolUse 改写输出 | ✅ 仅 Read | `updatedToolOutput` 生效，Read 正文被整体替换 |
| **Shell 输出压缩** | ❌ | Bash 的 `tool_response` **只有元信息**（`exitCode`/`signal`/截断字节数），**没有 stdout 正文** —— 无原文可压缩 |
| tool_name 拼写 | — | CLI 风格（`Bash`/`Read`/`Write`），不是 `execute_command` |

最后一条是**真限制**，不是配置问题：`report` 里 Bash 那行 raw 为 0 就是它导致的。
Read 侧的 Read Guard 与输出压缩不受影响。

---

## 4. 验证安装

```bash
node contextmind/cli.mjs doctor <projectDir>
```

要看到的关键行：

```
PASS  hooks installed (workbuddy)  6 entries -> C:\Users\<you>\.workbuddy-ai\settings.json
PASS  hook scripts present         7 files
PASS  tokenmind runtime            http://127.0.0.1:<port>/health
```

**MCP 需要重开会话才加载** —— hook 是热加载的，MCP 不是。重开后在工具列表里应该看到：

- `contextmind` 的 7 个工具（`context_orient` / `context_find` / `context_get` / `context_impact` / `context_run` / `context_fetch` / `context_outline`）
- `project-brain` 的 5 个工具（`search_project_context` / `get_change_context` / `save_architecture_decision` / `save_bug_memory` / `record_task_outcome`）

确认 hook 真的在跑（而不是「装上了但没动」）：

```bash
node contextmind/cli.mjs report
```

看 `By tool` 表里有没有你刚用过的工具名；事件数会随使用增长。

---

## 5. 避坑清单

| 症状 | 原因 | 处理 |
|---|---|---|
| 装完毫无效果 | 配置写到了 Host 不读的位置 | 对照 §2 的路径表；WorkBuddy 看 §3.1 |
| hook 完全不触发（WorkBuddy） | 用了 `args` 数组，或写了 `/d /c` | 改成单字符串 + `//d //c` |
| hook 不触发（WorkBuddy） | 事件名写成了小写 | 用 `PreToolUse` 这种 PascalCase |
| hook 不触发（任何 Host） | 脚本路径含空格未加引号 | 命令里的路径要引号包裹 |
| Shell 压缩省不下来（WorkBuddy） | 该 Host 的 Bash 响应不含 stdout | 预期行为，见 §3.4；改用 Read 侧治理 |
| MCP 工具列表里没有 | 没重开会话 | 重开；MCP 不热加载 |
| `doctor` 报 runtime not listening | 守护进程没起 | `node contextmind/cli.mjs start` |
| runtime 端口不是 18787 | 18787 被 Brain 看板占了 | 正常，会自动退避到临时端口；doctor 会显示实际端口 |
| `mcp server (seven tools) not installed` | doctor 检查的是项目级 MCP，用户级 Host 不适用 | 用户级 Host（WorkBuddy/CodeBuddy）忽略此行 |
| `No module named 'brain_services'` | 缺 PYTHONPATH | Brain 的 stdio 条目必须带 `PYTHONPATH=<brain>/src` |

---

## 6. 端口约定

| 服务 | 端口 | 说明 |
|---|---|---|
| Brain API / 看板 | **18787** | `BRAIN_API_PORT` 默认值 |
| TokenMind runtime | 首选 18787，**被占则退避**到系统分配的临时端口 | 与 Brain 看板共存时的正常现象 |

两者共用 18787 是已知设计（见 `lib/runtime/daemon.mjs` 注释）。runtime 被挤走后，
`doctor` 会显示它**实际**监听的端口并附注 `preferred 18787 is held by another listener` ——
**不要**把那个附注当成故障。

> 排查提示：如果 `doctor` 显示 runtime PASS 但你怀疑是假绿，去 `report` 或
> `~/.contextmind/` 下的 pid 文件核对端口，别只看 doctor 那一行。
