/**
 * 防浪费：同题 0-hit / STOP / ABSTAIN 后禁止重复 semantic_search（辅助不抢主模型判断）。
 * 返回结构化 NO_SEARCH，主模型改走 CG / Read 点名文件 / get_evidence / 问用户。
 */

import { normalizeQueryForCache } from "./query-normalize.mjs";

const MAX = Number(process.env.TOKEN_SKILL_SEARCH_GUARD_MAX || 80);
const TTL_MS = Number(process.env.TOKEN_SKILL_SEARCH_GUARD_TTL_MS || 45 * 60_000);

/** @typedef {'hit'|'no_hit'|'low_score'|'abstain'|'stop'|'blocked'} OutcomeKind */

/**
 * @type {Map<string, { at: number, kind: OutcomeKind, attempts: number, snippet: string }>}
 */
const byKey = new Map();

function key(projectId, query) {
  return `${projectId || "default"}:${normalizeQueryForCache(query)}`;
}

function trim() {
  const now = Date.now();
  for (const [k, v] of byKey) {
    if (now - v.at > TTL_MS) byKey.delete(k);
  }
  while (byKey.size > MAX) {
    const first = byKey.keys().next().value;
    if (first) byKey.delete(first);
  }
}

/**
 * @param {string} projectId
 * @param {string} query
 * @returns {{ allow: boolean, reason?: string, message?: string }}
 */
export function checkSearchRepeat(projectId, query) {
  trim();
  const q = String(query || "").trim();
  if (!q) return { allow: false, reason: "empty_query", message: "NO_SEARCH\nreason: empty_query" };
  const k = key(projectId, q);
  const prev = byKey.get(k);
  if (!prev) return { allow: true };

  const ageSec = Math.round((Date.now() - prev.at) / 1000);
  if (prev.kind === "stop") {
    return {
      allow: false,
      reason: "duplicate_after_stop",
      message: [
        "NO_SEARCH",
        "route: FORGE_GUARD",
        "reason: duplicate_after_stop",
        `query_norm: ${normalizeQueryForCache(q).slice(0, 120)}`,
        `prior: STOP (${ageSec}s ago)`,
        "Forge 已给足片段；用 get_evidence(F-xxxx) 或基于上条回答继续，禁止同题 semantic_search。",
        "代码/结构 → codegraph_explore；需全文仅 Read 用户点名的单文件。",
      ].join("\n"),
    };
  }
  if (prev.kind === "no_hit" || prev.kind === "low_score" || prev.kind === "abstain") {
    if (prev.attempts >= 1) {
      return {
        allow: false,
        reason: `duplicate_${prev.kind}`,
        message: [
          "NO_SEARCH",
          "route: FORGE_GUARD",
          `reason: duplicate_${prev.kind}`,
          `query_norm: ${normalizeQueryForCache(q).slice(0, 120)}`,
          `prior_attempts: ${prev.attempts} (${ageSec}s ago)`,
          prev.snippet,
          "同题禁止再跑 semantic_search。换业务词、Read @path、CodeGraph，或问用户澄清。",
        ].join("\n"),
      };
    }
  }
  return { allow: true };
}

/**
 * @param {string} projectId
 * @param {string} query
 * @param {{ kind: OutcomeKind, snippet?: string }} outcome
 */
export function recordSearchOutcome(projectId, query, outcome) {
  trim();
  const k = key(projectId, query);
  const prev = byKey.get(k);
  const attempts = prev?.kind === outcome.kind ? (prev.attempts || 0) + 1 : 1;
  byKey.set(k, {
    at: Date.now(),
    kind: outcome.kind,
    attempts,
    snippet: String(outcome.snippet || "").slice(0, 400),
  });
}

export function clearSearchRepeatGuard() {
  byKey.clear();
}
