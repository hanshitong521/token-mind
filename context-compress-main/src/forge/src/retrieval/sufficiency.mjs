/**
 * Sufficiency gate — 独立于 min_score threshold。
 */
export function isProductionAbstainEnabled() {
  return process.env.FORGE_PRODUCTION_ABSTAIN !== "0";
}

/** MEDIUM 带 junk：无词面锚定且语义弱 → ABSTAIN；有 lexical/dense 或强 intent 仍 ANSWERABLE */
function shouldSubHighAbstain(ctx) {
  if (process.env.FORGE_ABSTAIN_REQUIRE_HIGH === "0") return false;
  if (!isProductionAbstainEnabled()) return false;
  const band = ctx.confidenceBand;
  if (band === "HIGH") return false;
  if (band === "LOW" || band === "ABSTAIN") return true;

  const lexMin = Number(process.env.FORGE_ABSTAIN_LEX_MIN ?? 0.35);
  const denseMin = Number(process.env.FORGE_ABSTAIN_DENSE_MIN ?? 0.55);
  const lexical = Number(ctx.documentLexicalScore ?? 0);
  const dense = Number(ctx.documentDenseScore ?? 0);
  if (lexical >= lexMin || dense >= denseMin) return false;

  const rerank = ctx.selectedDoc?.rerank_score ?? 0;
  const intent = ctx.answerType;
  if (intent && intent !== "unknown" && rerank >= 0.5) return false;

  return true;
}

export function evaluateSufficiency(ctx) {
  const {
    selectedDoc,
    abstainReason,
    confidenceBand,
    fallbackUsed,
    partition,
    hits,
  } = ctx;

  const decision = {
    candidate_count:
      (partition?.primary?.length || 0) +
      (partition?.supporting?.length || 0) +
      (partition?.fallback?.length || 0),
    eligible_count: partition?.primary?.length || 0,
    authority_pass: Boolean(selectedDoc && selectedDoc.document?.answer_eligible !== false),
    sufficiency_pass: true,
  };

  if (!selectedDoc) {
    decision.sufficiency_pass = false;
    return {
      sufficient: false,
      reason: abstainReason || "INSUFFICIENT_EVIDENCE",
      confidence: 0,
      decision,
    };
  }

  if (selectedDoc.document?.answer_eligible === false) {
    decision.sufficiency_pass = false;
    return {
      sufficient: false,
      reason: "ANSWER_INELIGIBLE_DOCUMENT",
      confidence: 0.1,
      decision,
    };
  }

  if (abstainReason === "no_eligible_document") {
    decision.sufficiency_pass = false;
    return { sufficient: false, reason: "INSUFFICIENT_EVIDENCE", confidence: 0, decision };
  }

  if (fallbackUsed && isProductionAbstainEnabled() && ctx.corpusProfile !== "generic") {
    decision.sufficiency_pass = false;
    return {
      sufficient: false,
      reason: abstainReason || "AUTHORITY_FALLBACK_ONLY",
      confidence: 0.25,
      decision,
    };
  }

  if (confidenceBand === "ABSTAIN") {
    decision.sufficiency_pass = false;
    return {
      sufficient: false,
      reason: abstainReason || "INSUFFICIENT_EVIDENCE",
      confidence: 0.2,
      decision,
    };
  }

  if (abstainReason === "low_confidence_small_margin" && isProductionAbstainEnabled()) {
    decision.sufficiency_pass = false;
    return { sufficient: false, reason: "INSUFFICIENT_EVIDENCE", confidence: 0.28, decision };
  }

  // ABSTAIN-by-band（默认 ON）：junk MEDIUM 拒答；lexical/dense 锚定或强 intent 仍答
  if (shouldSubHighAbstain(ctx) && ctx.corpusProfile !== "generic") {
    decision.sufficiency_pass = false;
    return {
      sufficient: false,
      reason: "SUB_HIGH_CONFIDENCE_HOLD",
      confidence: confidenceBand === "LOW" ? 0.3 : 0.55,
      decision,
    };
  }

  let confidence = 0.5;
  if (confidenceBand === "HIGH") confidence = 0.85;
  else if (confidenceBand === "MEDIUM") confidence = 0.62;
  else if (confidenceBand === "LOW") confidence = 0.35;

  // ponytail fix(§8 P0 观测 bug)：v2 chunkHits 是位置分 `1.0-i*0.1`，取 hits[0]=1.0 让
  // junk 也返回 confidence=1（假绿观测）。真相关性首选 selectedDoc.rerank_score（document
  // 层融合分），保留 hits[0].score 作 rerank_score 缺失时的兜底（v1 / 无 doc-level 场景）。
  const topScore = selectedDoc.rerank_score ?? hits?.[0]?.score ?? 0;

  return {
    sufficient: true,
    reason: null,
    confidence: Math.min(0.99, Math.max(topScore, confidence)),
    decision,
  };
}
