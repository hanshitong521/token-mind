/**
 * MCP 层 Token Gate：禁止无预算搜索；模型只传 query（+ 可选 depth）。
 */

import { isRelease } from "./release.mjs";
import { isOverviewQuery, isPreciseLookup } from "./query-intent.mjs";
import { isTrapDocPath } from "../../src/lib/doc-read-traps.mjs";

export { isOverviewQuery } from "./query-intent.mjs";

/**
 * 检索交付：只保留路由/闸门/STOP，禁止 budget/margin/tokens_used 把小命中撑大。
 * @param {{ body: string, route?: string, gate?: string, stopHint?: string, confidenceGate?: string }} opts
 */
export function composeSearchDelivered(opts) {
  const body = String(opts?.body || "");
  const essential = [
    opts.route ? `route: ${opts.route}` : "",
    opts.gate ? `gate: ${opts.gate}` : "",
    opts.confidenceGate ? `confidence_gate: ${opts.confidenceGate}` : "",
    opts.stopHint ? `stop_hint: ${opts.stopHint}` : "",
  ].filter(Boolean);
  if (!essential.length) return body;
  return `${essential.join(" | ")}\n\n${body}`;
}

const DEFAULT_MAX = Number(process.env.TOKEN_SKILL_SEARCH_MAX_TOKENS || 800);
const HARD_CAP = Number(process.env.TOKEN_SKILL_SEARCH_MAX_CAP || 2000);
const DEFAULT_FORMAT = process.env.TOKEN_SKILL_SEARCH_FORMAT || "minimal";
const DEFAULT_TOP_K = Number(process.env.TOKEN_SKILL_SEARCH_TOP_K || 3);
const DEFAULT_MIN_SCORE = Number(process.env.TOKEN_SKILL_SEARCH_MIN_SCORE || 0.15);
const SEARCH_TIMEOUT_MS = Number(process.env.TOKEN_SKILL_SEARCH_TIMEOUT_MS || 45_000);

const DEPTH_PRESETS = {
  normal: { max_tokens: DEFAULT_MAX },
  analysis: { max_tokens: Math.min(1400, HARD_CAP) },
  deep: { max_tokens: Math.min(2000, HARD_CAP) },
};

export function searchTimeoutMs() {
  return SEARCH_TIMEOUT_MS;
}

/**
 * @param {Record<string, unknown>} args MCP tool arguments
 * @param {{ docScope?: string, query?: string }} gateHints from Query Gate
 */
export function resolveMcpSearchParams(args = {}, gateHints = {}) {
  const depth = String(args.depth || "normal").toLowerCase();
  const preset = DEPTH_PRESETS[depth] || DEPTH_PRESETS.normal;
  const gateQuery = String(gateHints.query || args.query || "").trim();
  const overview = isOverviewQuery(gateQuery);
  const precise = isPreciseLookup(gateQuery);

  let maxTokens = Number(args.token_budget ?? args.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    maxTokens = preset.max_tokens;
  }
  maxTokens = Math.min(Math.max(64, Math.floor(maxTokens)), HARD_CAP);

  let format = String(args.format || DEFAULT_FORMAT);
  if (!args.format) {
    if (args.token_budget && !args.max_tokens) {
      format = "auto";
    } else if (overview || precise) {
      // 混合模式：精确/概览查询只回路径+行号，AI 再精准 Read（省 50%+）
      format = "code";
    }
  }
  const allowed = new Set(["full", "compact", "minimal", "code", "auto"]);
  const fmt = allowed.has(format) ? format : DEFAULT_FORMAT;

  const allowModelTopK =
    process.env.TOKEN_SKILL_ALLOW_MODEL_TOP_K === "1" && !isRelease();
  let top_k = allowModelTopK && Number.isFinite(Number(args.top_k))
    ? Math.min(12, Math.max(1, Number(args.top_k)))
    : DEFAULT_TOP_K;

  if (process.env.TOKEN_SKILL_ADAPTIVE_TOP_K !== "0" && !allowModelTopK) {
    const q = String(gateHints.query || "").trim();
    if (overview) {
      top_k = Math.max(top_k, 5);
    } else if (precise) {
      // 精确定位：含 ID/编号 → top_k=1-2
      top_k = Math.min(top_k, 2);
    } else {
      const words = q.split(/\s+/).filter(Boolean).length;
      if (words <= 4) top_k = Math.min(top_k, 2);
      else if (words >= 12) top_k = Math.min(5, top_k + 1);
    }
  }

  const min_score = Number.isFinite(Number(args.min_score))
    ? Number(args.min_score)
    : DEFAULT_MIN_SCORE;

  const allowModelScope =
    process.env.TOKEN_SKILL_ALLOW_MODEL_SCOPE === "1" && !isRelease();
  let scope = gateHints.docScope;
  if (
    allowModelScope &&
    typeof args.scope === "string" &&
    args.scope.trim()
  ) {
    scope = args.scope.trim();
  }

  return {
    top_k,
    min_score,
    scope,
    max_tokens: maxTokens,
    format: fmt,
  };
}

export function forgeUnavailableMessage(reason) {
  return [
    "contextforge 不可用（语义知识库）。不要重试 semantic_search。",
    `原因: ${reason}`,
    "降级: Java/调用链 → CodeGraph；踩坑/口径 → @.cursor/skills/ads-sql/pitfalls-shejiuPro.md 或 @file。",
  ].join("\n");
}

// === 智能路由 / 空查快速失败 ===

const LOW_SCORE_ABORT = Number(process.env.TOKEN_SKILL_LOW_SCORE_ABORT || 0.3);
const SMALL_FILE_LINES = Number(process.env.TOKEN_SKILL_SMALL_FILE_LINES || 80);
const SMALL_FILE_MAX_PATHS = Number(process.env.TOKEN_SKILL_SMALL_FILE_MAX_PATHS || 3);
// 低分命中不引导 Read 全文（likely_irrelevant 只回路径）：top score 低于此线走正常 chunk 交付
const SMALL_FILE_MIN_SCORE = Number(process.env.TOKEN_SKILL_SMALL_FILE_MIN_SCORE || 0.25);

function hitScoreOf(h) {
  const s = h?.score ?? h?.s;
  return Number.isFinite(Number(s)) ? Number(s) : 0;
}

function hitPathOf(h) {
  return h?.path ?? h?.p ?? "";
}

/**
 * 空查快速失败：所有命中分数低于阈值 → 知识库无此信息，不返回 chunk。
 * @returns {string|null}
 */
export function lowScoreAbortText(res) {
  const hits = res?.hits;
  if (!hits?.length) return null;
  const top = hitScoreOf(hits[0]);
  if (top >= LOW_SCORE_ABORT) return null;
  return [
    "search_status: LOW_SCORE_ABORT",
    `top_score: ${top.toFixed(3)} < ${LOW_SCORE_ABORT}`,
    "知识库无此信息（低置信命中）。",
    "同题禁止重跑 semantic_search；换业务词 / get_evidence / CodeGraph / 问用户（禁 workflows·pitfalls 全文）。",
  ].join("\n");
}

/**
 * 小文件智能路由：命中文件都很小（服务端标注 fl 行数）→ 直接 Read 更省。
 * @returns {string|null}
 */
export function smallFileReadText(hits) {
  if (!hits?.length) return null;
  // 低分命中不升级为「Read 全文」引导：likely_irrelevant 级别只应回路径
  if (hitScoreOf(hits[0]) < SMALL_FILE_MIN_SCORE) return null;
  /** @type {Map<string, { lines?: number, score: number }>} */
  const byPath = new Map();
  for (const h of hits) {
    const p = hitPathOf(h);
    if (!p) return null;
    const fl = h.fl ?? h.file_lines;
    const s = hitScoreOf(h);
    const row = byPath.get(p);
    if (row) row.score = Math.max(row.score, s);
    else byPath.set(p, { lines: fl, score: s });
  }
  if (!byPath.size || byPath.size > SMALL_FILE_MAX_PATHS) return null;
  for (const [p, row] of byPath) {
    if (isTrapDocPath(p)) return null;
    if (row.lines == null || row.lines > SMALL_FILE_LINES) return null;
  }
  const list = [...byPath.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([p, v]) => `- ${p}（约 ${v.lines} 行，score ${v.score.toFixed(2)}）`)
    .join("\n");
  return [
    "route: SMALL_FILE_READ",
    "命中文件很小 — 直接 Read 完整文件比 chunk 检索省 token，本回包不附内容：",
    list,
    "不要为同一问题再调 semantic_search。",
  ].join("\n");
}

/**
 * 概览性问题：只回文件清单（按相关度），让 AI 直接完整 Read。
 * @returns {string|null}
 */
export function overviewGuidanceText(hits) {
  if (!hits?.length) return null;
  /** @type {Map<string, number>} */
  const byPath = new Map();
  for (const h of hits) {
    const p = hitPathOf(h);
    if (!p) continue;
    byPath.set(p, Math.max(byPath.get(p) || 0, hitScoreOf(h)));
  }
  if (!byPath.size) return null;
  const safe = [...byPath.entries()].filter(([p]) => !isTrapDocPath(p));
  if (!safe.length) return null;
  const list = safe
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p, s]) => `- ${p} (score ${s.toFixed(2)})`)
    .join("\n");
  return [
    "route: OVERVIEW",
    "概览性问题：chunk 片段性价比低，请直接完整 Read 以下文件（按相关度，最多 2-3 个）：",
    list,
    "不要为此类宽泛问题再调 semantic_search。",
  ].join("\n");
}


export function noHitsMessage(res = {}) {
  // API 层权威路由（READ / OVERVIEW）：hits 为空但 files 即答案，不能报"无命中"
  if ((res.route === "READ" || res.route === "OVERVIEW") && res.files?.length) {
    const list = res.files
      .map((f) =>
        `- ${f.path}${f.match_lines ? `:${f.match_lines}` : ""}（约 ${f.lines} 行）`,
      )
      .join("\n");
    return [
      `route: ${res.route} (${res.reason || "routed"})`,
      res.route === "READ"
        ? "用户点名的文档 — 直接 Read 以下文件（match_lines 为最相关行范围）："
        : "概览性问题 — 直接 Read 入口文件（入口文件已排前）：",
      list,
      "不要为此问题再调 semantic_search。",
    ].join("\n");
  }
  const lines = [];
  if (res.search_status) {
    lines.push(`search_status: ${res.search_status}`);
  }
  if (res.hint) {
    lines.push(`hint: ${res.hint}`);
  }
  if (res.index_status === "building") {
    lines.push("索引构建中 — 稍后重试 semantic_index_status / semantic_search。");
  }
  // 诊断行：让模型知道是阈值滤掉还是真空，避免盲目重试
  const diag = [];
  if (Number.isFinite(Number(res.min_score))) diag.push(`min_score=${res.min_score}`);
  if (Number.isFinite(Number(res.raw_top_score))) {
    diag.push(`top raw score=${res.raw_top_score}`);
  }
  if (res.scope) diag.push(`scope=${res.scope}`);
  if (res.scopeFallback) diag.push("scope 无命中已自动全库重查");
  if (diag.length) lines.push(`0 hits after ${diag.join(", ")}`);
  lines.push(
    "contextforge 无命中。",
    "代码/结构 → CodeGraph；用户点名文件 → Read/@path；文档 → @pitfalls / @memory。",
    "同题禁止再跑 semantic_search。",
  );
  return lines.join("\n");
}
