# forge/ — vendored from work-mind (ContextForge) @ commit 19cbfff

Pure-logic assets extracted from `E:\workA\A-skill\work-mind` before that repo's
deletion. **Zero npm dependencies, zero services** — Node stdlib only
(crypto/fs/path). The heavy infra (Redis/BullMQ/Ollama/Docker/API) was
deliberately left behind (see Token-Mind `docs/DEEP-DEV-PLAN.md` §3 Tier C).

Directory tree mirrors the source layout so all relative imports resolve
unchanged:

| Vendored | From | Role |
|---|---|---|
| `mcp-client/lib/*` | work-mind `mcp-client/lib` | search gate, tool-result gate (budget truncate / dedup / delta read), gate envelope, evidence store |
| `mcp-client/search-cache.mjs` | work-mind `mcp-client/` (parent level) | client cache — must sit one level above `lib/` |
| `src/lib/*` | work-mind `src/lib` | store (tokenize/lexical/tokenAwarePack/searchIndex), format-auto, doc-scope, search-role-policy, doc-read-traps, index-identity |
| `src/retrieval/*` | work-mind `src/retrieval` | sufficiency (band-ABSTAIN ladder), outcome, reranker, eligibility |
| `src/chunker/*` | work-mind `src/chunker` | markdown heading chunking, stable content-hash chunk ids (P5 wiring only) |
| `src/observability/logger.mjs` | **stub** | replaces pino logger; set `FORGE_LOG=1` to emit |
| `policy/eligibility-matrix-v2.yaml` | work-mind `.contextforge/policy` | eligibility fixture read by `eligibility-v2.mjs` |

Offline eval assets live in Token-Mind `bench/forge-golden/` (golden cases,
baseline, evaluation contract, replay judge, `smoke.mjs` acceptance).

Known semantics locked by `bench/forge-golden/smoke.mjs`:
- `budgetTruncate` budgets the body only; header/envelope is fixed overhead.
- `wrapIfSaves` attaches the evidence envelope **only when truncated** — bare
  body otherwise (envelope is always bigger than the body it wraps).
- `resolveMcpSearchParams`: overview regexes are Chinese-oriented plus
  `\boverview\b`; matched overview → top_k≥5 + `format=code`.
- `evaluateSufficiency` reads `confidenceBand`/`corpusProfile` from the ctx
  top level; `LOW`-band junk → `SUB_HIGH_CONFIDENCE_HOLD` by default.
