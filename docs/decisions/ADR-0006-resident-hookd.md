# ADR-0006 — Resident hookd (DISABLED)

## Status

**DISABLED (2026-09-09).** Empty-file burst left `cm-hookd.mjs` / `cmhook-client.mjs` as CRLF-only stubs (2 bytes). Windows launchers preferred `bun → cmhook-client`, which hung ≈5s (warm p50≈5301ms).

## Decision

1. Default launcher is **direct** `node <hook>.mjs` (see `contextmind/lib/install-plan.mjs`).
2. Do not install or invoke `cm-hookd` / `cmhook-client` / `cmhook.exe` until a real implementation lands with bench proof warm p50 ≤50ms.
3. G4 remains Node spawn tax (hundreds of ms), reported honestly — not a fake resident path.

## Consequences

- Cold/warm hook latency ≈ Node process start + import graph (acceptable vs 5s hang).
- Re-enable only with: non-empty daemon + client, health check, and `bench/hook_latency.mjs` green.
