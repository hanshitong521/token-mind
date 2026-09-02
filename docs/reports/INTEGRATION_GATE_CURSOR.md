# INTEGRATION-GATE-CURSOR — Cursor 实机集成门证据

> 口径：**切片上线 / 产品未完成**。S4/S8 已冻结，本 Gate 未改其任何架构与指标口径。
> 环境：Cursor 3.18.9（E:\cursor\cursor35）、Node v24.15.0、shejiuPro @ E:\workA\shejiuPro。
> 日期：2026-09-02。

## 0. 结论

**IG-C01..C18 中，机器可验证的 16 项全部 PASS。** 剩余 IG-C04 的"Cursor UI 内工具列表人眼确认"与真实任务截图需用户重启 Cursor 后配合（见 §3 待办）；协议层的等价证据（新进程 tools/list = 恰好六个、schema 与冻结版逐字段一致）已机器验证。

## 1. 安装与基线

ContextMind 已注册进 `E:\workA\shejiuPro\.cursor\mcp.json`（幂等重装，hooks/libraries 均为当前版本）。基线 4 个 server：headroom, codegraph, ads-mysql, ads-mysql-prod——Gate 全程后仍在（IG-C18），hooks/mcp 备份文件存在。

注册形态：

```json
"contextmind": {
  "type": "stdio",
  "command": "<node.exe>",
  "args": ["E:\\workA\\shejiuPro\\.cursor\\contextmind\\mcp-server.mjs"],
  "env": { "CONTEXTMIND_PROJECT_DIR": "E:\\workA\\shejiuPro" }
}
```

## 2. 逐项证据

### 启动与协议（IG-C01/02/03/05/06）

以 mcp.json 完全相同的命令/env 启动 server，发送 Cursor 握手（protocolVersion 2025-06-18）：

```text
IG-C01  server_started: true            serverInfo {"name":"contextmind","version":"1.0.0"}
        protocolVersion echoed: 2025-06-18
IG-C02  stderr_clean: true              （stdout 仅协议帧）
IG-C03  tool_count: 6                   context_orient, context_find, context_get,
                                        context_impact, context_run, context_fetch
IG-C05  no_duplicates: true
IG-C06  no_internal_leak: true          （无 serena/codegraph/headroom/rtk/mysql/CC 旧 8 工具名）
```

### 六工具逐一真实调用（IG-C07..C12）

单一长驻会话（与 Cursor 同一进程模型：spawn 后多次 tools/call）：

```text
IG-C07  context_orient("TBuyinOrderServiceImpl")  ok=true  exit_code=0，file:line 命中
IG-C08  context_find("isoDateOnly")               ok=true  .java:NNN 命中
IG-C09  context_impact("isoDateOnly")             ok=true  Impact + callers/callees
IG-C11  context_run(node -e "console.log(42)")    ok=true  exit_code=0 + 42
IG-C12  context_get(anchors=[TBuyinOrderServiceImpl.java], budget 600)
        ok=true  budget footer "budget=600 tok packed=1"
```

完整闭环（fresh session，真实 CodeGraph 查询 OrderMessageListener）：

```text
context_orient → 6105 raw → 500 emitted tok（gate footer 实测）
             → handle=h_sztwmw2n
context_fetch(无 selector) → 与 handle store 原文 byte-for-byte 一致（roundtrip: true）
```

另一次重复 orient 查询命中 **dedup stub**（`[duplicate evidence] handle: h_n94z33n3 ... repeat: 4`）——重复证据不重灌，符合规范 §14.3。

### 预算/账本（IG-C13/14/15）

```text
IG-C13  orient 大返回 6105→500 tok（-91.8%），预算 800，handle 可回取
IG-C14  telemetry 25 个真实事件（六工具 + dedup + read-block 全有）
IG-C15  contextmind report --json 可见：
        ledger {raw:61329, emitted:8274, avoided:53055, prevented_read:1416, ratio:86.51%}
        byTool: context_orient:9 | context_fetch:3 | context_get:2 | context_impact:3
                | context_find:3 | context_run:4 | Read:1
        top saver: context_orient (-51401), context_get (-1654)
```

### 重启与错误语义（IG-C16/17）

```text
IG-C16  新进程（= Cursor 重启后的 cold server）重新 initialize + tools/list：
        恰好 6 个 context_* 工具 → true
IG-C17  畸形帧：仅记 stderr（unparseable frame），server 存活，后续 ping 正常应答
        未知方法 resources/list → 显式 JSON-RPC error (-32601 "method not found")
        stdin EOF → exit 0（不挂死）
```

### 现有 MCP 不受影响（IG-C18）

```text
Gate 全程后 mcp.json servers: headroom, codegraph, ads-mysql, ads-mysql-prod, contextmind
hooks.json.contextmind-backup / mcp.json.contextmind-mcp-backup 均在
doctor: engine/config/hooks/handles/telemetry/adapters 全 PASS
```

## 3. 待办（需用户配合，非代码问题）

1. **重启/Reload Cursor**，打开 MCP/Tools 页面，确认出现 6 个 contextmind 工具（IG-C04 的 UI 人眼确认）。
2. 在 Cursor 里发真实任务（建议话术）：
   > 请通过 ContextMind 定位 product 相关核心调用链，找一个实际 Service 方法，分析它的调用者和影响范围。禁止直接整读大文件。
   然后追加："把刚才被 Handle 化的完整证据取回来。"（触发 context_fetch）
3. 完成后跑 `node contextmind/cli.mjs report --dir E:\workA\shejiuPro`，确认 Cursor session 的真实事件入账（与 §2 IG-C14 区分：sessionId 应为 Cursor 的 conversation id）。

## 4. 已知非 Gate 项（记录不阻塞）

- doctor 的 `always rules budget: 1166/400 tokens across 4 rules FAIL`：shejiuPro 现网自有的 4 条 always 规则超预算（非 ContextMind 安装引入——ContextMind 规则默认不安装，`--rules` 未传）。属生产接管时的整改项，不在本 Gate 范围。
- doctor WARN `upstreams still visible`：S1–S3 过渡期语义（spec §5.5），生产接管时由 owner 决定是否收编。

## 5. 复现命令

```bash
# 全部六工具调用 + 闭环
node E:/workA/A-skill/Token-Mind/bench/ig-cursor-harness.mjs
# 账本
node E:/workA/A-skill/Token-Mind/contextmind/cli.mjs report --dir E:/workA/shejiuPro
# doctor
node E:/workA/A-skill/Token-Mind/contextmind/cli.mjs doctor --dir E:/workA/shejiuPro
```

harness 源码：`bench/ig-cursor-harness.mjs`（随仓库提交，Final Gate 可重跑）。
