import { isRelease } from "./release.mjs";
import {
  classifyQueryIntent,
  inferDocScope,
  extractEvidenceId,
  hasDocIntent,
} from "./query-intent.mjs";
import { classifyContextRoute } from "./retrieval-route.mjs";
import { trapDocRouteMessage } from "../../src/lib/doc-read-traps.mjs";

export function codegraphRouteMessage(query, { codeOnly = true } = {}) {
  if (isRelease()) {
    return [
      "NO_SEARCH",
      "route: CODEGRAPH",
      "reason: code_only_query",
      "Use CodeGraph (codegraph_explore). Forge not needed for this query shape.",
    ].join("\n");
  }
  return [
    "NO_SEARCH",
    "route: CODEGRAPH",
    "reason: code_only_query",
    `query: ${String(query).slice(0, 120)}`,
    codeOnly
      ? "纯代码/结构问题 → 只用 codegraph_explore；若还要踩坑/决策，请在 query 里带上踩坑/历史/口径等再调 semantic_search。"
      : "先 codegraph_explore；本回包未走 Forge。",
  ].join("\n");
}

/**
 * v1.7 P1-B（doc §21）：短 query 歧义检测。
 * 单 token + 长度<=12 / 短单纯标识符（handle/id/name 等）→ 歧义，禁止宽泛 CodeGraph 扫描。
 * ponytail: doc §21 伪代码第二条把所有单标识符判歧义，但长类名（BrandHandleServiceImpl）
 *           是具体可查的，加长度限制（≤16）避免误伤具体类名。
 */
export function isAmbiguousCodeQuery(query) {
  const q = String(query || "").trim();
  if (!q) return true;
  // FQCN / 带包名 / 带点号路径 → 不算歧义（com.xxx.brandHandle.BrandHandleServiceImpl）
  if (q.includes(".") && q.length > 12) return false;
  // 含中文等自然语言 → 非 Java 短符号，走 semantic_search（避免 N02 标定句被误判歧义）
  if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(q)) return false;
  // 按空白和常见标点分（保留中文/英文/数字作为 part 内容）
  // ponytail: 不用 [^A-Za-z0-9_]+ 否则中文被当分隔符，"handle 怎么实现" 误判歧义
  const parts = q.split(/[\s,.:;!?()<>\/\\]+/).filter(Boolean);
  if (parts.length === 1 && q.length <= 12) return true;
  // 短单纯标识符（handle / id / name / getUser 等，≤16 字符）
  // 长类名（BrandHandleServiceImpl 24 字符）是具体的，不判歧义
  if (parts.length === 1 && q.length <= 16 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(q)) {
    return true;
  }
  return false;
}

/**
 * v1.7 P1-B（doc §22）：歧义 query 的可执行提示。
 * 返回结构化文本，主模型知道下一步怎么做（提供 FQCN / 类+方法上下文）。
 */
export function ambiguousCodeMessage(query) {
  const q = String(query || "").trim();
  return [
    "AMBIGUOUS_QUERY",
    `reason: short_symbol_name`,
    `query: ${q}`,
    "Symbol name is too ambiguous. Provide class/package/method context.",
    "examples:",
    "  - BrandHandleServiceImpl.handle",
    "  - com.xxx.brandHandle.BrandHandleServiceImpl",
    "  - brandHandle + package name",
  ].join("\n");
}

export function codeDocSerialHint() {
  if (isRelease()) {
    return "serial: CODEGRAPH_THEN_FORGE";
  }
  return [
    "serial_hint: CODEGRAPH_THEN_FORGE",
    "先 codegraph_explore 定符号/调用边，再用本结果补踩坑/决策；禁止无目的双搜同一句纯代码问法。",
  ].join("\n");
}

export function readRouteMessage(knownPath) {
  return trapDocRouteMessage(knownPath);
}

export function mysqlRouteMessage(query) {
  if (isRelease()) {
    return [
      "NO_SEARCH",
      "route: MYSQL",
      "reason: sql_or_data_query",
      "Use ads-mysql MCP (SELECT only). Do not retry semantic_search.",
    ].join("\n");
  }
  return [
    "NO_SEARCH",
    "route: MYSQL",
    "reason: sql_or_data_query",
    `query: ${String(query).slice(0, 120)}`,
    "SQL/表/字段/生产数据 → ads-mysql（SELECT only），禁止同题 semantic_search。",
  ].join("\n");
}

/**
 * @returns {{
 *   action: 'EVIDENCE'|'BLOCK_CODE'|'BLOCK_DB'|'BLOCK_READ'|'BLOCK_NO_SEARCH'|'SEARCH',
 *   evidenceId?: string,
 *   knownPath?: string,
 *   docScope?: string,
 *   serialHint?: string,
 *   route?: string,
 *   searchMode?: 'LEXICAL'|'SEMANTIC',
 * }}
 */
export function runQueryGate(query) {
  const routeInfo = classifyContextRoute(query);
  if (routeInfo.route === "EVIDENCE") {
    const id = extractEvidenceId(query);
    if (id) return { action: "EVIDENCE", evidenceId: id, route: "EVIDENCE" };
  }
  if (routeInfo.route === "READ" && routeInfo.knownPath) {
    return { action: "BLOCK_READ", knownPath: routeInfo.knownPath, route: "READ" };
  }
  if (routeInfo.route === "CODEGRAPH") {
    // v1.7 P1-B（doc §21）：短 query 硬门禁，禁止宽泛 CodeGraph 扫描
    if (isAmbiguousCodeQuery(query)) {
      return { action: "BLOCK_CODE_AMBIGUOUS", route: "CODEGRAPH", ambiguous: true };
    }
    return { action: "BLOCK_CODE", route: "CODEGRAPH" };
  }
  if (routeInfo.route === "MYSQL") {
    return { action: "BLOCK_DB", route: "MYSQL" };
  }
  if (routeInfo.route === "NO_SEARCH") {
    return { action: "BLOCK_NO_SEARCH", route: "NO_SEARCH" };
  }

  // v1.6.4 §4.2 G-C02：裸短标识符（handle / getUser / userService / id / name）
  // 必须识别为 code intent → BLOCK_CODE_AMBIGUOUS，禁止进入普通 Forge SEARCH。
  // v1.6.3 缺这条早期检查 → "handle" 落 SEMANTIC 路由抢 Forge 文档 Top-1。
  // 条件：isAmbiguousCodeQuery 已识别为歧义 + 无 doc intent（避免"memory/release"等
  // 显式 doc 概念词被误判为 code）+ 未在前置路由命中（CODEGRAPH/READ/MYSQL/NO_SEARCH）。
  // ponytail: 复用既有 isAmbiguousCodeQuery + hasDocIntent，零新基础设施。
  if (isAmbiguousCodeQuery(query) && !hasDocIntent(query)) {
    return { action: "BLOCK_CODE_AMBIGUOUS", route: "CODEGRAPH", ambiguous: true };
  }

  const classified = classifyQueryIntent(query);
  if (classified.intent === "CODE_DOC") {
    return {
      action: "SEARCH",
      docScope: inferDocScope(query),
      serialHint: codeDocSerialHint(),
      route: routeInfo.searchMode || "SEMANTIC",
      searchMode: routeInfo.searchMode || "SEMANTIC",
    };
  }
  return {
    action: "SEARCH",
    docScope: inferDocScope(query),
    route: routeInfo.searchMode || "SEMANTIC",
    searchMode: routeInfo.searchMode || "SEMANTIC",
  };
}

export { noSearchRouteMessage } from "./retrieval-route.mjs";
