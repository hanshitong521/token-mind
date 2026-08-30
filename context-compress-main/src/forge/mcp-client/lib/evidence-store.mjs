import crypto from "crypto";
import { getKnownIndexVersion } from "../search-cache.mjs";

const MAX = Number(process.env.TOKEN_SKILL_EVIDENCE_MAX || 96);

/** @type {Map<string, EvidenceRow>} */
const store = new Map();

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   lineStart?: number,
 *   lineEnd?: number,
 *   heading?: string,
 *   body: string,
 *   scope?: string,
 *   score?: number,
 *   indexVersion: number,
 *   createdAt: number,
 * }} EvidenceRow
 */

function trimStore() {
  while (store.size > MAX) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

export function clearEvidenceStore() {
  store.clear();
}

/**
 * Full SQL / tool payload for get_evidence restore (Scenario A).
 * @param {string[]} columns
 * @param {Record<string, unknown>[]} rows
 */
export function registerSqlResultSnapshot(columns, rows) {
  const id = `F-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const body = JSON.stringify({ kind: "sql_result", columns, rows });
  const row = {
    id,
    path: "sql:query_result",
    body,
    indexVersion: getKnownIndexVersion() || 0,
    createdAt: Date.now(),
    kind: "sql_result",
  };
  store.set(id, row);
  trimStore();
  return id;
}

/** @param {string} kind @param {string} fullText */
export function registerRawPayload(kind, fullText) {
  const id = `F-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const row = {
    id,
    path: `tool:${kind}`,
    body: fullText,
    indexVersion: getKnownIndexVersion() || 0,
    createdAt: Date.now(),
  };
  store.set(id, row);
  trimStore();
  return id;
}

export function registerEvidenceFromHit(hit, indexVersion) {
  const id = `F-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const path = hit.path ?? hit.p ?? "";
  const lineStart = hit.line_start ?? hit.l;
  const lineEnd = hit.line_end ?? hit.e;
  const body = hit.text ?? hit.ctx ?? hit.childText ?? "";
  const row = {
    id,
    path,
    lineStart,
    lineEnd,
    heading: hit.heading ?? hit.h ?? "",
    body,
    scope: hit.scope,
    score: hit.score ?? hit.s,
    indexVersion: Number(indexVersion) || 0,
    createdAt: Date.now(),
  };
  store.set(id, row);
  trimStore();
  return id;
}

/**
 * @returns {{ row: EvidenceRow, stale?: boolean, currentVersion?: number } | null}
 */
export function getStoredEvidence(evidenceId) {
  const id = String(evidenceId || "").trim().toUpperCase();
  if (!id) return null;
  const row = store.get(id);
  if (!row) return null;
  const current = getKnownIndexVersion();
  if (current > 0 && row.indexVersion > 0 && row.indexVersion !== current) {
    return { row, stale: true, currentVersion: current };
  }
  return { row, currentVersion: current };
}

export function formatEvidenceStale(row, currentVersion) {
  const loc =
    row.lineStart != null
      ? `${row.path}:${row.lineStart}${row.lineEnd ? `-${row.lineEnd}` : ""}`
      : row.path;
  return [
    "EVIDENCE_STALE",
    `evidence: ${row.id}`,
    `stored_index_version: ${row.indexVersion}`,
    `current_index_version: ${currentVersion ?? getKnownIndexVersion()}`,
    "action: run semantic_search again on this topic; do not trust this evidence body.",
    `location_hint: ${loc}`,
  ].join("\n");
}

export function formatEvidencePointer(row, { stale, currentVersion } = {}) {
  if (stale) {
    return formatEvidenceStale(row, currentVersion);
  }
  const loc =
    row.lineStart != null
      ? `${row.path}:${row.lineStart}${row.lineEnd ? `-${row.lineEnd}` : ""}`
      : row.path;
  const lines = [
    `EVIDENCE: ${row.id}`,
    "status: ok",
    `index_version: ${row.indexVersion}`,
    `location: ${loc}`,
  ];
  if (row.heading) lines.push(`heading: ${row.heading}`);
  if (row.scope) lines.push(`scope: ${row.scope}`);
  lines.push(row.body);
  return lines.join("\n");
}
