import { estimateTokens } from "./store.mjs";

/**
 * Per-chunk format tiers + confidence 契约（format=auto）。
 *
 * 置信度契约（三层，语义分离，修复 LOW gate + use_directly 冲突）：
 *   route            — query 级：这条 query 该走什么路（query-router.mjs）
 *   confidence_gate  — retrieval 级：本次检索整体置信（top score 绝对分档，store.mjs）
 *   hit.confidence   — chunk 级：单 chunk 可信度（绝对分为主，gate 是上限）
 *
 * 输出状态机（suggested_action 是真实控制信号，不是装饰字段）：
 *   gate HIGH   → top hit full text（use_directly）
 *   gate MEDIUM → top hit summary（verify_with_read_file）
 *   gate LOW    → locator only，top1 附 80 字证据片段（limited evidence，不硬 abort）
 * 小文件升级：命中文件 ≤ SMALL_FILE_FULL_LINES 行（LOW gate 为 SNIPPET_FULL_LINES）时
 *   summary/snippet 升级 full —— chunk 即全文，省掉 follow-up Read 往返。
 */

const SUMMARY_CHARS = Number(process.env.SEARCH_AUTO_SUMMARY_CHARS || 200);
const SNIPPET_CHARS = Number(process.env.SEARCH_AUTO_SNIPPET_CHARS || 80);

// 小文件全文升级：命中文件很小时，chunk 即全文，直接返回 full 比摘要+follow-up Read 更省一轮往返。
// LOW gate（snippet）阈值更保守，避免把不相关小文件全文塞进上下文。
const SMALL_FILE_FULL_LINES = Number(process.env.SEARCH_AUTO_SMALL_FILE_LINES || 40);
const SNIPPET_FULL_LINES = Number(process.env.SEARCH_AUTO_SNIPPET_FULL_LINES || 20);

const CONF_HIGH_ABS = Number(process.env.SEARCH_CONF_HIGH || 0.72);
const CONF_MED_ABS = Number(process.env.SEARCH_HIT_CONF_MED || 0.35);

/**
 * gate 感知的 tier 分配（状态机核心）。
 * fileStats（可选，Map<path,{lines,chunks}>）：命中文件为小文件时把 summary/snippet 升级为 full。
 */
export function autoFormatTiers(hits, gate, fileStats) {
  if (!hits?.length) return [];
  const linesOf = (h) => fileStats?.get(h.path)?.lines ?? Infinity;
  if (gate === "LOW") {
    // 全 locator；top1 附证据片段：LOW = limited evidence，不是 NO_MATCH。
    // top1 命中极小文件（≤ SNIPPET_FULL_LINES 行）时升级 full：全文即证据，比片段+follow-up 更省。
    return hits.map((h, i) => ({
      hit: h,
      tier: i === 0 && linesOf(h) <= SNIPPET_FULL_LINES ? "full" : i === 0 ? "snippet" : "reference",
    }));
  }
  if (gate === "MEDIUM") {
    // top1 命中小文件（≤ SMALL_FILE_FULL_LINES 行）时升级 full：chunk 即全文，省一轮 Read 往返。
    return hits.map((h, i) => ({
      hit: h,
      tier: i === 0 && linesOf(h) <= SMALL_FILE_FULL_LINES ? "full" : i === 0 ? "summary" : "reference",
    }));
  }
  // HIGH：相对分档（top 附近 full，次级 summary，其余 reference）；小文件 summary 同样升级 full。
  const maxScore = Number(hits[0].score) || 0;
  const fullThreshold = maxScore * 0.95;
  const summaryThreshold = maxScore * 0.75;
  return hits.map((h) => {
    const s = Number(h.score) || 0;
    let tier = "reference";
    if (s >= fullThreshold) tier = "full";
    else if (s >= summaryThreshold) tier = linesOf(h) <= SMALL_FILE_FULL_LINES ? "full" : "summary";
    return { hit: h, tier };
  });
}

/**
 * chunk 级置信度：绝对分档为主，retrieval gate 为上限。
 * LOW 检索结果集里的 chunk 永不宣称 use_directly。
 */
export function relativeConfidence(score, maxScore, gate) {
  const s = Number(score) || 0;
  const m = Number(maxScore) || 0;
  void m; // 相对值仅作参考；语义以绝对分档为准，避免 top-hit 自比较恒为 high 的旧 bug
  let confidence;
  let suggested_action;
  if (s >= CONF_HIGH_ABS) {
    confidence = "high";
    suggested_action = "use_directly";
  } else if (s >= CONF_MED_ABS) {
    confidence = "medium";
    suggested_action = "verify_with_read_file";
  } else {
    confidence = "low";
    suggested_action = "likely_irrelevant";
  }
  if (gate === "LOW" && suggested_action === "use_directly") {
    confidence = "medium";
    suggested_action = "verify_with_read_file";
  }
  return { confidence, suggested_action };
}

export function formatAutoHitFields(h, tier, maxScore, gate) {
  const conf = relativeConfidence(h.score, maxScore, gate);
  const base = {
    path: h.path,
    heading: h.heading,
    line_start: h.lineStart,
    line_end: h.lineEnd,
    score: Math.round((h.score || 0) * 1000) / 1000,
    lex: h.lex != null ? Math.round(h.lex * 1000) / 1000 : undefined,
    scope: h.scope,
    auto_tier: tier,
    ...conf,
  };
  if (tier === "full") {
    const extraChild =
      h.childText && h.childText !== h.text ? h.childText : undefined;
    return {
      ...base,
      text: h.text ?? h.childText,
      ...(extraChild ? { childText: extraChild } : {}),
      estimated_tokens:
        estimateTokens(h.text) + estimateTokens(extraChild || ""),
      truncated: h.truncated,
    };
  }
  if (tier === "summary" || tier === "snippet") {
    const cap = tier === "summary" ? SUMMARY_CHARS : SNIPPET_CHARS;
    const body = h.text || h.childText || "";
    const snippet =
      body.length > cap ? `${body.slice(0, cap)}…[truncated]` : body;
    return {
      ...base,
      ctx: snippet,
      estimated_tokens: Math.ceil(snippet.length / 4),
    };
  }
  // reference: locator only（路径+标题+行号+分数，无正文）
  return {
    ...base,
    p: h.path,
    h: h.heading,
    s: base.score,
  };
}
