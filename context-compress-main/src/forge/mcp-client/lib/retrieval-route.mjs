import {
  classifyQueryIntent,
  extractKnownDocPath,
  extractEvidenceId,
  hasDocIntent,
} from "./query-intent.mjs";
import { isTrapDocPath } from "../../src/lib/doc-read-traps.mjs";

/** @typedef {'READ'|'CODEGRAPH'|'MYSQL'|'EVIDENCE'|'NO_SEARCH'|'LEXICAL'|'SEMANTIC'} ContextRoute */

const NO_SEARCH_RES = [
  /^(这个|该|上述|当前|以上)(方案|设计|想法|架构|改动)/,
  /(有什么|有啥|哪些)(问题|毛病|缺陷|风险|不足)/,
  /你觉得|你怎么看|帮忙\s*review|code\s*review\s*一下/i,
  /^(评价|点评)(一下)?$/i,
];

const LEXICAL_ID_RE =
  /\b[a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b|[\w.-]+:[\w.-]+/;

const LEXICAL_PHRASE_RES = [
  /\b(在哪里定义|在哪定义|有没有调用|是否调用|谁调用|where\s+is|who\s+calls)\b/i,
  /\b(listForMonitor|publishIndexReady|tagIds|G1_BLOCKED)\b/i,
  // v1.6.4 §4.2 G-C02：symbol locator 短语。
  // "handle 在哪里" / "handle 是哪个方法" / "handle 的实现在哪里" / "handle 在哪实现"
  // 原 LEXICAL_PHRASE_RES 只覆盖 "X 在哪里定义"（要求"定义"后缀 + \b 边界），漏掉通用 locator。
  // ponytail 注意：\b 在 CJK 与空格之间不成立（\w 只含 ASCII），所以这里不加 \b。
  // 加入这些短语 → 走 LEXICAL 路由（identifier locator），避免落 SEMANTIC Forge 文档搜索。
  // LEXICAL 是 identifier locator（§3.1 允许的 code path），非"普通 Forge 文档搜索"。
  /(在哪里|是哪个方法|实现在哪|在哪实现|实现位置|实现是哪|在哪定义)/,
];

const SEMANTIC_PHRASE_RES = [
  /之前.*(怎么|如何).*(处理|解决)/,
  /类似.*(问题|情况)/,
  /(多租户|鉴权|缓存).*(怎么|如何)/,
  /stale\s+index|redis.*索引/i,
];

/**
 * @param {string} query
 * @returns {boolean}
 */
export function isNoSearchOpinionQuery(query) {
  const q = String(query || "").trim();
  if (!q || q.length > 200) return false;
  if (hasDocIntent(q) || extractKnownDocPath(q)) return false;
  if (LEXICAL_ID_RE.test(q) || classifyQueryIntent(q).codeScore > 0) return false;
  return NO_SEARCH_RES.some((re) => re.test(q));
}

/**
 * @param {string} query
 * @returns {boolean}
 */
export function prefersLexicalSearch(query) {
  const q = String(query || "").trim();
  if (SEMANTIC_PHRASE_RES.some((re) => re.test(q))) return false;
  if (LEXICAL_PHRASE_RES.some((re) => re.test(q))) return true;
  const terms = q.match(LEXICAL_ID_RE);
  if (terms?.length) {
    const longest = terms.sort((a, b) => b.length - a.length)[0];
    if (longest.length >= 6) return true;
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length <= 5 && LEXICAL_ID_RE.test(q)) return true;
  return false;
}

/**
 * @param {string} query
 * @returns {{ route: ContextRoute, searchMode?: 'LEXICAL'|'SEMANTIC', reason: string }}
 */
export function classifyContextRoute(query) {
  const evidenceId = extractEvidenceId(query);
  if (evidenceId) {
    return { route: "EVIDENCE", reason: "evidence_id" };
  }
  const knownPath = extractKnownDocPath(query);
  if (knownPath) {
    if (isTrapDocPath(knownPath)) {
      return {
        route: "SEMANTIC",
        searchMode: "SEMANTIC",
        reason: "trap_doc_forge_not_read",
      };
    }
    return { route: "READ", reason: "named_doc_path", knownPath };
  }
  const classified = classifyQueryIntent(query);
  if (classified.intent === "CODE_ONLY") {
    return { route: "CODEGRAPH", reason: "code_query" };
  }
  if (classified.intent === "DB") {
    return { route: "MYSQL", reason: "sql_or_data" };
  }
  if (isNoSearchOpinionQuery(query)) {
    return { route: "NO_SEARCH", reason: "opinion_without_kb" };
  }
  if (prefersLexicalSearch(query)) {
    return { route: "LEXICAL", searchMode: "LEXICAL", reason: "identifier_or_exact" };
  }
  return { route: "SEMANTIC", searchMode: "SEMANTIC", reason: "doc_semantic" };
}

export function noSearchRouteMessage(query) {
  return [
    "NO_SEARCH",
    "route: NO_SEARCH",
    "reason: opinion_or_review_without_kb",
    "Answer from conversation context; do not call semantic_search for this shape.",
    `query: ${String(query).slice(0, 120)}`,
  ].join("\n");
}
