/**
 * DeterministicDocumentReranker (§21) — reranks documents after Eligibility.
 *
 * Default weights (§21):
 *   document lexical + document dense + version fit + temporal fit + intent fit
 *
 * Authority / lifecycle 由 Eligibility 处理，reranker 不再做 bonus/penalty (§21)
 *
 * ponytail: 单文件，stdlib only。
 */

// Rerank weights (sum to 1.0)
// ponytail: W_INTENT 0.10→0.20, W_LEX 0.30→0.20。intent_fit 需足够权重让 PITFALL doc
//   在 "踩坑" 查询中胜过 lexical 更强但 role 不匹配的 PIN/HANDOFF doc（S08 gap=0.107 非意图分）。
const W_LEX = 0.20;
const W_DENSE = 0.40;
const W_VERSION = 0.10;
const W_TEMPORAL = 0.10;
const W_INTENT = 0.20;

/**
 * Intent fit: how well document's doc_role matches the query's answer_type.
 * §21: "intent fit"
 *
 * ponytail: 简单映射表。不依赖 case ID / query 原文。
 */
const INTENT_FIT_MATRIX = {
  canonical_rule: { SPEC: 1.0, ADR: 0.9, PIN: 1.0, PITFALL: 0.7, HANDOFF: 0.6, GUIDE: 0.5, DAILY: 0.2, REPORT: 0.2, BENCHMARK: 0.0, TEST_REPORT: 0.0, META: 0.0, UNKNOWN: 0.1 },
  current_status: { REPORT: 0.9, DAILY: 0.9, SPEC: 0.7, ADR: 0.7, HANDOFF: 0.6, PIN: 0.5, PITFALL: 0.4, GUIDE: 0.3, BENCHMARK: 0.2, TEST_REPORT: 0.1, META: 0.1, UNKNOWN: 0.2 },
  historical: { SPEC: 0.9, ADR: 0.9, HANDOFF: 0.7, DAILY: 0.7, REPORT: 0.6, PIN: 0.5, GUIDE: 0.4, PITFALL: 0.4, BENCHMARK: 0.3, TEST_REPORT: 0.3, META: 0.5, UNKNOWN: 0.2 },
  performance: { BENCHMARK: 0.9, REPORT: 0.7, SPEC: 0.7, ADR: 0.6, HANDOFF: 0.5, DAILY: 0.4, PIN: 0.3, PITFALL: 0.3, GUIDE: 0.2, TEST_REPORT: 0.1, META: 0.0, UNKNOWN: 0.1 },
  test_report: { TEST_REPORT: 1.0, BENCHMARK: 0.6, META: 0.5, SPEC: 0.5, ADR: 0.5, REPORT: 0.4, HANDOFF: 0.3, DAILY: 0.2, PIN: 0.2, PITFALL: 0.2, GUIDE: 0.2, UNKNOWN: 0.1 },
  implementation: { SPEC: 0.9, ADR: 0.8, HANDOFF: 0.7, GUIDE: 0.7, PIN: 0.6, DAILY: 0.4, REPORT: 0.3, PITFALL: 0.3, BENCHMARK: 0.1, TEST_REPORT: 0.0, META: 0.0, UNKNOWN: 0.2 },
  troubleshooting: { PITFALL: 1.0, SPEC: 0.7, ADR: 0.7, HANDOFF: 0.3, GUIDE: 0.6, PIN: 0.3, DAILY: 0.4, REPORT: 0.3, BENCHMARK: 0.1, TEST_REPORT: 0.1, META: 0.0, UNKNOWN: 0.2 },
  benchmark: { BENCHMARK: 1.0, TEST_REPORT: 0.7, SPEC: 0.5, ADR: 0.5, HANDOFF: 0.4, DAILY: 0.3, REPORT: 0.3, PIN: 0.2, PITFALL: 0.2, GUIDE: 0.2, META: 0.1, UNKNOWN: 0.1 },
  ambiguous: { SPEC: 0.7, ADR: 0.7, HANDOFF: 0.7, PIN: 0.7, GUIDE: 0.6, DAILY: 0.5, REPORT: 0.5, PITFALL: 0.4, BENCHMARK: 0.3, TEST_REPORT: 0.2, META: 0.1, UNKNOWN: 0.2 },
  unknown: { SPEC: 0.7, ADR: 0.7, HANDOFF: 0.6, PIN: 0.6, GUIDE: 0.6, DAILY: 0.5, REPORT: 0.5, PITFALL: 0.5, BENCHMARK: 0.4, TEST_REPORT: 0.3, META: 0.2, UNKNOWN: 0.3 },
};

function intentFit(answerType, docRole) {
  const row = INTENT_FIT_MATRIX[answerType] || INTENT_FIT_MATRIX.unknown;
  return row[docRole] ?? 0.1;
}

function versionFit(versionRelation) {
  if (!versionRelation) return 0.5;
  const m = {
    EXACT_MATCH: 1.0,
    CURRENT_ACTIVE: 1.0,
    HISTORICAL_MATCH: 0.9,
    VERSION_NEUTRAL: 0.5,
    SUPERSEDED: 0.3,
    OLDER_THAN_REQUEST: 0.4,
    NEWER_THAN_REQUEST: 0.6,
    UNKNOWN: 0.4,
  };
  return m[versionRelation.version_relation] ?? 0.4;
}

function temporalFit(versionRelation, queryIntent) {
  if (!versionRelation) return 0.5;
  const tr = versionRelation.temporal_relation;
  if (tr === "fit" || tr === "historical_match") return 1.0;
  if (tr === "conflict" || tr === "superseded") return 0.2;
  if (tr === "neutral") return 0.5;
  return 0.5;
}

/** Boost when query names a version slug present in document path (Q19-class, not case-specific map). */
function pathVersionSlugBoost(queryIntent, document) {
  const vi = queryIntent?.version_intent;
  if (!vi) return 0;
  const slug = vi.startsWith("v") ? vi : `v${vi}`;
  const p = String(document?.path || "").toLowerCase();
  if (p.includes(`contextforge-${slug}`) || p.includes(`contextforge_${slug}`)) return 0.12;
  if (p.includes(`-${slug}-`) || p.includes(`_${slug}_`)) return 0.06;
  return 0;
}

/**
 * 按 intent 的权威角色分离表（根治排序死区，§8 P0）。
 *
 * 机制：仅对「已评审」的 intent→(权威赢家角色, 同实体信息型干扰角色) 配对做有界分离——
 * 抬赢家 +boost、压干扰 −demote，幅度固定、不随对手 lexical 漂移。仍按 role+intent 生效，
 * 绝不 query→doc 硬映射（§9.1）。
 *
 * 为什么不是「相对 maxFit 的全局惩罚」：实测（2026-08-28）那种做法会放大 INTENT_FIT_MATRIX
 * 既有偏置，误杀真金标——例：S04 分类成 unknown，unknown 行 HANDOFF(0.6)>DAILY(0.5)，
 * 而 S04 金标恰是 daily，被相对惩罚压到 handoff 之下 → 13/14 回归。全局标量＝猜测式回归。
 *
 * 加新行须逐 intent 真机 14+holdout 对拍后才可保留（performance 依 §4 故意让 benchmark 竞争、
 * current_status/canonical_rule 里 daily/pin 常是正解，均不加 demote）。
 */
const SEP_BOOST = 0.15;
const SEP_DEMOTE = -0.4;
const ROLE_SEPARATION = {
  troubleshooting: { boost: "PITFALL", demote: ["PIN", "DAILY", "HANDOFF"] },
  test_report: { boost: "TEST_REPORT", demote: ["DAILY", "HANDOFF"] },
};
function intentRoleSeparation(queryIntent, document) {
  const rule = ROLE_SEPARATION[queryIntent?.answer_type];
  if (!rule) return 0;
  const role = document?.doc_role;
  if (role === rule.boost) return SEP_BOOST;
  if (rule.demote.includes(role)) return SEP_DEMOTE;
  return 0;
}

/**
 * Rerank documents by combined score.
 *
 * @param {Array} candidates - from retriever: [{ document, lexical, dense, fused, rank, eligibility, versionRelation }]
 * @param {object} queryIntent
 * @returns {Array} reranked: [{ document, lexical, dense, version_fit, temporal_fit, intent_fit, rerank_score, eligibility, versionRelation }]
 */
export function rerankDocuments(candidates, queryIntent) {
  const reranked = candidates.map((c) => {
    const vFit = versionFit(c.versionRelation);
    const tFit = temporalFit(c.versionRelation, queryIntent);
    const iFit = intentFit(queryIntent?.answer_type, c.document.doc_role);
    const slugBoost = pathVersionSlugBoost(queryIntent, c.document);
    const roleSeparation = intentRoleSeparation(queryIntent, c.document);

    const rerankScore =
      W_LEX * (c.lexical || 0) +
      W_DENSE * (c.dense || 0) +
      W_VERSION * vFit +
      W_TEMPORAL * tFit +
      W_INTENT * iFit +
      slugBoost +
      roleSeparation;

    return {
      ...c,
      version_fit: vFit,
      temporal_fit: tFit,
      intent_fit: iFit,
      rerank_score: rerankScore,
    };
  });

  reranked.sort((a, b) => b.rerank_score - a.rerank_score);

  // Re-rank
  return reranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * BGE reranker adapter — optional, falls back to deterministic (§22, §23).
 * ponytail: stub, not implemented. BGE 是可选增强（§23：A/B 后才考虑 opt-in）。
 */
export async function bgeRerankWithFallback(query, candidates, bgeAdapter) {
  if (!bgeAdapter) {
    return rerankDocuments(candidates, { answer_type: "unknown" });
  }
  try {
    return await bgeAdapter.rerank(query, candidates);
  } catch (err) {
    // §22: fallback deterministic, 绝不绕过 Eligibility
    return rerankDocuments(candidates, { answer_type: "unknown" });
  }
}
