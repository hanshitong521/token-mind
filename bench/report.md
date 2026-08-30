# Token Tool Bench — measured results

date: 2026-08-30 12:29

| case | raw tok | RTK tok | RTK save | RTK lost | CC balanced tok | save | lost | CC aggressive tok | save | lost |
|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| git_status | 376 | 309 | 18% | LOST: modified: | 326 | 13% | OK | 288 | 23% | LOST: modified: |
| git_log_40 | 477 | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit | 477 | 0% | LOST: second commit |
| grep_hit | 22 | 22 | 0% | OK | 22 | 0% | OK | 23 | -7% | OK |
| build_success_log | 14624 | 26 | 100% | LOST: BUILD SUCCESS; Total time:  42.817 s | 157 | 99% | OK | 157 | 99% | OK |
| pytest_fail_log | 2597 | 74 | 97% | LOST: 1 failed, 127 passed | 2597 | 0% | OK | 2597 | 0% | OK |
| java_stacktrace_log | 623 | 25 | 96% | LOST: java.lang.NullPointerException; OrderServiceImpl.applyDiscount(OrderServiceImpl.java:142); OrderController.checkout(OrderController.java:87) | 623 | 0% | OK | 623 | 0% | OK |
| big_log | 88802 | 109 | 100% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 | 1524 | 98% | LOST: req-002747 |
| source_read | 96 | 96 | 0% | OK | 96 | 0% | OK | 96 | 0% | OK |

## Weighted totals (char-based)

- raw total: 430477 chars (~107619 tok)
- RTK: 4563 chars, saving 98.9%
- CC balanced: 23296 chars, saving 94.6%
- CC aggressive: 23149 chars, saving 94.6%

token estimate = chars / 4; saving measured on cleaned (ANSI-stripped) output.

## Wired configuration (2026-08-30 deep-optimize pass)

1. context-compress PreToolUse hook installed in `~/.claude/settings.json`
   (matcher `Bash|Read|Grep|WebFetch|Task`), pointing at
   `context-compress-main/dist/hooks/pretooluse.js`. It rewrites output-heavy
   Bash commands through `context-compress wrap` (balanced mode) and redirects
   WebFetch/Read/Grep to the MCP tools. Replaces the previous `rtk hook claude`
   entry — running both would double-rewrite Bash commands, and the bench above
   shows RTK discards debug evidence (pytest counts, stack frames, BUILD
   result). `rtk.exe` remains available for manual, non-evidence use.
2. `CONTEXT_COMPRESS_PERSIST_DB=1` set both in hook env and in the ZCode MCP
   server entry (`~/.zcode/cli/config.json`), so the index persists across
   sessions instead of rebuilding in memory.
3. Save-The-Token installed (`pip install -e Save-The-Token-main` with
   `--no-build-isolation`; plain pip fails on build backend) and its
   `save-the-token-mcp-doctor` skill copied to `~/.zcode/skills/`.
   Measured on this machine: `slim --task "unit tests"` trims the node_repl
   server from 8000 to 1430 estimated schema tokens (82%); `report` honestly
   returns `insufficient` for this workspace (codegraph probe fails and there
   is no AGENTS.md/CLAUDE.md to route), so its instruction-layer savings apply
   only where such instruction files exist.

Combined layering after this pass: CC balanced (tool output, ~95% saving,
near-zero loss) + STT (MCP schema/instructions, task-routed with sufficiency
checks) + manual RTK (non-evidence outputs only).
