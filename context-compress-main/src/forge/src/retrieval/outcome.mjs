import { evaluateSufficiency, isProductionAbstainEnabled } from "./sufficiency.mjs";

export const OUTCOMES = Object.freeze([
  "ANSWERABLE",
  "ABSTAIN",
  "NO_INDEX",
  "DENIED",
  "ERROR",
]);

export function buildRetrievalOutcome(ctx) {
  if (ctx.error) {
    return {
      outcome: "ERROR",
      reason: ctx.error,
      confidence: 0,
      evidence: [],
      decision: ctx.decision || {},
    };
  }
  if (ctx.noIndex) {
    return {
      outcome: "NO_INDEX",
      reason: "NO_INDEX",
      confidence: 0,
      evidence: [],
      decision: ctx.decision || {},
    };
  }
  if (ctx.denied) {
    return {
      outcome: "DENIED",
      reason: ctx.deniedReason || "FORBIDDEN",
      confidence: 0,
      evidence: [],
      decision: ctx.decision || {},
    };
  }

  const suff = evaluateSufficiency(ctx);
  if (!suff.sufficient && isProductionAbstainEnabled()) {
    return {
      outcome: "ABSTAIN",
      reason: suff.reason || "INSUFFICIENT_EVIDENCE",
      confidence: suff.confidence,
      evidence: [],
      decision: suff.decision,
    };
  }

  return {
    outcome: "ANSWERABLE",
    reason: null,
    confidence: suff.confidence,
    evidence: ctx.evidenceIds || [],
    decision: suff.decision,
  };
}
