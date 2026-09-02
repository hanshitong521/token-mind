# ContextMind 切片报告：S2 + S3（Output Gate / Shell 单 owner / MCP Guard / 探活）

> 口径：**切片上线 / 产品未完成**。G0–G8 未全部执行，本报告不宣称产品完成。

## 0. 一句话

Cursor 的 Shell、MCP、Read 三条 token 大头路径，现在由 hooks 强制治理：Shell 走锁定的 `cc_balanced` 单 owner，MCP 超预算载荷被替换为"有界结果 + 可逆 handle"，无界大文件读取被拒并给出下一步。全部决策进三列账 SQLite，可对账。

## 1. 交付物

| 类别 | 路径 | 说明 |
|---|---|---|
| 核心库 | `contextmind/lib/*.mjs` | config / tokens / classify / output-gate / handles / dedup / read-guard / shell-guard / mcp-guard / probe / traps / telemetry / runtime / engine / install-plan |
| Hooks | `cursor/hooks/cm-*.mjs` | preToolUse / postToolUse / sessionStart / sessionEnd / stop + `cm-lib.mjs` 定位层 |
| CLI | `contextmind/cli.mjs` | install / uninstall / doctor / status / report / gc / fetch / config / benchmark |
| Cursor 资产 | `cursor/rules/`, `cursor/skills/`, `cursor/agents/` | always rule（≤400 tok）、维护 skill、3 个专职 subagent |
| 测试 | `contextmind/tests/` | 77 用例（L1 / L4 契约 / G7 安装） |
| 证据 | `docs/evidence/` | CURSOR_HOOK_CONTRACT.md, SLICE_S2_S3_BENCH.md |

零新增运行时依赖（telemetry 用 Node 22.5+ 内置 `node:sqlite`）。

## 2. 实测结果（完整数据见 docs/evidence/SLICE_S2_S3_BENCH.md）

- Output Gate 对 bench fixtures：**108,899 → 2,646 tok（97.6%）**；失败路径两条 0% 是预算内放行的正确行为，不是失效。
- `pytest_fail`：2632 → 126 tok（95.2%），测试名/断言/file:line/计数保留，handle 取回原文逐字节一致。
- Hook p50 269ms（Node 启动占 172ms）；比现网旧 hook 慢 84ms → **G4 KNOWN_LIMITATION**。

## 3. 与 spec / 既有决策的偏离（全部有 ADR）

| 偏离 | 理由 | ADR |
|---|---|---|
| 配置 JSON 而非 YAML | §29.6 单一配置源 > §26 示例格式；零新依赖 | ADR-0002 |
| 无 daemon、无 `start`/`stop` | Node 启动占 64% 延迟，daemon 省的不是我们的钱；占位命令=假完成 | ADR-0003 |
| Read Guard 用 stat + 8KB 采样，不读全文件 | 守卫若先读全文件，就付了要省的 token | evidence §5 |
| engine 走 CLI 子进程而非进程内 import | 与 A/B 实测路径完全一致，保证数字可比 | `lib/engine.mjs` |

## 4. 边界（本切片明确不做）

S4 六工具 MCP、S5 canonical facts、S6 CodeGraph adapter、S8 Dashboard UI、Serena、Rust cmhook、shejiuPro Java 业务重构。S4 的前置（schema ≤2500 tok 实测）未开始。

## 5. 已知局限 / 风险

1. **G4 延迟不达标**（269ms vs 25ms 目标）：数据与重议条件见 ADR-0003。
2. **`updated_mcp_tool_output` 形态待实机确认**：实现按"输入什么形态就回什么形态"，需在 Cursor 实机验证一次。
3. **上游 CC 测试存量 30 fail**（Windows 可移植性）：非本切片引入，未修；不计入本切片验收，但列在这里不藏。
4. tokenizer 为 `heuristic:chars/4`：与既有 bench 可比，但不是真 tokenizer；spec §11.1 要求最终 benchmark 固定 tokenizer——若后续换，必须连基线一起重跑，不许混报。

## 6. 回滚

```bash
node contextmind/cli.mjs uninstall <project>   # 只删自己加的，hooks.json 其余条目保留
```

安装前的 `hooks.json` 保留在 `.cursor/hooks.json.contextmind-backup`。
