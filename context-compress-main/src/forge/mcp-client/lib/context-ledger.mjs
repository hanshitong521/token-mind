import crypto from "crypto";
import { estimateTokens } from "./token-estimate.mjs";

const POLICY_VERSION = "ctx-gate-1";
const MAX_EVENTS = Number(process.env.TOKEN_SKILL_LEDGER_MAX || 200);

/** @type {ContextLedgerEvent[]} */
const events = [];

/**
 * @typedef {{
 *   request_id: string,
 *   session_id: string,
 *   source_type: string,
 *   source_id?: string,
 *   original_tokens: number,
 *   delivered_tokens: number,
 *   saved_tokens: number,
 *   saved_ratio: number,
 *   latency_ms: number,
 *   cache_hit: boolean,
 *   duplicate_ratio?: number,
 *   policy_version: string,
 *   result_status: string,
 *   at: number,
 * }} ContextLedgerEvent
 */

function trimEvents() {
  while (events.length > MAX_EVENTS) events.shift();
}

/**
 * @param {Omit<ContextLedgerEvent, "request_id" | "at" | "policy_version" | "saved_tokens" | "saved_ratio"> & { request_id?: string }}
 */
export function recordContextEvent(partial) {
  const original = Math.max(0, partial.original_tokens ?? 0);
  const delivered = Math.max(0, partial.delivered_tokens ?? 0);
  const saved = Math.max(0, original - delivered);
  const ratio = original > 0 ? saved / original : 0;
  const event = {
    request_id: partial.request_id || `req_${crypto.randomBytes(4).toString("hex")}`,
    session_id: partial.session_id || "default",
    source_type: partial.source_type,
    source_id: partial.source_id,
    original_tokens: original,
    delivered_tokens: delivered,
    saved_tokens: saved,
    saved_ratio: Math.round(ratio * 10000) / 10000,
    latency_ms: partial.latency_ms ?? 0,
    cache_hit: !!partial.cache_hit,
    duplicate_ratio: partial.duplicate_ratio,
    policy_version: POLICY_VERSION,
    result_status: partial.result_status,
    at: Date.now(),
  };
  events.push(event);
  trimEvents();
  return event;
}

export function ledgerSummary(sessionId = "default") {
  const slice = events.filter((e) => e.session_id === sessionId);
  let raw = 0;
  let delivered = 0;
  let cacheHits = 0;
  const bySource = /** @type {Record<string, { raw: number, delivered: number, count: number }>} */ ({});
  for (const e of slice) {
    raw += e.original_tokens;
    delivered += e.delivered_tokens;
    if (e.cache_hit) cacheHits += 1;
    const k = e.source_type || "unknown";
    if (!bySource[k]) bySource[k] = { raw: 0, delivered: 0, count: 0 };
    bySource[k].raw += e.original_tokens;
    bySource[k].delivered += e.delivered_tokens;
    bySource[k].count += 1;
  }
  const saved = Math.max(0, raw - delivered);
  return {
    session_id: sessionId,
    policy_version: POLICY_VERSION,
    event_count: slice.length,
    raw_tokens: raw,
    delivered_tokens: delivered,
    saved_tokens: saved,
    savings_ratio: raw > 0 ? Math.round((saved / raw) * 10000) / 10000 : 0,
    cache_hits: cacheHits,
    by_source: bySource,
    recent: slice.slice(-8),
    waste: ledgerWasteAnalysis(sessionId),
  };
}

/**
 * Rank waste sources and suggest policies (feedback loop).
 * @param {string} [sessionId]
 */
export function ledgerWasteAnalysis(sessionId = "default") {
  const slice = events.filter((e) => e.session_id === sessionId);
  /** @type {Record<string, number>} */
  const bySourceSaved = {};
  /** @type {Record<string, number>} */
  const byStatus = {};
  let duplicateWaste = 0;

  for (const e of slice) {
    const src = e.source_type || "unknown";
    bySourceSaved[src] = (bySourceSaved[src] || 0) + e.saved_tokens;
    const st = e.result_status || "unknown";
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (
      e.cache_hit ||
      st === "REUSED" ||
      st === "UNCHANGED" ||
      st === "DUPLICATE_SUPPRESSED"
    ) {
      duplicateWaste += e.saved_tokens;
    }
  }

  const top_waste_sources = Object.entries(bySourceSaved)
    .map(([source, saved_tokens]) => ({ source, saved_tokens }))
    .sort((a, b) => b.saved_tokens - a.saved_tokens)
    .slice(0, 6);

  /** @type {string[]} */
  const recommendations = [];
  if (duplicateWaste > 500) {
    recommendations.push("enable incremental read + stable resource_id on file Read");
  }
  if ((bySourceSaved.mcp_tool || 0) + (bySourceSaved.sql || 0) > 800) {
    recommendations.push("route large SQL/MCP payloads through gate_tool_result before model");
  }
  if ((byStatus.REUSED || 0) + (byStatus.UNCHANGED || 0) > 2) {
    recommendations.push("prefer get_evidence(F-xxxx) over repeated semantic_search / Read");
  }
  if (!recommendations.length && slice.length) {
    recommendations.push("continue structured compression; avoid LLM summarization for gate");
  }

  return {
    duplicate_waste_tokens: duplicateWaste,
    by_status: byStatus,
    top_waste_sources,
    recommendations,
  };
}

export function clearLedger(sessionId) {
  if (!sessionId) {
    events.length = 0;
    return;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].session_id === sessionId) events.splice(i, 1);
  }
}

export function recordFromText({
  source_type,
  source_id,
  originalText,
  deliveredText,
  result_status,
  latency_ms = 0,
  cache_hit = false,
  session_id = "default",
}) {
  const original_tokens = estimateTokens(originalText);
  const delivered_tokens = estimateTokens(deliveredText);
  return recordContextEvent({
    session_id,
    source_type,
    source_id,
    original_tokens,
    delivered_tokens,
    latency_ms,
    cache_hit,
    result_status,
  });
}
