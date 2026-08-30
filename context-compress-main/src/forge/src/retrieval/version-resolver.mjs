/**
 * Version Resolver (§16) — computes version_relation, NOT allow/deny.
 *
 * Inputs:  QueryIntent + Document Registry
 * Outputs: { version_relation, resolved_version, resolved_family, temporal_relation }
 *
 * version_relation: EXACT_MATCH / CURRENT_ACTIVE / HISTORICAL_MATCH / SUPERSEDED /
 *                   OLDER_THAN_REQUEST / NEWER_THAN_REQUEST / VERSION_NEUTRAL / UNKNOWN
 *
 * Only computes facts. Eligibility decides allow/deny.
 *
 * ponytail: 程序解析优先，无 LLM。
 */

const VERSION_NUM_RE = /v(\d{1,2})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?/i;
const DATE_RE = /(\d{4})[-_]?(\d{2})[-_]?(\d{2})/;

function parseVersionParts(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/^v/, "");
  const parts = s.split(".").map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return null;
  return parts;
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Resolve version relation between query intent and a document.
 *
 * @param {object} queryIntent - { version_intent?, temporal_intent, explicit_historical_intent }
 * @param {object} document - { version, lifecycle_status, canonical_key, superseded_by, valid_from, valid_to }
 * @returns {object} { version_relation, resolved_version, resolved_family, temporal_relation }
 */
export function resolveVersion(queryIntent, document) {
  const qv = queryIntent?.version_intent;
  const dv = document?.version;
  const lifecycle = (document?.lifecycle_status || "ACTIVE").toUpperCase();

  let version_relation = "VERSION_NEUTRAL";
  let temporal_relation = "neutral";

  // No version in query → version neutral
  if (!qv) {
    // But check temporal_intent vs lifecycle
    if (queryIntent?.temporal_intent === "current") {
      temporal_relation = lifecycle === "ACTIVE" ? "fit" : (lifecycle === "SUPERSEDED" || lifecycle === "ARCHIVED" ? "conflict" : "neutral");
    } else if (queryIntent?.explicit_historical_intent) {
      temporal_relation = (lifecycle === "SUPERSEDED" || lifecycle === "ARCHIVED" || lifecycle === "DEPRECATED") ? "fit" : "neutral";
    }
    return {
      version_relation,
      resolved_version: dv || null,
      resolved_family: document?.canonical_key || null,
      temporal_relation,
    };
  }

  // Query has version_intent. Compare with document version.
  if (!dv) {
    // Document has no version. Can't be exact match.
    version_relation = "UNKNOWN";
  } else {
    const cmp = compareVersions(qv, dv);
    if (cmp === 0) {
      version_relation = "EXACT_MATCH";
      // If document is superseded, mark as historical match
      if (lifecycle === "SUPERSEDED" || lifecycle === "ARCHIVED") {
        version_relation = "HISTORICAL_MATCH";
        temporal_relation = "historical_match";
      } else if (queryIntent?.explicit_historical_intent) {
        version_relation = "HISTORICAL_MATCH";
        temporal_relation = "historical_match";
      } else {
        version_relation = "CURRENT_ACTIVE";
        temporal_relation = "fit";
      }
    } else if (cmp > 0) {
      // qv > dv: query version newer than doc → doc is OLDER_THAN_REQUEST
      version_relation = "OLDER_THAN_REQUEST";
      temporal_relation = "older_than_request";
    } else {
      // qv < dv: query version older than doc → doc is NEWER_THAN_REQUEST
      version_relation = "NEWER_THAN_REQUEST";
      if (lifecycle === "SUPERSEDED") {
        version_relation = "SUPERSEDED";
        temporal_relation = "superseded";
      } else {
        temporal_relation = "newer_than_request";
      }
    }
  }

  // If document has superseded_by, prefer to flag as SUPERSEDED
  if (Array.isArray(document?.superseded_by) && document.superseded_by.length > 0 && version_relation === "CURRENT_ACTIVE") {
    version_relation = "SUPERSEDED";
    temporal_relation = "superseded";
  }

  return {
    version_relation,
    resolved_version: dv || null,
    resolved_family: document?.canonical_key || null,
    temporal_relation,
  };
}

/**
 * Group documents by canonical_key, find current active per family.
 * Used by Eligibility to pick the right version.
 *
 * @param {Array} documents - Registry documents
 * @returns {Map<string, Array>} canonical_key → sorted docs (ACTIVE first, then by version desc)
 */
export function groupByCanonicalFamily(documents) {
  const families = new Map();
  for (const d of documents || []) {
    const key = d.canonical_key || "unknown";
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(d);
  }
  // Sort: ACTIVE > DEPRECATED > SUPERSEDED > ARCHIVED, then version desc
  const lifecycleRank = { ACTIVE: 0, DEPRECATED: 1, SUPERSEDED: 2, ARCHIVED: 3, UNKNOWN: 4, DRAFT: 5 };
  for (const [key, docs] of families) {
    docs.sort((a, b) => {
      const ra = lifecycleRank[(a.lifecycle_status || "ACTIVE").toUpperCase()] ?? 9;
      const rb = lifecycleRank[(b.lifecycle_status || "ACTIVE").toUpperCase()] ?? 9;
      if (ra !== rb) return ra - rb;
      // Higher version first
      const cmp = compareVersions(b.version, a.version);
      if (cmp !== null) return cmp;
      return 0;
    });
  }
  return families;
}

/**
 * Pick the "current active" document from a family for VERSION_NEUTRAL queries.
 * ponytail: returns first ACTIVE, else first non-superceeded/archived.
 */
export function pickCurrentActive(familyDocs) {
  if (!familyDocs?.length) return null;
  const active = familyDocs.find((d) => (d.lifecycle_status || "ACTIVE").toUpperCase() === "ACTIVE");
  if (active) return active;
  return familyDocs[0];
}
