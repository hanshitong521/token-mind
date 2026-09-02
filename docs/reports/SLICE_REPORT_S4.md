# ContextMind 切片报告：S4（统一六工具 MCP 层）

> 口径：**切片上线 / 产品未完成**。G0–G8 未全部执行，本报告不宣称产品完成。
> 依据：DECISIONS-2026-09-01 决策 5C；ADR-0004；总规范 v1.2 §9/§11/§52。

## 0. 一句话

对 Cursor 暴露的唯一 ContextMind MCP 面 = 六个工具（context_orient / find / get / impact / run / fetch），内部 dispatch 到 CodeGraph CLI（实装探测，缺则状态语义降级）与 CC 引擎（Output Gate 管线），全部进三列账 telemetry；schema 实测 **669 tokens / 2500 上限**。

## 1. 交付物

| 类别 | 路径 | 说明 |
|---|---|---|
| MCP server | `contextmind/mcp-server.mjs` | 手写 stdio JSON-RPC（initialize/notifications/ping/tools/list/tools/call），长驻进程，零 npm 依赖 |
| 六工具实现 | `contextmind/lib/mcp-tools.mjs` | schema + dispatch + 降级语义 + telemetry 记账 |
| lib 扩展 | `lib/output-gate.mjs` budgetFor | 新增 orient/find/impact 三个预算 surface（加法，不影响既有调用方） |
| 配置 | `lib/config.mjs` | `adapters.codegraph.bin`（默认 "codegraph"，可覆盖） |
| 安装 | `cli.mjs` | install 注册 mcp.json `contextmind` 条目（备份 `.contextmind-mcp-backup`，不动用户其他 server）；uninstall 只删自己的键；doctor 新增 "mcp server (six tools)" 检查并报告残留上游 schema 税 |
| 测试 | `tests/mcp.test.mjs` | 14 用例：schema 预算 / 降级语义 / context_get 打包与逃生舱拒绝 / run 失败证据保留 / fetch 逐字节回取与选择器 / L4 真子进程协议链 |
| 决策 | `docs/decisions/ADR-0004-mcp-layer-in-contextmind.md` | 落点偏离（contextmind 而非 CC src/mcp）的理由与后果 |

零新增运行时依赖。CC（context-compress-main）**零改动**——旧 8 工具不对 Agent 暴露通过 mcp.json 不注册达成。

## 2. 实测结果

| 项 | 结果 |
|---|---|
| schema 预算 | `tools/list` payload = **669 tok**（cap 2500，占 27%） |
| context_orient（shejiuPro 真机，TBuyinOrderServiceImpl） | raw 6250 tok → **482 tok（-92.3%）**，budget 800，handle=h_n94z33n3，method=cc_balanced+structural，延迟 2139ms |
| context_find（真机，OrderServiceImpl） | 436 tok，file:line 命中 TBuyinOrderServiceImpl |
| context_impact（真机，isoDateOnly） | 192 tok：impact + callers/callees 合并 |
| context_run（echo/失败注入） | exit_code 透出，stderr 证据保留，telemetry 入账 |
| context_fetch | handle 逐字节一致；line selector 正确；未知 handle = isError |
| 降级（无 codegraph） | orient/find/impact 全部返回 `status=ADAPTER_MISSING`（≤120 tok，含下一步指引），无假成功 |
| install/uninstall | 两次 install 幂等（单键覆盖）；uninstall 后 mcp.json 只剩其他 server |
| 全量回归 | `node --test` 4 文件 **93/93 pass**（原 79 + 新 14） |

## 3. 关键实现决策（详见 ADR-0004）

1. **手写 JSON-RPC 而非 MCP SDK**：承诺面只有 5 个方法，SDK+zod 是零依赖层的第一个 npm 依赖。
2. **CodeGraph 走本机 CLI（v1.5.0）而非 MCP client**：explore/query/impact/callers/callees 全在 CLI；实装探测用 **PATH 手动解析**（locale 无关——Windows shell:true 下"命令不存在"与"运行失败"都是 exit 1 + 本地化 stderr，无法区分）。
3. **budgetFor 加法扩展**：orient/find/impact 映射到既有 config 预算键。
4. **install 不卸用户其他 MCP**：卸不卸 headroom/ads-mysql 是 owner 的决定；doctor 报告残留 schema 税（spec §5.5 过渡期语义）。

## 4. 边界（本切片明确不做）

- shejiuPro 生产 mcp.json 的实际接入（需 owner 决定何时执行 `contextmind install` + 是否卸上游）。
- S5 canonical facts（context_get 的 facts 候选源）、S6 CodeGraph adapter 的 MCP 形态（当前即 CLI 形态）。
- S8 三列账 report CLI 扩展（telemetry 表已随本切片记 surface="mcp" 事件）。
- G0–G8 产品完成宣称。

## 5. 已知局限 / 风险

1. **协议兼容性以契约测试为准**：与 Cursor 实机的 `updated_mcp_tool_output`/动态工具发现交互未在实机验证（与 S2/S3 的同款局限）；安装后需在 Cursor 实机做一次探活。
2. **codegraph explore 延迟 2-3s**（真机含索引查询+gate 压缩）；属 adapter 延迟，telemetry 单列 `gate_latency_ms`，不伪装。
3. **context_get v1 无 facts/图候选**：只有 anchors + git changed files 打包；S5/S6 接入后补。

## 6. 回滚

```bash
node contextmind/cli.mjs uninstall <project>   # mcp.json 只删 contextmind 键
```

安装前 mcp.json 备份在 `.cursor/mcp.json.contextmind-mcp-backup`。

## 7. 下一步（决策 2C 顺序）

S8（data+CLI）：三列账 report CLI 已有雏形（`contextmind report`），待做=三列账在会员窗的真实数据回填 + evidence。随后按门槛评估 S5/S6。
