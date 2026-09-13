# ADR-0006: Windows CodeGraph `.ps1` must spawn via PowerShell

## Status

Accepted (2026-09-11)

## Context

On Windows, `codegraph.bin` is often a `codegraph.ps1` npm shim. ContextMind used `spawnSync(cmd, { shell: true })`, which runs **cmd.exe**. cmd does not execute `.ps1` reliably; the child hangs until timeout (25–120s). Interactive PowerShell sessions masked the bug.

Symptoms: `context_orient` appeared to freeze the agent; parallel `Read` on Cursor `mcps/**/tools/*.json` added unrelated multi-minute stalls.

## Decision

1. `buildCodegraphCommand()` uses `powershell -NoProfile -ExecutionPolicy Bypass -File "<bin.ps1>" …` on win32 when `bin` ends with `.ps1`.
2. `context_orient` defaults to `orient_mode: auto` — `node` + optional `callers`/`callees` before full `explore`.
3. `contextmind doctor` includes **codegraph spawn (orient)** — **FAIL** on win32+.ps1 when probe does not complete with output.
4. Regression tests in `tests/codegraph-spawn.test.mjs` and `scripts/benchmark-orient.mjs`.

## Consequences

- Orient on shejiuPro-class repos: ~12s fast path vs ~90s+ explore (when index warm).
- Install/copy must ship `lib/codegraph-spawn.mjs`; do not revert to bare `.ps1` in spawn strings.
