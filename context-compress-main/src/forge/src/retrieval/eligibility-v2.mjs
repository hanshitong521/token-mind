/**
 * Eligibility v2 (§18, §19) — Rule Before Score.
 *
 * 4 级: PRIMARY_ELIGIBLE / SUPPORTING_ONLY / FALLBACK_ONLY / FORBIDDEN
 * Inputs: answer_type + doc_role + authority_class + lifecycle_status + version_relation + temporal_relation
 * Output: { eligibility_class, reason }
 *
 * 严禁 §19: case IDs / Official query / expectSub / 具体路径 / if query contains "40 60 221"
 * 严禁 bonus/penalty 替代资格判断
 *
 * ponytail: 单文件，无依赖。复用 v1 的 yaml 子集 parser。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MATRIX_PATH = path.join(ROOT, ".contextforge/policy/eligibility-matrix-v2.yaml");

// ponytail: tiny YAML subset parser — 顶节 + lifecycle_override 子节 + 行内 # comment 剥离
function parseSimpleYaml(text) {
  const matrix = {};
  const overrides = {};
  let section = null;       // current top-level section name
  let inOverride = false;   // are we inside lifecycle_override block?
  let subSection = null;    // current sub-section (SUPERSEDED/ARCHIVED/...)
  for (const rawLine of text.split(/\r?\n/)) {
    // strip trailing inline comment (# ...) but only when not inside a value
    let line = rawLine.replace(/\s+#.*$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // top-level: "section_name:"
    if (/^[a-z][a-z0-9_]*:\s*$/.test(trimmed)) {
      section = trimmed.replace(/:\s*$/, "");
      inOverride = section === "lifecycle_override";
      if (!inOverride) matrix[section] = {};
      subSection = null;
      continue;
    }

    // sub-section under lifecycle_override: "  SUPERSEDED:" (2-space indent)
    if (inOverride && /^  [A-Z_]+:\s*$/.test(line)) {
      subSection = line.trim().replace(/:\s*$/, "");
      overrides[subSection] = {};
      continue;
    }

    // key: value (uppercase tokens for top-level matrix, lowercase for override keys)
    // ponytail: 两类键都在 v2 yaml 里 — 顶节 [A-Z_]+:[A-Z_]+, override 子键 [a-z_]+:[A-Z_]+
    const kvUpper = trimmed.match(/^([A-Z_]+):\s*([A-Z_]+)\s*$/);
    const kvLower = trimmed.match(/^([a-z_]+):\s*([A-Z_]+)\s*$/);
    if (kvUpper) {
      if (inOverride && subSection) {
        overrides[subSection][kvUpper[1]] = kvUpper[2];
      } else if (section && !inOverride) {
        matrix[section][kvUpper[1]] = kvUpper[2];
      }
    } else if (kvLower && inOverride && subSection) {
      overrides[subSection][kvLower[1]] = kvLower[2];
    }
  }
  return { matrix, overrides };
}

let cached = null;

export function loadEligibilityMatrixV2() {
  if (cached) return cached;
  const raw = fs.readFileSync(MATRIX_PATH, "utf8");
  cached = parseSimpleYaml(raw);
  return cached;
}

/**
 * Evaluate eligibility for a (query × document) pair.
 *
 * @param {object} args
 *   queryIntent: { answer_type, temporal_intent, explicit_historical_intent, version_intent }
 *   document: { doc_role, authority_class, lifecycle_status, version, canonical_key }
 *   versionRelation: { version_relation, temporal_relation } (from version-resolver)
 * @returns {{ eligibility_class: 'PRIMARY_ELIGIBLE'|'SUPPORTING_ONLY'|'FALLBACK_ONLY'|'FORBIDDEN', reason: string }}
 */
export function evaluateEligibilityV2({ queryIntent, document, versionRelation, corpusProfile }) {
  const { matrix, overrides } = loadEligibilityMatrixV2();
  const answerType = (queryIntent?.answer_type || "unknown").toLowerCase();
  const authorityClass = (document?.authority_class || "UNKNOWN").toUpperCase();
  const lifecycle = (document?.lifecycle_status || "ACTIVE").toUpperCase();
  const temporalIntent = queryIntent?.temporal_intent || "current";

  // §19: only based on answer_type + doc_role + authority_class + lifecycle + version_relation + temporal_relation
  // §18: Rule Before Score
  const row = matrix[answerType] || matrix.unknown || {};
  let eligibilityClass = row[authorityClass] || "FORBIDDEN";
  let reason = `matrix:${answerType}:${authorityClass}`;

  // lifecycle override (§10/§18)
  if (overrides[lifecycle]) {
    const lifecycleRow = overrides[lifecycle];
    let key = "default";
    if (temporalIntent === "historical" || queryIntent?.explicit_historical_intent) {
      key = "historical";
    } else if (temporalIntent === "current") {
      key = "current";
    }
    if (lifecycleRow[key]) {
      // Override only tightens (more restrictive wins)
      const rank = { PRIMARY_ELIGIBLE: 0, SUPPORTING_ONLY: 1, FALLBACK_ONLY: 2, FORBIDDEN: 3 };
      const override = lifecycleRow[key];
      if (rank[override] > rank[eligibilityClass]) {
        eligibilityClass = override;
        reason = `lifecycle_override:${lifecycle}:${key}`;
      }
    }
  }

  // version_relation 进一步约束
  // SUPERSEDED 文档在 CURRENT_ACTIVE 查询下应禁为 primary
  if (versionRelation?.version_relation === "SUPERSEDED" && temporalIntent === "current") {
    if (eligibilityClass === "PRIMARY_ELIGIBLE") {
      eligibilityClass = "SUPPORTING_ONLY";
      reason = "version_superseded_under_current";
    }
  }
  if (versionRelation?.version_relation === "OLDER_THAN_REQUEST" && eligibilityClass === "PRIMARY_ELIGIBLE") {
    eligibilityClass = "SUPPORTING_ONLY";
    reason = "version_older_than_request";
  }
  if (versionRelation?.version_relation === "NEWER_THAN_REQUEST" && eligibilityClass === "PRIMARY_ELIGIBLE") {
    // Don't tighten — newer is acceptable
  }

  if (document?.answer_eligible === false) {
    return { eligibility_class: "FORBIDDEN", reason: "answer_ineligible_ingest_policy" };
  }

  // Generic corpus: semantic search over arbitrary markdown — do not authority-block by role matrix.
  if (corpusProfile === "generic" && document?.answer_eligible !== false && lifecycle === "ACTIVE") {
    if (eligibilityClass === "FORBIDDEN") {
      eligibilityClass = "PRIMARY_ELIGIBLE";
      reason = "generic_corpus_relax";
    } else if (eligibilityClass === "SUPPORTING_ONLY" || eligibilityClass === "FALLBACK_ONLY") {
      eligibilityClass = "PRIMARY_ELIGIBLE";
      reason = "generic_corpus_primary_pool";
    }
  }

  if (document?.benchmark_only === true || document?.meta_only === true) {
    const temporal = queryIntent?.temporal_intent || "current";
    const allowsBench = answerType === "benchmark" || answerType === "performance";
    const allowsMeta = answerType === "test_report" || answerType === "benchmark";
    if (temporal === "current" && !allowsBench && document.benchmark_only) {
      if (eligibilityClass === "PRIMARY_ELIGIBLE") {
        eligibilityClass = "FALLBACK_ONLY";
        reason = "benchmark_only_query_mismatch";
      }
    }
    if (temporal === "current" && !allowsMeta && document.meta_only) {
      if (eligibilityClass === "PRIMARY_ELIGIBLE") {
        eligibilityClass = "FALLBACK_ONLY";
        reason = "meta_only_query_mismatch";
      }
    }
  }

  return { eligibility_class: eligibilityClass, reason };
}

/**
 * Filter documents by eligibility. Returns:
 *   { primary: [...], supporting: [...], fallback: [...], forbidden: [...] }
 *
 * Each entry: { document, eligibility, versionRelation }
 *
 * §20: Authority Abstain — PRIMARY_ELIGIBLE = 0 → ABSTAIN
 * (handled by pipeline, not here)
 *
 * §18: SUPPORTING_ONLY 不进 primary pool; FALLBACK_ONLY 只有无 PRIMARY 时才考虑
 */
export function partitionByEligibility({ documents, queryIntent, resolveVersionFn }) {
  const out = { primary: [], supporting: [], fallback: [], forbidden: [] };
  for (const doc of documents) {
    const versionRelation = resolveVersionFn
      ? resolveVersionFn(queryIntent, doc)
      : { version_relation: "VERSION_NEUTRAL", temporal_relation: "neutral" };
    const eligibility = evaluateEligibilityV2({ queryIntent, document: doc, versionRelation });
    const entry = { document: doc, eligibility, versionRelation };
    if (eligibility.eligibility_class === "PRIMARY_ELIGIBLE") out.primary.push(entry);
    else if (eligibility.eligibility_class === "SUPPORTING_ONLY") out.supporting.push(entry);
    else if (eligibility.eligibility_class === "FALLBACK_ONLY") out.fallback.push(entry);
    else out.forbidden.push(entry);
  }
  return out;
}
