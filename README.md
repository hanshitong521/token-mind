# Token-Mind

ContextMind 的开发仓：面向 Cursor / Qoder 等 Coding Agent 的上下文治理与 token 优化基础设施。

> **多 IDE 兼容**：已适配 Cursor、Qoder、WorkBuddy（hooks+MCP）；CodeBuddy（MCP only）。
> WorkBuddy 的 hook 入口是用户级 `~/.workbuddy-ai/settings.json` 的 `hooks` 键，且 hook 经 Git Bash
> 派生（`cmd.exe //d //c`），详见 [docs/AGENT-HOST-COMPAT.md](docs/AGENT-HOST-COMPAT.md) §3.4。
>
> **在新机器上安装** → [docs/INSTALL.md](docs/INSTALL.md)（含各 Host 配置落点、避坑清单、故障排查）。
> **要适配新的 Coding Agent** → [docs/ADD-A-HOST.md](docs/ADD-A-HOST.md)（给 agent 看的 playbook）。

> 当前状态：**S2+S3 切片上线，产品未完成**（spec G0–G8 未全部执行）。见
> [docs/reports/SLICE_REPORT_S2_S3.md](docs/reports/SLICE_REPORT_S2_S3.md)。

## ContextMind 治理层（`contextmind/` + `cursor/`）

Shell / MCP / Read 三条 token 大头路径由 Cursor hooks 强制治理：

- **Shell 单 owner**：锁定 `cc_balanced`（A/B 实测后锁定，见
  [docs/evidence/SHELL_FIRST_LAYER_AB.md](docs/evidence/SHELL_FIRST_LAYER_AB.md)）；RTK 无代码路径。
- **Output Gate**：分类 → 去重 → handle 化 → 首层压缩 → 结构化裁剪 → 保真校验 → 不足即 ABSTAIN 回原文。
- **Read Guard**：`*ServiceImpl.java` >80 行无 range 拒读；`*Mapper.xml` 禁整读；生成物/锁文件拒读；`override_reason` 可豁免且留痕。
- **MCP Output Guard**：超预算载荷替换为有界结果 + handle（matcher 必须是 `MCP:<tool>`）。
- **三列账**：`prevented_read_tokens` / `tool_emitted_savings` / `proxy_llm_savings`（会员窗第三列为 0 是预期）。

零新增运行时依赖（telemetry 用 Node 22.5+ 内置 `node:sqlite`）。

### 安装到 Cursor 项目

```bash
node contextmind/cli.mjs install <projectDir>   # 幂等；hooks.json 先备份
node contextmind/cli.mjs doctor   <projectDir>   # PASS/WARN/FAIL 逐项体检
node contextmind/cli.mjs report                   # 三列账
node contextmind/cli.mjs fetch <handle> --lines 1-80
node contextmind/cli.mjs uninstall <projectDir>   # 只删自己加的
```

### 测试

```bash
node --test "contextmind/tests/*.test.mjs"   # 77 用例
node contextmind/cli.mjs benchmark            # Output Gate 实测
node bench/hook_latency.mjs 15                # hook 延迟归因
```

## 工具级 A/B 实测（历史基线）

对 RTK 0.46、context-compress 2026.8.1、Save-The-Token 0.1 做工具级 A/B，回答三个问题：是否真省 token、省多少、会不会影响准确。

| 层 | 工具 | 实测节省 | 关键信息保真 | 判定 |
|---|---|---:|---|---|
| Tool Output | context-compress (balanced) | 94.6% | 错误证据完整保留 | PASS（推荐默认） |
| Tool Output | RTK | 98.9% | `err/test` 保真；`log` 用于错误日志会丢证据 | PASS（有条件） |
| Instructions/MCP | Save-The-Token | 65% | 零事实丢失 | PASS（推荐启用） |

**推荐组合：CC balanced + Save-The-Token**（两层互补，无需 Agent 改变行为）。

```bash
python bench/run_bench.py     # 工具输出压缩 A/B，产出 bench/report.md
python bench/self_bench.py    # Agent 会话输出回放实测
```

详细数据与裁决：[bench/FINAL_REPORT.md](bench/FINAL_REPORT.md)
