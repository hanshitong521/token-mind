/**
 * Authority Competition — 仅在 Top1/Top2 分差较小时按 tier 裁决；否则保持 relevance Top1。
 */
export function pickAuthorityWinner(reranked, queryIntent = {}) {
  if (!reranked?.length) {
    return { winner: null, rule: "AUTH_NO_CANDIDATES", trace: [] };
  }
  const at = queryIntent.answer_type || "unknown";
  const allowBenchmark = at === "performance" || at === "benchmark";
  const allowMeta = at === "test_report" || at === "meta";
  const pool = reranked.filter((c) => {
    if (c.document?.answer_eligible === false) return false;
    const role = (c.document?.doc_role || "").toUpperCase();
    if (c.document?.benchmark_only && !allowBenchmark) return false;
    if (c.document?.meta_only && !allowMeta) return false;
    if (role === "BENCHMARK" && !allowBenchmark) return false;
    if (role === "META" && !allowMeta) return false;
    return true;
  });
  if (!pool.length) {
    return { winner: null, rule: "AUTH_ALL_ANSWER_INELIGIBLE", trace: [] };
  }

  const top = pool[0];
  const second = pool[1];
  const margin = second ? (top.rerank_score ?? 0) - (second.rerank_score ?? 0) : 1;
  const dominanceMargin = Number(process.env.FORGE_AUTHORITY_MARGIN || 0.08);

  const trace = pool.slice(0, 5).map((c) => ({
    path: c.document?.path,
    doc_role: c.document?.doc_role,
    authority_tier: c.document?.authority_tier,
    rerank_score: c.rerank_score,
    answer_eligible: c.document?.answer_eligible,
  }));

  if (margin >= dominanceMargin) {
    return { winner: top, rule: "AUTH_RELEVANCE_TOP", trace };
  }

  const sorted = [...pool].sort((a, b) => {
    const ta = a.document?.authority_tier ?? 6;
    const tb = b.document?.authority_tier ?? 6;
    if (ta !== tb) return ta - tb;
    return (b.rerank_score ?? 0) - (a.rerank_score ?? 0);
  });
  const winner = sorted[0];
  const rule =
    winner.document?.doc_id === top.document?.doc_id ? "AUTH_RELEVANCE_TOP" : "AUTH_TIER_DOMINANCE";
  return { winner, rule, trace };
}
