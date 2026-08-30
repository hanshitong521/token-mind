import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MATRIX_PATH = path.join(ROOT, ".contextforge/policy/eligibility-matrix-v1.yaml");

/** ponytail: tiny YAML subset parser — only our matrix shape, no dependency */
function parseSimpleYaml(text) {
  const matrix = {};
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[a-z][a-z0-9_]*:\s*$/.test(trimmed)) {
      section = trimmed.replace(/:\s*$/, "");
      matrix[section] = {};
      continue;
    }
    const kv = trimmed.match(/^([a-z_0-9]+):\s*\[(.*)\]\s*$/);
    if (kv && section) {
      matrix[section][kv[1]] = kv[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return matrix;
}

let cachedMatrix = null;

export function loadEligibilityMatrix() {
  if (cachedMatrix) return cachedMatrix;
  const raw = fs.readFileSync(MATRIX_PATH, "utf8");
  cachedMatrix = parseSimpleYaml(raw);
  return cachedMatrix;
}

function matrixRow(answerType) {
  const m = loadEligibilityMatrix();
  return m[answerType] || m.unknown || m.ambiguous;
}

export function evaluateEligibility({ queryIntent, document }) {
  const row = matrixRow(queryIntent.answer_type);
  const role = document.doc_role;
  const lifecycle = document.lifecycle_status || "active";

  if (row.forbidden_top1?.includes(role)) {
    return {
      eligible_for_top1: false,
      authority_class: "forbidden",
      temporal_fit: temporalFit(queryIntent, document),
      reason: `forbidden_top1_role:${role}`,
    };
  }

  if (
    queryIntent.temporal_intent === "current" &&
    lifecycle === "historical" &&
    !queryIntent.explicit_historical_intent
  ) {
    return {
      eligible_for_top1: false,
      authority_class: "historical",
      temporal_fit: "conflict",
      reason: "lifecycle_historical_without_intent",
    };
  }

  if (
    role === "META" &&
    queryIntent.answer_type === "test_report" &&
    !queryIntent.explicit_historical_intent &&
    queryIntent.version_intent
  ) {
    const path = String(document.source_path || document.path || "");
    if (queryIntent.version_intent && !path.toLowerCase().includes(queryIntent.version_intent)) {
      return {
        eligible_for_top1: false,
        authority_class: "forbidden",
        temporal_fit: "conflict",
        reason: "version_intent_mismatch",
      };
    }
  }

  if (row.top1_eligible?.includes(role)) {
    return {
      eligible_for_top1: true,
      authority_class: "canonical",
      temporal_fit: temporalFit(queryIntent, document),
      reason: "top1_eligible",
    };
  }

  if (row.supporting?.includes(role)) {
    return {
      eligible_for_top1: false,
      authority_class: "supporting",
      temporal_fit: temporalFit(queryIntent, document),
      reason: "supporting_only",
    };
  }

  return {
    eligible_for_top1: false,
    authority_class: "forbidden",
    temporal_fit: temporalFit(queryIntent, document),
    reason: "role_not_in_matrix",
  };
}

function temporalFit(queryIntent, document) {
  const lifecycle = document.lifecycle_status || "active";
  if (queryIntent.explicit_historical_intent && lifecycle === "historical") return "fit";
  if (queryIntent.temporal_intent === "current" && lifecycle === "active") return "fit";
  if (lifecycle === "historical" && queryIntent.temporal_intent === "current") return "conflict";
  return "neutral";
}

/** Pick best fused path among eligibility-filtered documents. */
export function selectDocumentTop1({ rows, queryIntent, getDocMeta }) {
  const byPath = new Map();
  for (const row of rows) {
    const p = row.path;
    const prev = byPath.get(p);
    if (!prev || row.fused_score > prev.fused_score) byPath.set(p, row);
  }

  const ranked = [...byPath.entries()]
    .map(([path, row]) => {
      const meta = getDocMeta({ path, ...row });
      const elig = evaluateEligibility({ queryIntent, document: { ...meta, path, source_path: path } });
      return { path, row, meta, elig, fused: row.fused_score };
    })
    .sort((a, b) => b.fused - a.fused);

  const eligible = ranked.filter((d) => d.elig.eligible_for_top1);
  if (eligible.length) {
    return { selected: eligible[0], ranked, eligibility_fallback: false };
  }
  return {
    selected: ranked[0] || null,
    ranked,
    eligibility_fallback: ranked.length > 0,
  };
}
