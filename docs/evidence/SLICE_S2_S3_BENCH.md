# Evidence: S2+S3 slice measurement (Output Gate + hooks)

- 采集时间: 2026-09-01
- tokenizer: `heuristic:chars/4`（与 Token-Mind 全部既有 bench 同口径，保证可比）
- 复现:
  - `node contextmind/cli.mjs benchmark`
  - `node bench/hook_latency.mjs 15`
  - `node --test "contextmind/tests/*.test.mjs"`
- 环境: Windows 10.19045 / Node v24.15.0 / context-compress dist 2026.8.1

## 1. Output Gate 实测（bench/fixtures，真实 CLI 管线）

| fixture | type | raw tok | emitted tok | reduction | method | abstained |
|---|---|---:|---:|---:|---|---|
| big_log.log | test_log | 89,553 | 513 | 99.4% | cc_balanced+structural | no |
| build_success.log | test_log | 14,776 | 69 | 99.5% | cc_balanced | no |
| java_stacktrace.log | test_log | 630 | 630 | 0.0% | passthrough | no |
| jest_fail.log | test_log | 1,308 | 1,308 | 0.0% | passthrough | no |
| pytest_fail.log | test_log | 2,632 | 126 | 95.2% | cc_balanced | no |
| **TOTAL** | | **108,899** | **2,646** | **97.6%** | | |

读法（对齐 spec §36.3，不许只报好看的数字）：

- 两个 0% 是**正确行为**，不是失效：`java_stacktrace` 630 tok 低于失败预算 1600，`jest_fail` 1,308 tok 同样在失败预算内。失败路径宁多花 token 保真（spec P5/P12）。
- `pytest_fail` 的保真抽查（真实命令输出）：

```text
[tool_report pytest] 1 failed, 127 passed in 3.42s
{"failed":1,"passed":127,...,"failures":[{"id":"tests/test_order_service.py::test_discount_rule",
  "error":"AssertionError: assert 20 == 30","loc":"tests/test_order_service.py:42",...}]}
[contextmind] 2632 -> 103 tok type=test_log method=cc_balanced budget=1600 handle=h_ksbx0v0g
```

  测试名 / 断言期望实值 / file:line / 计数全部保留；`handle` 取回原文**逐字节一致**（`raw recovered: true`）。

## 2. 本轮开发中发现并修复的两个真实缺陷

1. **保真校验按"逐字包含"判定** → 结构化 pytest 报告（事实俱在、格式不同）被误判为证据丢失，触发 ABSTAIN，实测 `-1.5%`（越压越大）。修复：改为按**标识符事实**判定（测试 id、file:line、异常名、计数/时长），`output-gate.mjs salientTokens/lineCovered`。修复后 95.2%、零 ABSTAIN。
2. **ABSTAIN 会追加 footer 使 payload 变大**。修复：仅当不使 payload 超过原文时才附 footer，出处记入 telemetry（`output-gate.mjs`）。
3. **hook 热路径上的 `rt.close()`**：同步关闭两个 WAL 连接实测 119ms，超过 hook 其余全部成本之和。INSERT 均为自动提交，进程退出即落盘；已从热路径移除（`runtime.mjs` 留有完整注释），work 119→44ms。

## 3. Hook 延迟归因（G4）

| 测量对象 | min | p50 | max |
|---|---:|---:|---:|
| 裸 node 启动下限 | 165ms | 172ms | 191ms |
| 仅导入 cm-lib（13 个模块） | 195ms | 205ms | 250ms |
| 完整 hook `cm-pre-tool`（Shell，wrap 路径） | 251ms | 269ms | 347ms |
| 对照：现网 `gate-pre-tool.mjs` | 176ms | 185ms | 193ms |
| 对照：现网 `.cmd` 包装 | 165ms | 176ms | 193ms |

分阶段（`CONTEXTMIND_TIMING=1`）：locate 0.9ms / lib 23ms / runtime(SQLite open) 6ms / work 44ms。

- **结论（诚实版）**：本切片 hook p50 ≈ 269ms，比现网旧 hook 慢约 84ms；其中 Node 进程启动占 172ms（64%）。G4 的"本地静态决策 p95 ≤ 25ms"在无 daemon/cmhook 的前提下**不可达**——这正是 owner 决策 6 明确 SKIP 的部分。按 spec G4"若真实基线证明某阈值物理不合理，可调整但必须给原始数据"，此处记为 **KNOWN_LIMITATION**：不判 PASS，也不静默放水。若该延迟被证明不可接受，重启 T11（cmhook/daemon），而不是继续调 Node。

## 4. 测试基线

- 本切片新增：**77 tests, 77 pass, 0 fail**
  - `lib.test.mjs` 47（L1）
  - `hooks.test.mjs` 19（L4 契约，真实子进程）
  - `cli.test.mjs` 11（G7 安装/卸载幂等）
- 上游 context-compress 存量：**614 tests / 572 pass / 30 fail**（接管时即如此，Windows 可移植性问题，非本切片引入，本轮未修）。

## 5. 未确认项

- `updated_mcp_tool_output` 形态需在 Cursor 实机确认（见 CURSOR_HOOK_CONTRACT.md §3）。
- Read Guard 的 `prevented_read_tokens` 用 `bytes/4` 估计被拦截的整读；未读入文件内容，故为估计值而非精确值（口径已写入 tokenizer 字段）。
