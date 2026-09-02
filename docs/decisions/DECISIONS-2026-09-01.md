# DECISIONS 2026-09-01（owner 拍板，grill 会话收敛）

```text
DECISIONS 2026-09-01 (owner):
1A evolve Token-Mind CC(Node) core; ADR vs spec §7.1; no Python engine rewrite
2C ship S2→S3→S4→S8(data+CLI); no UI; no Serena; no cmhook; no G0-G8 product-complete
3C half-day wrap-path A/B then lock shell.first_layer; no rtk log on failure; no triple compress
4A move shejiu hooks into Token-Mind cursor/hooks; vendor traps; install/doctor/uninstall
5C expose 6 spec names, dispatch internally; CodeGraph probe; schema ≤2500; no 7th tool
6 SKIP Serena + Rust cmhook
7A slice-ship report only

OUT: shejiu Java refactor, Dashboard, 8787 hijack of Grok/Composer, full catalog GetDynamicTools each turn
```

## 逐条含义

| # | 决策 | 落地物 |
|---|---|---|
| 1A | Token-Mind 内 Node/TS CC 为核心引擎，Python 只留 STT/doctor/telemetry | ADR-0001 |
| 2C | 顺序硬约束 S2→S3→S4→S8(data+CLI)；无 Dashboard UI；S8 只做三列账 SQLite + report CLI | 各切片 |
| 3C | 半天复测"CC 在 shejiu live 为何仅 5.2%"（wrap 是否接通、失败路径是否误用 rtk log、样本是否含整份 ServiceImpl），拿到数据即锁 `shell.first_layer`，本轮不再改；失败路径禁 `rtk log`；双层连环压禁止 | docs/evidence/SHELL_FIRST_LAYER_AB.md + config |
| 4A | shejiuPro 三个 gate hook 迁入 `cursor/hooks/`（保持 .mjs）；trap 表 vendor 进本仓，切断 work-mind 外部路径；install/uninstall/doctor 幂等；shejiuPro 只留 hooks.json 引用 | cursor/hooks/ + scripts |
| 5C | 对 Cursor 只暴露 context_orient/find/get/impact/run/fetch，内部 dispatch 到 CC 实现 + CodeGraph 实装探测（shejiu 常只有 explore，缺 API 降级禁止假装调用）；schema 总量实测 ≤2500 tokens；CC 旧 8 工具名不对 Agent 暴露；口径走 context_get 场景 G，不加第 7 工具 | src/mcp 六工具层 |
| 6 | Serena（spec §19.5 门槛未触发）与 Rust cmhook（§7.2 无延迟证据）均 SKIP | ADR-0003 / BLOCKERS |
| 7A | 完成口径只许写"切片上线 / 产品未完成"；最低验收 = shejiuPro 真实可用 + bench 复测 + evidence + 三列账 CLI（prevented_read / tool_emitted / proxy_llm，会员窗第三列=0 非失败） | docs/reports/ |

## 二轮默认（owner 明示可开发窗内自定）

- 配置：yaml 单文件。
- telemetry 三列账字段按 spec §24.4。
- bench corpus：沿用现有 shejiu live + wrap 复测集。

## 本轮禁止（OUT）

shejiu Java 业务重构、Dashboard UI、8787 劫持订阅模型、每轮全量 GetDynamicTools catalog 扫描、Serena、Rust cmhook、宣称 G0–G8 产品完成。
