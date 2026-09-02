# Evidence: Shell first-layer A/B 复测与锁定（Q3 / DECISIONS 3C）

- 采集时间：2026-09-01 15:04
- 环境：Windows 10.19045 / Node (repo .cursor runtime 与系统 node 均测) / RTK 0.46（rtk.exe）/ context-compress dist 2026.8.1
- token 估算：chars/4（与既往 Token-Mind 全部 bench 同一口径）
- 脚本：`bench/shell_owner_retest.py` → 输出 `bench/shell_owner_retest.md`

## 一、旧数字（shejiu_live_report.md CC=5.2%）根因（3 条，全部实机确认）

1. **测量路径错误**：`shejiu_live_bench.py` 用 `context-compress filter --mode balanced` 管道喂文本，未传 `--cmd`。
   `src/cli/filter.ts:66` `if (originalCmd)` —— 无 `--cmd` 时命令感知过滤全被跳过，只剩 ANSI strip。
   实测 git_status：bare filter 63 tok（0%）→ `--cmd "git status"` 46 tok（27%）。
2. **两个 0% 巨案不属于 Shell owner 域**（占 raw 87%）：
   - `java_serviceimpl`（15,911 tok）：Java 源码。spec 明文"代码不是默认压缩对象"，归 Read Guard（§15），不进本 A/B。
   - `java_tree_product`（18,435 tok）：`dir /s /b` 全树清单，归 Read/Glob Guard；且 RTK `ls` 在 Windows 上报错返回 0 tok，"RTK 100%" 是测量假象。
3. **RTK 侧两处测量假象**：`rtk git diff --no-index`（绝对路径）rc=1 空 stdout → 记 0 tok = "100% 节省"；属脚本缺陷非能力。

## 二、修正后 A/B（CC = balanced + --cmd；排除非 Shell 域案）

| case | raw tok | CC tok | CC save | RTK tok | RTK save | 备注 |
|---|---:|---:|---:|---:|---:|---|
| git_status | 63 | 46 | 27% | 14 | 78% | RTK 更激进但 CC 保分支等元数据 |
| git_log_40 | 239 | 239 | 0% | 239 | 0% | 双方 passthrough |
| git_diff_large | 104,413 | 1,785 | **98%** | 0 (rc=1 假象) | n/a | CC 保留 diff 头+尾部 |
| mvn_success_noise | 2,007 | 44 | 98% | 25 | 99% | 等效 |
| pytest_fail | 2,597 | 102 | 96% | 72 | 97% | 失败路径 |
| java_stacktrace | 623 | 623 | 0% | **11** | 98% | 见下，RTK 危险 |
| **合计** | **109,942** | **2,839** | **97.4%** | (含假象) | — | |

## 三、失败路径保真（spec P5/P12，逐条实测）

- CC balanced：pytest_fail 保留 assertion + test 名 → **PASS**；java_stacktrace 全量 passthrough（623 tok < 预算，宁多花 token 保真）→ **PASS**。
- RTK：`rtk err cat < java_stacktrace.log` 输出 **"[ok] Command completed successfully (no errors)"** —— 对异常堆栈伪造成功并丢弃全部证据 → **FAIL**（此前 FINAL_REPORT 的 `rtk log` 丢证据结论在 err 通道复现）。
- RTK：`git diff --no-index` rc=1 无输出 → 该形态不可用。

## 四、锁定（per DECISIONS 3C 规则）

```text
shell.first_layer = cc_balanced
```

- 判定依据：wrap 路径接通（`--cmd` 即生产 wrap 管线的同步入口）后 CC 对大 Shell 保真且节省达标（97.4%）；RTK 失败路径存在伪造成功 + 证据丢弃，不可作默认 owner。
- 失败路径：由 CC 结构化 adapter/StackGate 处理，**禁止任何路由进 `rtk log` / `rtk err`**（现状已满足：CC 管线无 rtk 调用点）。
- 双层连环压：CC 为唯一第一层，Output Gate 只处理超预算残余（S2 实现），无 RTK→CC→Headroom 链。
- RTK 处置：本仓 rtk.exe 保留为手动非证据场景工具，hooks/MCP 管线零引用。
- 本轮不再改此锁定；改动须新 evidence + owner 批准。

## 五、未确认项 / 后续

- `java_stacktrace` 623 tok CC 未压缩（<5KB dedup 阈值且无 [INFO]/[ERROR] 前缀）——保真优先，可接受；若 S2 后实测大堆栈场景需要，可在 stacktrace adapter 加 anchor 嗅探（已列为 S2 候选项，非本轮必须）。
- `git diff --no-index` 的 RTK 假象已在本文件修正口径，旧报告不回改，新 bench 一律用 `bench/shell_owner_retest.py`。
