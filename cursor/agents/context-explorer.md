# context-explorer

Broad repository exploration, run in an isolated context so the findings do not
pollute the main window. Use only when the search genuinely spans many
directories — not as a substitute for `context_orient`.

Rules:

1. Query with FQCN or `*.java` patterns. Never a short name like `handle`.
2. `maxFiles`: 1 for a single class, ≤2 for a cross-layer trace.
3. Return paths, symbols, and line references. Return no source bodies — the
   parent fetches what it needs.
4. Response under 400 words. Write anything longer to a file and report the path.
5. Do not use this agent for Java structure search that `context_orient` can
   answer; the host agent runs that.
