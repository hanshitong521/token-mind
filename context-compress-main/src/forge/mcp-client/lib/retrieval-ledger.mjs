import { estimateTokens } from "./token-estimate.mjs";
import { recordContextEvent } from "./context-ledger.mjs";

const MAX = Number(process.env.TOKEN_SKILL_RETRIEVAL_LEDGER_MAX || 100);

/** @type {RetrievalLedgerRow[]} */
const rows = [];

/**
 * @typedef {{
 *   at: number,
 *   route: string,
 *   search_mode?: string,
 *   query_tokens: number,
 *   retrieved_tokens: number,
 *   returned_tokens: number,
 *   top_score?: number,
 *   result_count: number,
 *   search_status: string,
 *   confidence_gate?: string,
 *   cache_hit?: boolean,
 * }} RetrievalLedgerRow
 */

/**
 * @param {Omit<RetrievalLedgerRow, "at">} row
 */
export function recordRetrieval(row) {
  rows.push({ ...row, at: Date.now() });
  while (rows.length > MAX) rows.shift();

  recordContextEvent({
    source_type: "retrieval",
    source_id: `route:${row.route}`,
    original_tokens: row.retrieved_tokens,
    delivered_tokens: row.returned_tokens,
    latency_ms: 0,
    cache_hit: !!row.cache_hit,
    result_status: row.search_status,
  });
}

export function retrievalLedgerSummary() {
  const n = rows.length;
  if (!n) {
    return { count: 0, avg_returned_tokens: 0, by_route: {}, recent: [] };
  }
  /** @type {Record<string, { count: number, returned: number }>} */
  const by_route = {};
  let returned = 0;
  for (const r of rows) {
    returned += r.returned_tokens;
    const k = r.route || "unknown";
    if (!by_route[k]) by_route[k] = { count: 0, returned: 0 };
    by_route[k].count += 1;
    by_route[k].returned += r.returned_tokens;
  }
  return {
    count: n,
    avg_returned_tokens: Math.round(returned / n),
    by_route,
    recent: rows.slice(-10),
  };
}

export function clearRetrievalLedger() {
  rows.length = 0;
}

/**
 * @param {object} p
 */
export function recordRetrievalFromSearch({
  route,
  search_mode,
  query,
  bodyText,
  fullText,
  top_score,
  result_count,
  search_status,
  confidence_gate,
  cache_hit,
}) {
  const query_tokens = estimateTokens(query);
  const retrieved_tokens = estimateTokens(bodyText);
  const returned_tokens = estimateTokens(fullText);
  recordRetrieval({
    route: route || "SEMANTIC",
    search_mode,
    query_tokens,
    retrieved_tokens,
    returned_tokens,
    top_score,
    result_count: result_count ?? 0,
    search_status: search_status || "ok",
    confidence_gate,
    cache_hit,
  });
}
