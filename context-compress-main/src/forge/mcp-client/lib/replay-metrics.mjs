/**
 * Agent Context A/B metrics helpers.
 */
import { estimateTokens } from "./token-estimate.mjs";

/**
 * @param {{
 *   raw_tokens: number,
 *   delivered_baseline: number,
 *   delivered_gated: number,
 *   necessary_tokens?: number,
 * }} m
 */
export function computeContextEconomics(m) {
  const raw = Math.max(0, m.raw_tokens ?? 0);
  const base = Math.max(0, m.delivered_baseline ?? raw);
  const gated = Math.max(0, m.delivered_gated ?? 0);
  const necessary = Math.max(
    0,
    m.necessary_tokens ?? Math.min(raw, Math.round(raw * 0.25)),
  );
  const avoidable = Math.max(0, raw - necessary);
  const saved_baseline = Math.max(0, base - gated);
  const avoidable_cut =
    avoidable > 0 ? Math.min(avoidable, saved_baseline) : saved_baseline;

  const efficiency_baseline =
    base > 0 ? Math.round((necessary / base) * 10000) / 10000 : 0;
  const efficiency_gated =
    gated > 0 ? Math.round((necessary / gated) * 10000) / 10000 : 0;

  return {
    raw_tokens: raw,
    necessary_tokens: necessary,
    avoidable_tokens: avoidable,
    delivered_baseline: base,
    delivered_gated: gated,
    saved_tokens: saved_baseline,
    savings_ratio: base > 0 ? Math.round((saved_baseline / base) * 10000) / 10000 : 0,
    avoidable_context_tokens: avoidable_cut,
    context_efficiency_baseline: efficiency_baseline,
    context_efficiency_gated: efficiency_gated,
    context_efficiency_delta:
      Math.round((efficiency_gated - efficiency_baseline) * 10000) / 10000,
  };
}

export function emptySideMetrics() {
  return {
    tool_calls: 0,
    duplicate_reads: 0,
    repeated_mcp_results: 0,
    retries: 0,
    evidence_recovery_events: 0,
    raw_tokens: 0,
    delivered_tokens: 0,
    input_tokens_est: 0,
  };
}

export function estToolInputTokens(ev) {
  const s = JSON.stringify(ev.input || {});
  return estimateTokens(s);
}
