# ContextMind 切片报告：S8（三列账 Report，data + CLI）

> 口径：**切片上线 / 产品未完成**。G0–G8 未全部执行，本报告不宣称产品完成。
> 依据：S8 冻结指令（owner 2026-09-02）；总规范 v1.2 §24；决策 2C（Dashboard UI SKIP）。

## 0. 一句话

`contextmind report` 现在输出可复核的三列账本：**RAW / EMITTED / AVOIDED（=raw−emitted）**，`reduction_ratio` 仅派生，`prevented_read_tokens` 独立列绝不混账；全维度聚合（session/task/tool/adapter/content_type/success-failure）；12 条账务不变量（G-S8-01..12）全部机器验证；真机 shejiuPro 账本 7,327→1,585 tok（78.37%）。

## 1. 交付物

| 类别 | 路径 | 说明 |
|---|---|---|
| 账本聚合 | `contextmind/lib/telemetry.mjs` | `summary()` 全维度（byTool/bySession/byTask/byAdapter/byContentType/bySuccess）+ `ledger` 一次性派生（文本/JSON 同源，G-S8-09）；`record()` 硬约束：prevented_read 事件 savings 强制 0（G-S8-05） |
| 文本报告 | 同上 `formatSummary()` | S8 冻结格式：RAW/EMITTED/AVOIDED/REDUCTION + PREVENTED READ 独立行 + handles/dedup 计数 + By tool（含 ratio）+ By success/failure + By adapter |
| CLI | `contextmind/cli.mjs` | `report [--since 24h|7d|ISO] [--session ID] [--json]` 四形态，无新子命令 |
| 记账修正 | `lib/mcp-tools.mjs` + `cli.mjs` fetch | fetch 事件 raw=emitted=实际取出量（G-S8-06：不回写历史、不重复算节省）；context_get 小文件开销不产生负节省（G-S8-01） |
| 测试 | `tests/s8.test.mjs` | 11 用例覆盖 G-S8-01..12 全部不变量 |
| 证据 | `docs/reports/evidence-s8-report.json` | 机器可读真机账本（Final Gate 可重算，不信 Markdown） |

零新增依赖、零存储层变更（沿用既有 node:sqlite events 表）、六工具 schema 未动、S4 代码未重构。

## 2. 实测结果

**全量回归**：`node --test` 5 文件 **104/104 pass**（S2/S3 79 + S4 14 + S8 11）。

**账务不变量（tests/s8.test.mjs）**：

```text
G-S8-01  raw >= emitted >= 0（压缩/装配/fetch/read-block 混合事件逐条验证）  PASS
G-S8-02  avoided = raw - emitted                                            PASS
G-S8-03  总账 = 逐笔相加                                                    PASS
G-S8-04  ratio = avoided/raw；raw=0 → null（无 NaN/Infinity）               PASS
G-S8-05  prevented_read 事件 savings=0，独立列                              PASS
G-S8-06  fetch raw=emitted=取出量；原事件逐字节不变                          PASS
G-S8-07  失败事件进账本（success=0）                                        PASS
G-S8-08  两次 report 事件数不变（只读）                                      PASS
G-S8-09  --json 与文本逐数一致（真实 CLI 子进程对拍）                        PASS
G-S8-10  空 telemetry 输出 0 不崩                                            PASS
G-S8-11  跨 session 聚合 = 分 session 之和                                   PASS
G-S8-12  tool/adapter/content_type/success 分项之和 = 总账                   PASS
```

**真机 shejiuPro 账本**（`contextmind report --since 24h`，8 个真实事件）：

```text
RAW        7,327 tokens
EMITTED    1,585 tokens
AVOIDED    5,742 tokens
REDUCTION  78.37%

PREVENTED READ  1,416 tokens  (separate column; not counted in AVOIDED)
proxy_llm_savings  0  (会员窗预期，非失败)

context_orient   6250 -> 508   avoided 5742   ratio 91.87%
context_find      433 -> 433   avoided    0   (预算内直通，不虚报)
context_run       431 -> 431   avoided    0   (失败输出 431 tok < shell_failure 预算，直通)
context_impact    189 -> 189   avoided    0
context_fetch      24 -> 24    avoided    0   (G-S8-06：fetch 是支出不是节省)
Read (blocked)     0 -> 0      prevented 1416
```

**Failure preservation（真机）**：`context_run` 执行 exit 3 + `Error("ORDER_BOOM_913")` 脚本 → 输出保留 `exit_code=3`、marker、`s8-fail.js:1:36` 栈帧，全部命中。预算内失败输出直通不压缩（431 tok < 1600 预算）——**没有通过裁错误信息制造节省**。

**机器可读证据**：`docs/reports/evidence-s8-report.json`（同一次运行的 --json 输出，与上面文本逐数一致）。

## 3. 记账规则（本切片固化）

1. `avoided = raw - emitted`，仅由实际发生的 payload 压缩产生；预算内直通 = 0。
2. `prevented_read_tokens` 只来自 Read Guard 拦截（离线测量的反事实），永不进 avoided。
3. `context_fetch` 是支出：raw = emitted = 实际取出量，savings = 0，不改写原事件。
4. `reduction_ratio` 纯派生；raw=0 显示 n/a。
5. dedup 命中时上游确实重新执行并实测（gate 先拿 raw 再查指纹），raw-emitted 成立；`dedup_hit=1` 单列可查。
6. proxy_llm_savings 仅 BYOK 面；会员窗恒 0。

## 4. 边界（本切片明确不做）

Dashboard UI（决策 2C SKIP）、新 metrics DB/Prometheus/Grafana/云统计（S8 禁区清单）、六工具 schema 变更、handles 重设计、S9/S10。

## 5. 已知局限 / 风险

1. 真机 prevented_read 目前只有 1 个事件（单次 read-guard live 验证）；日常使用量待生产 install 后积累。
2. byAdapter 的 key 是完整命令串（如 `codegraph explore TBuyinOrderServiceImpl`），可用但粒度偏细；不改（等真实使用数据说话）。
3. Cursor 实机动态工具发现仍是 integration debt（S4 冻结时记录），S8 之后单独补真机 Gate。

## 6. 回滚

S8 只改 report/记账逻辑与两处 fetch 记账，无安装面变更；`git revert` 本切片提交即可，telemetry 数据不受影响。

## 7. 下一步

按 S4 冻结指令：补 Cursor 实机动态工具发现真机 Gate（integration debt 清偿）；随后按门槛评估 S5（canonical facts）/S6（CodeGraph adapter 正式化——当前 CLI 形态已可用）。
