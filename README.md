# Token-Mind

Cursor / AI Agent Token 优化实测项目。对 RTK 0.46、context-compress 2026.8.1、Save-The-Token 0.1 做工具级 A/B 实测，回答三个问题：是否真省 token、省多少、会不会影响准确。

## 结论速览

| 层 | 工具 | 实测节省 | 关键信息保真 | 判定 |
|---|---|---:|---|---|
| Tool Output | context-compress (balanced) | 94.6% | 错误证据完整保留 | PASS（推荐默认） |
| Tool Output | RTK | 98.9% | `err/test` 保真；`log` 用于错误日志会丢证据 | PASS（有条件） |
| Instructions/MCP | Save-The-Token | 65% | 零事实丢失 | PASS（推荐启用） |

**推荐组合：CC balanced + Save-The-Token**（两层互补，无需 Agent 改变行为）。

## 复现

```bash
# 依赖仓库根目录放置 rtk.exe 与 context-compress-main（npm install --ignore-scripts && npm run build）
python bench/run_bench.py     # 工具输出压缩 A/B，产出 bench/report.md
python bench/self_bench.py    # Agent 会话输出回放实测
```

详细数据与裁决：[bench/FINAL_REPORT.md](bench/FINAL_REPORT.md)
