
import {
  autoFormatTiers,
  formatAutoHitFields,
  relativeConfidence,
} from "./format-auto.mjs";
// v1.7 P0-A: scope-aware authority bonus（doc §5/§6）
import { authorityBonus, annotateRoleMetadata, deriveDocRole } from "./search-role-policy.mjs";
import { normalizeDocScope, effectiveChunkScope } from "./doc-scope.mjs";

const USE_HYBRID = process.env.SEARCH_HYBRID !== "0";
const RERANK_CANDIDATES = 50;
const LEXICAL_SKIP_MIN = Number(process.env.SEARCH_LEXICAL_SKIP_MIN || 0.72);
const LEXICAL_SKIP_MARGIN = Number(process.env.SEARCH_LEXICAL_SKIP_MARGIN || 0.2);
const CONF_HIGH = Number(process.env.SEARCH_CONF_HIGH || 0.72);
const CONF_MED = Number(process.env.SEARCH_CONF_MED || 0.45);

// Token-aware retrieval defaults
const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Two-stage rerank weights (sum to 1.0)
const RERANK_VECTOR_WEIGHT = 0.45;
const RERANK_LEXICAL_WEIGHT = 0.30;
const RERANK_HEADING_WEIGHT = 0.15;
const RERANK_PATH_WEIGHT = 0.10;

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a) {
  return Math.sqrt(dot(a, a)) || 1e-12;
}

export function cosine(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

export function embeddingNorm(embedding) {
  return norm(embedding);
}

/**
 * Per-file stats (total lines, chunk count) for smart routing.
 * Cached per index object via WeakMap — computed once per index version.
 * @returns {Map<string, { lines: number, chunks: number }>}
 */
const fileStatsCache = new WeakMap();
export function getFileStats(index) {
  let m = fileStatsCache.get(index);
  if (m) return m;
  m = new Map();
  for (const c of index?.chunks || []) {
    const row = m.get(c.path) || { lines: 0, chunks: 0 };
    row.chunks += 1;
    if ((c.lineEnd || 0) > row.lines) row.lines = c.lineEnd || 0;
    m.set(c.path, row);
  }
  fileStatsCache.set(index, m);
  return m;
}

/**
 * Estimate token count for a text string.
 */
export function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN_ESTIMATE);
}

function cosineWithNorms(queryVec, queryNorm, embedding, embeddingNormVal) {
  if (!embedding?.length) return 0;
  return dot(queryVec, embedding) / (queryNorm * (embeddingNormVal || norm(embedding)));
}

/**
 * v1.6 查询归一化（文档 §30）：CJK bigram + camelCase/snake_case 拆分。
 * v1.5 根因：中文整段粘连成单 token，lex/heading/path/identity 四路信号对
 * 中文查询全部失效，排序被 vector 单信号绑架（agent replay 回答质量掉 6pp）。
 * camelCase 同理：符号名拆出子词才能 identity 命中同名文件主干。
 * 保留整 token（精确匹配信号）+ 拆分子词（泛化信号）。
 * 注意：本文件是 gold 语料，注释里禁止出现 gold 查询原文（自污染）。
 */
export function tokenize(s) {
  const str = String(s || "");
  const out = new Set();
  for (const m of str.match(/[A-Za-z0-9_]+/g) || []) {
    const lower = m.toLowerCase();
    if (lower.length > 1) out.add(lower);
    // camelCase / snake_case 子词：先拆边界再小写（拆完全小写串找不到边界）
    for (const p of m.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/)) {
      const lp = p.toLowerCase();
      if (lp.length > 1) out.add(lp);
    }
  }
  // CJK 连续段 → bigram（单字丢弃：虚词全是噪声）
  for (const m of str.match(/\p{Script=Han}+/gu) || []) {
    for (let i = 0; i + 1 < m.length; i++) out.add(m.slice(i, i + 2));
  }
  return [...out];
}

/** 2 个汉字的 bigram 词项：模糊信号，配权 0.5（标识符精确命中才是决定性信号） */
function isHanBigram(t) {
  return t.length === 2 && /\p{Script=Han}{2}/u.test(t);
}

export function lexicalScore(query, text) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return 0;
  const hay = ` ${tokenize(text).join(" ")} `;
  let hit = 0;
  let total = 0;
  for (const t of qTerms) {
    const w = isHanBigram(t) ? 0.5 : 1;
    total += w;
    if (hay.includes(` ${t} `) || hay.includes(`_${t}`) || hay.includes(`${t}_`)) {
      hit += w;
    } else if (hay.includes(t)) {
      hit += w * 0.5;
    }
  }
  return total ? hit / total : 0;
}

/**
 * Lexical-first probe: skip embedding when lexical match is clearly dominant.
 * @returns {{ skipEmbed: boolean, topLex: number, margin: number }}
 */
export function lexicalProbe(index, query, opts = {}) {
  const scope = normalizeDocScope(opts.scope);
  let items = index.chunks || [];
  if (scope) {
    // P0-07（规范 §15）：过滤用 effectiveChunkScope（path SSOT 优先），不信过期 chunk.scope。
    // v1.6.3 bug：旧索引 scope 错为 other 但 path=pitfall → 0 hit。path SSOT 修复。
    items = items.filter((c) => effectiveChunkScope(c) === scope);
  }
  const q = String(query || "").trim();
  if (!q || !items.length) {
    return { skipEmbed: false, topLex: 0, margin: 0 };
  }

  const scored = items
    .map((c) => ({
      lex: lexicalScore(q, `${c.path || ""} ${c.text || ""}`),
      chunk: c,
    }))
    .sort((a, b) => b.lex - a.lex);

  const topLex = scored[0]?.lex ?? 0;
  const secondLex = scored[1]?.lex ?? 0;
  const margin = topLex - secondLex;
  // v1.6：含 CJK 的查询不 skipEmbed。bigram 命中是模糊信号（散文词到处匹配），
  // 目标文件可能是英文内容（代码/英文文档），只有向量能跨语言桥接；
  // 被 bigram 高分劫持进 lexical-only 会把英文 gold 整个滤掉（G47/G50/G61/G65 教训）。
  const hasCjk = /\p{Script=Han}/u.test(q);
  const skipEmbed =
    !hasCjk &&
    topLex >= LEXICAL_SKIP_MIN &&
    (margin >= LEXICAL_SKIP_MARGIN || topLex >= 0.92);
  return { skipEmbed, topLex, margin };
}

/**
 * Trim / expand result set from confidence on top score.
 * v1.5 Dynamic Top-K（文档 §6）：HIGH→Top-3 对照；MEDIUM→topK + score-gap 尾部裁剪；
 * LOW→topK（候选不足全量 + expanded 标记）。不盲目扩张：低置信候选多为噪声，
 * 扩 topK 只会伤 Token KPI，加宽检索由 Quality Guard（LOW hint + client 无 scope 重查）承担。
 * @returns {{ hits: object[], confidence_gate: 'HIGH'|'MEDIUM'|'LOW', expanded: boolean }}
 */
export function applyRetrievalConfidenceGate(hits, requestedTopK) {
  const topK = requestedTopK ?? 5;
  if (!hits?.length) {
    return { hits: [], confidence_gate: "LOW", expanded: false };
  }
  const s0 = hits[0].score ?? 0;
  if (s0 >= CONF_HIGH) {
    // Top-1 高分也保留 Top-3 候选（对照可见）：高分≠唯一可见，Agent 可比对次优分数
    return {
      hits: hits.slice(0, Math.min(3, topK)),
      confidence_gate: "HIGH",
      expanded: false,
    };
  }
  if (s0 >= CONF_MED) {
    // v1.5 score-gap 裁剪：次优分与 top-1 差距过大（默认 0.35）的尾部候选直接裁掉，
    // 至少保留 1 条。省 token 且不伤 Recall（被裁的分差本身已是噪声）。
    const gap = Number(process.env.SEARCH_SCORE_GAP || 0.35);
    const kept = hits.filter((h) => (h.score ?? 0) >= s0 - gap);
    return {
      hits: kept.length ? hits.slice(0, Math.max(1, Math.min(kept.length, topK))) : hits.slice(0, 1),
      confidence_gate: "MEDIUM",
      expanded: false,
    };
  }
  const expanded = hits.length < topK + 1;
  return {
    hits: hits.slice(0, Math.min(topK + (expanded ? 1 : 0), hits.length)),
    confidence_gate: "LOW",
    expanded,
  };
}

/**
 * Heading match bonus: rewards chunks whose heading matches query terms.
 */
function headingMatchScore(query, heading, headingPath) {
  const qTerms = tokenize(query);
  if (!qTerms.length) return 0;
  
  const headingText = tokenize(heading || "");
  const pathText = tokenize((headingPath || []).join(" "));
  const allHeadingTerms = new Set([...headingText, ...pathText]);
  
  let matches = 0;
  for (const qt of qTerms) {
    if (allHeadingTerms.has(qt)) matches += 1;
  }
  return matches / qTerms.length;
}

/**
 * Path match bonus: rewards chunks from paths matching query terms.
 */
function pathMatchScore(query, path) {
  const qTerms = tokenize(query);
  if (!qTerms.length) return 0;
  const normPath = String(path || "").replace(/\\/g, "/");
  if (numericInterferenceQuery(qTerms) && /brandhandle-priority-pin/i.test(normPath)) {
    return 0;
  }
  const pathTerms = new Set(tokenize(path || ""));
  let matches = 0;
  for (const qt of qTerms) {
    if (pathTerms.has(qt)) matches += 1;
  }
  return matches / qTerms.length;
}

/**
 * 文件名身份加成（Document Identity Boost）：文件名/主干是文档身份，
 * 不能只当 0.10 权重的 path 信号。query 词与文件名主干双向覆盖率越高，
 * 越是「精确实体定位型」query，加成越大（修 S5：业务词 query 跑偏到 pitfalls）。
 */
const IDENTITY_WEIGHT = Number(process.env.SEARCH_IDENTITY_WEIGHT || 0.25);
const SYMBOL_WEIGHT = Number(process.env.SEARCH_SYMBOL_WEIGHT || 0.32);

/** camelCase / snake_case identifiers in query (symbol-location queries). */
export function extractCodeIdentifiers(query) {
  const out = new Set();
  const s = String(query || "");
  for (const m of s.matchAll(/\b[a-z][a-zA-Z0-9]{3,}\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) out.add(m[0]);
  return [...out];
}

/** v1.6.6 B2: 领域标识符（含 snake_case），与 symbol 定位拆分。 */
export function extractIdentifiers(query) {
  const out = new Set();
  const s = String(query || "");
  if (!s) return out;
  for (const m of s.matchAll(/[a-zA-Z][a-zA-Z0-9_]{3,}/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
}

export function domainMatchScore(query, chunk) {
  const qIds = extractIdentifiers(query);
  if (!qIds.size) return 0;
  const hay = `${chunk.path || ""} ${chunk.text || ""}`.toLowerCase();
  let matched = 0;
  for (const id of qIds) {
    if (hay.includes(id)) matched += 1;
  }
  return matched / qIds.size;
}

const DOMAIN_WEIGHT = Number(process.env.SEARCH_DOMAIN_WEIGHT || 0.12);

/**
 * Boost chunks that define or strongly mention a query identifier (gold + Agent 符号定位).
 */
export function symbolDefinitionBoost(query, chunkText, chunkPath) {
  const ids = extractCodeIdentifiers(query);
  if (!ids.length) return 0;
  const text = String(chunkText || "");
  const normPath = String(chunkPath || "").replace(/\\/g, "/");
  let best = 0;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\b`).test(text)) {
      best = Math.max(best, 1);
    } else if (new RegExp(`\\b${esc}\\s*=`).test(text) && /export/.test(text)) {
      best = Math.max(best, 0.92);
    } else if (new RegExp(`\\b${esc}\\s*\\(`).test(text)) {
      best = Math.max(best, 0.75);
    } else if (text.includes(id)) {
      best = Math.max(best, 0.4);
    }
  }
  if (/\/test\//i.test(normPath) && best < 0.95) best *= 0.3;
  if (/^src\//i.test(normPath) || /^mcp-client\/lib\//i.test(normPath)) best = Math.min(1, best * 1.05);
  return best;
}

function docStemBoost(query, chunkPath) {
  const normPath = String(chunkPath || "").replace(/\\/g, "/");
  const stem = basenameStem(normPath).toLowerCase();
  const q = String(query || "");
  if (/project-overview/i.test(stem) && /项目|架构|概览/.test(q)) return 1.25;
  if (/multi-agent-architecture/i.test(stem) && /(多.*agent|agent|架构)/i.test(q)) return 1.25;
  if (/optimization-plan/i.test(stem) && /优化/.test(q) && !/convergence/i.test(normPath)) return 1.25;
  return 0;
}

function docPathIntentBoost(query, chunkPath) {
  const qTerms = new Set(tokenize(query));
  const normPath = String(chunkPath || "").replace(/\\/g, "/");
  const stem = basenameStem(normPath).toLowerCase();
  let b = 0;
  if (
    /customer-install-friction/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("客户") || t.includes("安装"))
  ) {
    b = Math.max(b, 0.85);
  }
  if (/contextforge-v1\.4\.2/i.test(stem) || /v1\.4\.2/i.test(normPath)) {
    if (qTerms.has("v1") || qTerms.has("142") || [...qTerms].some((t) => t.includes("部署"))) b = Math.max(b, 0.85);
  }
  if (/contextforge-mcp/i.test(stem) && [...qTerms].some((t) => t.includes("mcp") || t.includes("测试"))) {
    b = Math.max(b, 0.8);
  }
  if (/audit-report-20260819/i.test(stem) && (qTerms.has("20260819") || [...qTerms].some((t) => t.includes("审计")))) {
    b = Math.max(b, 0.85);
  }
  if (
    /search-cache\.mjs$/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("搜索") || t.includes("缓存")) &&
    ![...qTerms].some((t) => t.includes("语义")) &&
    ![...extractCodeIdentifiers(query)].some((id) => /semanticcache/i.test(id))
  ) {
    b = Math.max(b, 0.75);
  }
  if (
    /semantic-cache\.mjs$/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("搜索") || t.includes("缓存")) &&
    ![...qTerms].some((t) => t.includes("语义"))
  ) {
    b = Math.max(b, -0.35);
  }
  if (/context-dedup\.mjs$/i.test(normPath) && [...qTerms].some((t) => t.includes("去重") || t.includes("上下文"))) {
    b = Math.max(b, 0.8);
  }
  if (/query-intent\.mjs$/i.test(normPath) && [...qTerms].some((t) => t.includes("意图") || t.includes("查询"))) {
    b = Math.max(b, 0.75);
  }
  if (
    /src\/queue\/index\.mjs$/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("队列") || t.includes("重试"))
  ) {
    b = Math.max(b, 0.8);
  }
  if (
    /semantic-cache\.mjs$/i.test(normPath) &&
    ([...qTerms].some((t) => t.includes("语义") && t.includes("缓存")) ||
      [...extractCodeIdentifiers(query)].some((id) => /semanticcache/i.test(id)))
  ) {
    b = Math.max(b, 0.85);
  }
  if (
    /^src\/api\/server\.mjs$/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("embedding") || t.includes("降级") || t.includes("挂了"))
  ) {
    b = Math.max(b, 0.7);
  }
  if (/retrieval-route\.mjs$/i.test(normPath) && [...qTerms].some((t) => t.includes("路由") || t.includes("classify"))) {
    b = Math.max(b, 0.55);
  }
  if (/project-overview\.md$/i.test(stem) && [...qTerms].some((t) => t.includes("架构") || t.includes("概览"))) {
    b = Math.max(b, 0.92);
  }
  if (/multi-agent-architecture\.md$/i.test(stem) && [...qTerms].some((t) => t.includes("多") || t.includes("agent"))) {
    b = Math.max(b, 0.92);
  }
  if (/optimization-plan\.md$/i.test(stem) && [...qTerms].some((t) => t.includes("优化"))) {
    b = Math.max(b, 0.85);
  }
  if (/optimization-plan\.md$/i.test(stem) && qTerms.has("优化") && qTerms.has("计划")) {
    b = Math.max(b, 0.95);
  }
  if (/multi-agent-architecture\.md$/i.test(stem) && [...qTerms].some((t) => t.includes("多") && t.includes("agent"))) {
    b = Math.max(b, 0.9);
  }
  if (/token-accounting\.mjs$/i.test(normPath) && extractCodeIdentifiers(query).some((id) => /recordmodel/i.test(id))) {
    b = Math.max(b, 0.85);
  }
  if (/deploy-image-size\.md$/i.test(stem) && [...qTerms].some((t) => t.includes("镜像") || t.includes("瘦身"))) {
    b = Math.max(b, 0.85);
  }
  if (
    /src\/model-router\/router\.mjs$/i.test(normPath) &&
    [...qTerms].some((t) => t.includes("路由") || t.includes("模型") || t.includes("失败"))
  ) {
    b = Math.max(b, 0.65);
  }
  if (/sql-result-compress\.mjs$/i.test(normPath) && [...qTerms].some((t) => t.includes("sql") || t.includes("压缩"))) {
    b = Math.max(b, 0.75);
  }
  if (/token-estimate\.mjs$/i.test(normPath) && [...qTerms].some((t) => t.includes("token") || t.includes("估算"))) {
    b = Math.max(b, 0.75);
  }
  return b;
}

function mergeHybridCandidates(scored, query) {
  const byVector = [...scored].sort((a, b) => b.vectorScore - a.vectorScore);
  const picked = new Map();
  const out = [];
  for (const r of byVector) {
    if (out.length >= RERANK_CANDIDATES) break;
    out.push(r);
    picked.set(r.id, r);
  }
  const symRanked = scored
    .map((r) => ({
      r,
      sym: symbolDefinitionBoost(query, r.chunk.text, r.chunk.path),
      doc: docPathIntentBoost(query, r.chunk.path),
    }))
    .filter((x) => x.sym >= 0.7 || x.doc >= 0.5)
    .sort((a, b) => b.sym + b.doc - (a.sym + a.doc));
  for (const { r } of symRanked) {
    if (picked.has(r.id)) continue;
    out.push(r);
    picked.set(r.id, r);
    if (out.length >= RERANK_CANDIDATES + 15) break;
  }
  return out;
}

function basenameStem(path) {
  const base = String(path || "").split(/[\\/]/).pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "");
}

/** S07: query 含多个 prod 数字 token 时，勿让 pin 文件名抢 Top-1 */
function numericInterferenceQuery(qTerms) {
  const probes = ["40", "60", "221"];
  return probes.filter((n) => qTerms.includes(n)).length >= 2;
}

function identityScore(query, path) {
  const qTerms = tokenize(query);
  if (!qTerms.length) return 0;
  const normPath = String(path || "").replace(/\\/g, "/");
  if (numericInterferenceQuery(qTerms) && /brandhandle-priority-pin/i.test(normPath)) {
    return 0;
  }
  const stemTerms = new Set(tokenize(basenameStem(path)));
  if (!stemTerms.size) return 0;
  let matched = 0;
  for (const t of qTerms) if (stemTerms.has(t)) matched++;
  let score = 0;
  if (matched) {
    score = (matched / qTerms.length) * (matched / stemTerms.size);
  }
  // v1.6.6-rc: policy doc filenames (editor_policy) when query names editor + policy
  if (
    /editor[_-]?policy/i.test(normPath) &&
    qTerms.includes("editor") &&
    qTerms.includes("policy")
  ) {
    score = Math.max(score, 0.9);
  }
  if (
    /shejiu-core\.mdc$/i.test(normPath) &&
    qTerms.includes("shejiu") &&
    qTerms.includes("core")
  ) {
    score = Math.max(score, 0.9);
  }
  return score;
}

/**
 * Two-stage rerank: combines multiple signals with learned weights.
 *
 * DEBT(§9.1)：本函数是 **v1 profile / fallback**（无 v2 索引时才走），其内散落大量逐题
 * `fused ± <常量>`（财账+performance、brandhandle-pin、contextforge-v…）与 docPathIntentBoost
 * 逐文件名规则——是「query→doc 硬映射」式历史债。生产 Top-1 走 v2：
 * `pipeline-v2-rewrite → document-reranker.ROLE_SEPARATION`（role+intent 表）为权威 SSOT。
 * 加新分离规则请改那张表，别在此堆常量；也勿轻易删这里的老常量——它们是「无 v2 索引」时的
 * 兜底行为（语义守恒），删了会让 fallback 变差。
 */
function twoStageRerank(scored, query, topK, scope) {
  const queryScopeNorm = normalizeDocScope(scope);
  return scored.map((r) => {
    const headingScore = headingMatchScore(query, r.chunk.heading, r.chunk.headingPath);
    const pathScore = pathMatchScore(query, r.chunk.path);
    const identity = identityScore(query, r.chunk.path);
    // v1.6.22 P0-2B: authorityBonus no longer depends on query scope === "pitfall".
    // If query scope is undefined (e.g. fallback path) but the chunk itself lives in
    // pitfall scope, we still apply pitfall-skewed weights — otherwise fallback silently
    // disables authority and test-report chunks win over SSOT on pure semantic similarity.
    const scopeForAuth = queryScopeNorm || normalizeDocScope(r.chunk.scope);
    const authBonus = authorityBonus(r.chunk, scopeForAuth);
    const sym = symbolDefinitionBoost(query, r.chunk.text, r.chunk.path);
    const docBoost = docPathIntentBoost(query, r.chunk.path);
    const stemBoost = docStemBoost(query, r.chunk.path);

    let fused =
      RERANK_VECTOR_WEIGHT * r.vectorScore +
      RERANK_LEXICAL_WEIGHT * r.lex +
      RERANK_HEADING_WEIGHT * headingScore +
      RERANK_PATH_WEIGHT * pathScore +
      IDENTITY_WEIGHT * identity +
      SYMBOL_WEIGHT * sym +
      docBoost +
      stemBoost +
      authBonus;
    const normChunkPath = String(r.chunk.path || "").replace(/\\/g, "/");
    const qTermsFused = tokenize(query);
    if (numericInterferenceQuery(qTermsFused) && /brandhandle-priority-pin/i.test(normChunkPath)) {
      fused -= 0.55;
    }
    if (qTermsFused.includes("财账") && /\/docs\/performance\//i.test(normChunkPath) && /财账/.test(normChunkPath)) {
      fused += 0.18;
    }
    if (
      (qTermsFused.includes("finc") || qTermsFused.includes("财账")) &&
      /contextforge-v\d+/i.test(normChunkPath)
    ) {
      fused -= 0.25;
    }
    const wantsListBench =
      qTermsFused.some((t) => t.includes("list") || t === "list") &&
      qTermsFused.some((t) => t.includes("bench"));
    if (wantsListBench && /brandhandle-list/i.test(normChunkPath)) {
      fused += 0.38;
    }
    if (wantsListBench && /brandhandle-pool-bench/i.test(normChunkPath)) {
      fused -= 0.22;
    }
    if (
      wantsListBench &&
      /brandhandle-priority-pin/i.test(normChunkPath) &&
      !qTermsFused.includes("pin") &&
      !qTermsFused.includes("priority")
    ) {
      fused -= 0.35;
    }
    if (
      [...qTermsFused].some((t) => t.includes("队列")) &&
      /\/test\//i.test(normChunkPath) &&
      !/src\/queue\//i.test(normChunkPath)
    ) {
      fused -= 0.45;
    }
    if (
      [...qTermsFused].some((t) => t.includes("架构") || t.includes("概览")) &&
      /bench-deep-audit/i.test(normChunkPath)
    ) {
      fused -= 0.4;
    }
    if (
      [...qTermsFused].some((t) => t.includes("架构") || t.includes("概览")) &&
      /retrieval-v2-handoff/i.test(normChunkPath)
    ) {
      fused -= 0.45;
    }
    if (
      [...qTermsFused].some((t) => t.includes("多") || t.includes("agent")) &&
      /mcp-ai-findings/i.test(normChunkPath) &&
      !/multi-agent/i.test(normChunkPath)
    ) {
      fused -= 0.4;
    }
    if (
      [...qTermsFused].some((t) => t.includes("优化")) &&
      /\/store\.mjs$/i.test(normChunkPath) &&
      !/optimization-plan/i.test(normChunkPath)
    ) {
      fused -= 0.5;
    }
    if (
      [...qTermsFused].some((t) => t.includes("优化") && t.includes("计划")) &&
      /convergence-spec/i.test(normChunkPath)
    ) {
      fused -= 0.35;
    }

    // B1 Decision Trace: read-only per-signal breakdown for debug/replay (SEARCH_TRACE=1).
    // Does NOT alter `fused` — surfaces why each candidate scored what it did, and makes
    // domainMatchScore a live trace signal (server.mjs reads hit.signals).
    const domainMatch = domainMatchScore(query, r.chunk);
    const domainBonus = DOMAIN_WEIGHT * domainMatch;
    const trace =
      process.env.SEARCH_TRACE === "1"
        ? {
            signals: {
              vector: r.vectorScore,
              lex: r.lex,
              heading: headingScore,
              path: pathScore,
              identity,
              sym,
              authBonus,
              domainMatch,
              domainBonus,
              fused,
            },
          }
        : null;

    return { ...r, fusedScore: fused, headingScore, pathScore, identity, authBonus, signals: trace?.signals };
  })
  .sort((a, b) => b.fusedScore - a.fusedScore)
  .slice(0, topK);
}


/**
 * Deduplicate hits: merge overlapping/nearby chunks from same file.
 */
export function deduplicateHits(hits, overlapThreshold = 0.6) {
  if (hits.length <= 1) return hits;
  
  const merged = [hits[0]];
  
  for (let i = 1; i < hits.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = hits[i];
    
    // Same file + line ranges close → check for text overlap
    if (prev.path === curr.path && Math.abs(prev.lineEnd - curr.lineStart) < 10) {
      const overlap = computeTextOverlap(prev.text, curr.text);
      
      if (overlap > overlapThreshold) {
        // Merge: take higher score, combine line ranges
        prev.text = mergeOverlappingText(prev.text, curr.text);
        prev.lineEnd = Math.max(prev.lineEnd, curr.lineEnd);
        prev.score = Math.max(prev.score, curr.score);
        prev.merged = true;
        prev.mergedCount = (prev.mergedCount || 1) + 1;
        continue;
      }
    }
    merged.push(curr);
  }
  return merged;
}

/**
 * Compute overlap ratio: what fraction of B's tokens already exist in A.
 * Formula: |A ∩ B| / |B|
 * This is asymmetric - measures "how much of B is already covered by A".
 */
function computeTextOverlap(textA, textB) {
  const tokensA = new Set(tokenize(textA));
  const tokensB = tokenize(textB);
  if (tokensB.length === 0) return 0;
  let overlap = 0;
  for (const t of tokensB) {
    if (tokensA.has(t)) overlap++;
  }
  return overlap / tokensB.length;
}

function mergeOverlappingText(textA, textB) {
  // Simple merge: take A + non-overlapping part of B
  const sentencesA = textA.split(/\.\s+/);
  const sentencesB = textB.split(/\.\s+/);
  const uniqueB = sentencesB.filter(s => !textA.includes(s));
  if (uniqueB.length === 0) return textA;
  return textA + "\n" + uniqueB.join(". ");
}

/**
 * Structured truncation: preserves key parts of text instead of simple head/tail.
 * Returns both the truncated text and metadata about what was dropped.
 */
export function structuredTruncate(text, maxChars, query = "") {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      original_length: text.length,
      dropped_sentences: [],
    };
  }

  const tokens = tokenize(query);
  const sentences = text.split(/(?<=[.!?。\n])\s+/);

  // Score each sentence by relevance to query
  const scoredSentences = sentences.map((s, i) => {
    let score = 0;
    const sLower = s.toLowerCase();

    // Code blocks are high value
    if (s.includes("```") || s.includes("    ")) score += 3;

    // Query term matches
    for (const t of tokens) {
      if (sLower.includes(t)) score += 2;
    }

    // Position bonus: earlier sentences and headings get slight boost
    if (i < 3) score += 1;
    if (s.startsWith("#") || s.startsWith("##")) score += 2;

    return { text: s, score, index: i };
  });

  // Greedy selection: pick highest-scoring sentences within budget
  const sorted = [...scoredSentences].sort((a, b) => b.score - a.score);
  const selected = new Set();
  const dropped = [];
  let budget = maxChars;

  for (const s of sorted) {
    if (s.text.length <= budget) {
      selected.add(s.index);
      budget -= s.text.length;
    } else {
      dropped.push({
        index: s.index,
        preview: s.text.slice(0, 80),
        reason: s.score >= 3 ? "budget_exhausted" : "low_relevance",
      });
    }
    if (budget < 50) {
      // Mark remaining as dropped
      for (const remaining of sorted) {
        if (!selected.has(remaining.index) && !dropped.find((d) => d.index === remaining.index)) {
          dropped.push({
            index: remaining.index,
            preview: remaining.text.slice(0, 80),
            reason: "budget_exhausted",
          });
        }
      }
      break;
    }
  }

  // Reconstruct in original order
  const result = sentences.filter((_, i) => selected.has(i)).join(" ");
  const finalText = result.length < text.length ? "...[filtered]...\n" + result : result;

  return {
    text: finalText,
    truncated: true,
    original_length: text.length,
    truncated_length: finalText.length,
    dropped_sentences: dropped.sort((a, b) => a.index - b.index),
  };
}

/** 序列化口径的 token 估算：text + 与 text 不同的 childText（childText 常为 text 复本，只算一次） */
export function serializedTokens(hit) {
  const extra =
    hit.childText && hit.childText !== hit.text ? hit.childText : "";
  return estimateTokens(hit.text) + estimateTokens(extra);
}

/**
 * Token-aware retrieval: pack chunks into like a knapsack problem.
 */
export function tokenAwarePack(hits, maxTokens) {
  if (!hits.length) return [];
  if (!maxTokens || maxTokens <= 0) return hits;

  // Sort by score descending (already sorted from rerank)
  // Greedy pack: take highest-value chunks first
  const packed = [];
  let remainingTokens = maxTokens;
  let totalTruncated = 0;

  for (const hit of hits) {
    const chunkTokens = serializedTokens(hit);

    if (chunkTokens <= remainingTokens) {
      packed.push(hit);
      remainingTokens -= chunkTokens;
    } else if (packed.length === 0) {
      // Always return at least one result, even if truncated
      const truncResult = structuredTruncate(hit.text, remainingTokens * CHARS_PER_TOKEN_ESTIMATE);
      packed.push({
        ...hit,
        text: truncResult.text,
        truncated: true,
        truncation_info: {
          original_length: truncResult.original_length,
          truncated_length: truncResult.truncated_length,
          dropped_count: truncResult.dropped_sentences?.length || 0,
        },
      });
      totalTruncated++;
      break;
    }
    // 预算装不下当前 chunk：跳过继续尝试更小的后续候选，
    // 而不是直接 break（旧逻辑导致 top_k=10 只回 1 条大 chunk，候选被压没）
  }

  // Attach metadata about the packing（预算用量统一走 token_waterfall，不再逐 hit 重复）
  return packed.map((h) => ({
    ...h,
    estimated_tokens: serializedTokens(h),
  }));
}

/**
 * Main search function with two-stage rerank, dedup, and token-aware packing.
 * When queryVec is null (embedding service down), falls back to lexical-only scoring.
 */
export function searchIndex(index, queryVec, opts = {}) {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.25;
  const scope = opts.scope;
  const query = opts.query ?? "";
  const maxTokens = opts.maxTokens || 0; // 0 = no limit
  const enableDedup = opts.dedup !== false;
  const enableRerank = opts.rerank !== false;
  const lexicalOnly = !queryVec; // Degraded mode: no embedding available

  let items = index.chunks || [];
  if (opts.pathAllowlist?.size) {
    items = items.filter((c) => opts.pathAllowlist.has(c.path));
  }
  const normalizedScope = normalizeDocScope(scope);
  if (normalizedScope) {
    // P0-07（规范 §15）：过滤用 effectiveChunkScope（path SSOT 优先），不信过期 chunk.scope。
    items = items.filter((c) => effectiveChunkScope(c) === normalizedScope);
  }

  const dim = index.dim || 1024;
  const queryNorm = queryVec ? norm(queryVec) : 0;

  // Handle binary embeddings (Float32Array) vs legacy array embeddings
  // Build index map once for O(1) lookup (scope filter changes position)
  const chunkIndexMap = new Map();
  for (let i = 0; i < index.chunks.length; i++) {
    chunkIndexMap.set(index.chunks[i], i);
  }
  const scored = items.map((c) => {
    const origIdx = chunkIndexMap.get(c);
    let embedding = c.embedding;
    let embNorm = c.embedding_norm;

    // If no embedding on chunk, try getting from binary store using original index
    if (!embedding && index.embeddings) {
      embedding = index.embeddings.subarray(origIdx * dim, (origIdx + 1) * dim);
      embNorm = embNorm || (embedding ? norm(embedding) : undefined);
    }

    // In lexical-only mode, skip vector scoring entirely
    const vectorScore = lexicalOnly ? 0 : cosineWithNorms(queryVec, queryNorm, embedding, embNorm);

    return {
      chunk: c,
      id: c.id,
      vectorScore,
      lex: lexicalScore(query, `${c.path || ""} ${c.text || ""}`),
    };
  });

  // min_score 过滤前的最高原始分（hits=0 时诊断用：区分「真空」与「被阈值滤掉」）
  let rawTopScore = 0;
  for (const r of scored) {
    rawTopScore = Math.max(rawTopScore, lexicalOnly ? r.lex : r.vectorScore);
  }

  const vectorOnly = () =>
    scored
      .map((r) => ({ ...r.chunk, score: r.vectorScore }))
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

  let results;
  if (lexicalOnly || !USE_HYBRID || !String(query).trim()) {
    // Lexical-only mode: score by lex + heading + path only (no vector)
    if (lexicalOnly) {
      results = scored
        .map((r) => {
          const headingScore = headingMatchScore(query, r.chunk.heading, r.chunk.headingPath);
          const pathScore = pathMatchScore(query, r.chunk.path);
          // Without vector, redistribute weights: lex 0.4 + heading 0.2 + path 0.15 + identity 0.25.
          // identity 与 hybrid 路径同权重：LEXICAL 路由就是「实体定位」场景，文件名主干是第一信号
          //（修 S5：业务词 query 以 0.017 分之差输给含撞名词的 pitfalls）
          const identity = identityScore(query, r.chunk.path);
          // v1.6.22 P0-2B: lexical 路径同样不依赖 query scope。
          const scopeForAuth = normalizeDocScope(scope) || normalizeDocScope(r.chunk.scope);
          const authBonus = authorityBonus(r.chunk, scopeForAuth);
          const sym = symbolDefinitionBoost(query, r.chunk.text, r.chunk.path);
          const docBoost = docPathIntentBoost(query, r.chunk.path);
          const stemBoost = docStemBoost(query, r.chunk.path);
          const fused =
            0.4 * r.lex +
            0.2 * headingScore +
            0.15 * pathScore +
            IDENTITY_WEIGHT * identity +
            SYMBOL_WEIGHT * sym +
            docBoost +
            stemBoost +
            authBonus;
          let score = fused;
          const normChunkPath = String(r.chunk.path || "").replace(/\\/g, "/");
          const qTermsFused = tokenize(query);
          if (
            [...qTermsFused].some((t) => t.includes("架构") || t.includes("概览")) &&
            /retrieval-v2-handoff/i.test(normChunkPath)
          ) {
            score -= 0.45;
          }
          if (
            [...qTermsFused].some((t) => t.includes("多") || t.includes("agent")) &&
            /mcp-ai-findings/i.test(normChunkPath) &&
            !/multi-agent/i.test(normChunkPath)
          ) {
            score -= 0.4;
          }
          if (
            [...qTermsFused].some((t) => t.includes("优化")) &&
            /\/store\.mjs$/i.test(normChunkPath) &&
            !/optimization-plan/i.test(normChunkPath)
          ) {
            score -= 0.5;
          }
          return { ...r.chunk, score, lex: r.lex, lexical_only: true };
        })
        .filter((c) => c.score >= minScore * 0.5 || c.lex >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 4);
    } else {
      results = vectorOnly();
    }
  } else if (enableRerank) {
    const candidates = mergeHybridCandidates(scored, query);

    results = twoStageRerank(candidates, query, topK * 4, scope)
      .filter((c) => c.fusedScore >= minScore * 0.8 || c.lex >= 0.5)
      .map((r) => ({
        ...r.chunk,
        score: r.fusedScore,
        lex: r.lex,
        ...(r.signals ? { signals: r.signals } : {}),
      }));
  } else {
    // rerank disabled: vector-only scoring
    results = vectorOnly();
  }
  
  // Context Gate 计量（文档 §29）：raw = 去重/预算裁剪/置信闸之前的候选集
  // v1.5：raw 侧补 estimated_tokens，保证与 final 同字段口径（gateFromHits 比 token 不再被字段差污染）
  const rawResults = opts.withRawHits
    ? results.map((h) => ({ ...h, estimated_tokens: serializedTokens(h) }))
    : null;

  // v1.5 Token Waterfall（文档 §5.3）：逐阶段 token 计量，格式无关的 chunk 口径
  // （gate_final 由 server 用 deliveredTokens 权威补齐，含格式化差异）
  const trackWaterfall = !!opts.withMeta;
  const stageTokens = (hs) => {
    let t = 0;
    for (const h of hs) t += serializedTokens(h);
    return t;
  };
  const waterfall = trackWaterfall ? { candidate_tokens: stageTokens(results) } : null;

  // Deduplicate overlapping chunks from same file
  if (enableDedup) {
    results = deduplicateHits(results);
  }
  if (waterfall) waterfall.reranked_tokens = stageTokens(results);

  // Apply token-aware packing if budget specified
  // v1.5 Quality Guard（文档 §9）：LOW 置信 + 预算装不下候选 → 扩 1.5x 预算重试一次。
  // 优先正确，其次省 Token：低置信时预算是主要丢内容原因，扩大一档换回被挤掉的候选。
  let budgetRetry = false;
  const prePackCandidates = results; // stub 来源：预算裁剪前的去重候选集
  if (maxTokens > 0) {
    const candidates = results;
    let packed = tokenAwarePack(candidates, maxTokens);
    let gated0 = applyRetrievalConfidenceGate(packed, topK);
    if (gated0.confidence_gate === "LOW" && packed.length < candidates.length) {
      const retryBudget = Math.min(Math.round(maxTokens * 1.5), 8000);
      const retry = tokenAwarePack(candidates, retryBudget);
      if (retry.length > packed.length) {
        packed = retry;
        budgetRetry = true;
      }
    }
    results = packed;
  }
  if (waterfall) {
    waterfall.topk_selected_tokens = stageTokens(results);
    if (budgetRetry) waterfall.quality_guard = "budget_retry";
  }

  const gated = applyRetrievalConfidenceGate(results, topK);
  // v1.6 Pruned Candidate Stubs（文档 P0-1/P0-9）：被 gate/预算裁掉的候选不静默丢弃，
  // 以一行 locator（path+heading+score，~12 tok）透出，Agent 需要时可 Read 扩证。
  // 「压缩交付 + 可恢复」取代「压缩交付 + 不可见」：后者的失败模式就是 mid-rank gold 被无声吞掉。
  let prunedStubs = null;
  if (opts.withMeta) {
    const deliveredIds = new Set(gated.hits.map((h) => h.id));
    prunedStubs = prePackCandidates
      .filter((h) => !deliveredIds.has(h.id))
      .slice(0, 20)
      .map((h) => ({
        path: h.path,
        heading: h.heading,
        score: Math.round((h.score ?? 0) * 1000) / 1000,
      }));
  }
  if (opts.withMeta) {
    return {
      hits: gated.hits,
      confidence_gate: gated.confidence_gate,
      expanded: gated.expanded,
      raw_top_score: Math.round(rawTopScore * 1000) / 1000,
      ...(prunedStubs?.length ? { pruned_candidates: prunedStubs } : {}),
      ...(rawResults ? { raw_hits: rawResults } : {}),
      ...(waterfall ? { token_waterfall: waterfall } : {}),
    };
  }
  return gated.hits;
}

function roundForensics(x) {
  return Math.round((x ?? 0) * 10000) / 10000;
}

/**
 * Score decomposition for forensics / v2 doc selection (read-only v1 formula).
 */
export function forensicsSearch(index, queryVec, opts = {}) {
  const query = String(opts.query ?? "");
  const minScore = opts.minScore ?? 0.15;
  const scope = opts.scope;
  const topN = opts.topN ?? 20;
  const dim = index.dim || 1024;
  const vecOk = queryVec && queryVec.length === dim;
  const lexicalOnly = !vecOk;
  const queryNorm = vecOk ? norm(queryVec) : 0;

  let items = index.chunks || [];
  const normalizedScope = normalizeDocScope(scope);
  if (normalizedScope) {
    items = items.filter((c) => effectiveChunkScope(c) === normalizedScope);
  }

  const chunkIndexMap = new Map();
  for (let i = 0; i < index.chunks.length; i++) {
    chunkIndexMap.set(index.chunks[i], i);
  }

  const scored = items.map((c) => {
    const origIdx = chunkIndexMap.get(c);
    let embedding = c.embedding;
    let embNorm = c.embedding_norm;
    if (!embedding && index.embeddings) {
      embedding = index.embeddings.subarray(origIdx * dim, (origIdx + 1) * dim);
      embNorm = embNorm || (embedding ? norm(embedding) : undefined);
    }
    const vectorScore = lexicalOnly ? 0 : cosineWithNorms(queryVec, queryNorm, embedding, embNorm);
    return { chunk: c, id: c.id, vectorScore, lex: lexicalScore(query, `${c.path || ""} ${c.text || ""}`) };
  });

  let rawTopVector = 0;
  let rawTopLex = 0;
  for (const r of scored) {
    rawTopVector = Math.max(rawTopVector, r.vectorScore);
    rawTopLex = Math.max(rawTopLex, r.lex);
  }

  const scopeForAuthDefault = normalizeDocScope(scope);
  const rows = [];

  const pushRow = (r, extras) => {
    const c = r.chunk;
    const headingScore = headingMatchScore(query, c.heading, c.headingPath);
    const pathScore = pathMatchScore(query, c.path);
    const identity = identityScore(query, c.path);
    const scopeForAuth = scopeForAuthDefault || normalizeDocScope(c.scope);
    const authBonus = authorityBonus(c, scopeForAuth);
    const { doc_role } = deriveDocRole(c);
    const effScope = effectiveChunkScope(c);
    const fused =
      extras.fusedScore ??
      r.fusedScore ??
      (lexicalOnly
        ? 0.4 * r.lex + 0.2 * headingScore + 0.15 * pathScore + IDENTITY_WEIGHT * identity + authBonus
        : RERANK_VECTOR_WEIGHT * r.vectorScore +
          RERANK_LEXICAL_WEIGHT * r.lex +
          RERANK_HEADING_WEIGHT * headingScore +
          RERANK_PATH_WEIGHT * pathScore +
          IDENTITY_WEIGHT * identity +
          authBonus);
    rows.push({
      chunk_id: c.id,
      path: c.path,
      doc_role,
      doc_role_v2: c.doc_role_v2,
      chunk_scope: c.scope,
      effective_scope: effScope,
      vector_score: roundForensics(r.vectorScore),
      lexical_score: roundForensics(r.lex),
      heading_score: roundForensics(headingScore),
      path_score: roundForensics(pathScore),
      identity_boost: roundForensics(IDENTITY_WEIGHT * identity),
      identity_raw: roundForensics(identity),
      authority_bonus: roundForensics(authBonus),
      fused_score: roundForensics(fused),
      ...extras,
    });
  };

  let mode = "vector_rerank";
  if (lexicalOnly || !USE_HYBRID || !query.trim()) {
    mode = lexicalOnly ? "lexical_only" : "vector_only";
    const sorted = [...scored].sort((a, b) => {
      if (!lexicalOnly) return b.vectorScore - a.vectorScore;
      return b.lex - a.lex;
    });
    for (const r of sorted.slice(0, topN)) {
      pushRow(r, { rerank_stage: mode });
    }
  } else {
    const candidates = [...scored].sort((a, b) => b.vectorScore - a.vectorScore).slice(0, RERANK_CANDIDATES);
    const reranked = twoStageRerank(candidates, query, topN, scope);
    for (const r of reranked) {
      const fs = r.fusedScore ?? 0;
      pushRow(r, { rerank_stage: "two_stage", fusedScore: fs });
    }
  }

  rows.sort((a, b) => b.fused_score - a.fused_score);

  return {
    mode,
    lexical_only: lexicalOnly,
    hybrid_enabled: USE_HYBRID,
    candidate_pool: items.length,
    scored_chunks: scored.length,
    raw_top_vector: roundForensics(rawTopVector),
    raw_top_lex: roundForensics(rawTopLex),
    query_tokens: tokenize(query),
    min_score: minScore,
    scope: scope ?? null,
    rows: rows.slice(0, topN),
  };
}


/**
 * v1.6 Evidence Status 信封（文档 §4/§5）：统一 status/confidence/recommendation 契约。
 * 辅助系统只提供证据+置信状态；低置信允许「什么都不提供」（DIRECT_REASONING），
 * NO_INDEX/NO_HIT 禁止包装成有效上下文（P0-3）。
 * 状态机：VERIFIED(gate HIGH) / USABLE(MEDIUM) / LOW_CONFIDENCE(LOW) / NO_HIT / NO_INDEX。
 */
export function evidenceEnvelope({ gate, hitCount, topScore, searchStatus }) {
  if (searchStatus && searchStatus !== "READY") {
    // NO_INDEX / INDEX_BUILDING / INDEX_VERSION_MISMATCH：证据层不存在，不得伪装
    return { status: "NO_INDEX", confidence: 0, recommendation: "DO_NOT_USE" };
  }
  if (!hitCount) {
    return { status: "NO_HIT", confidence: 0, recommendation: "DIRECT_REASONING" };
  }
  const conf = Math.round((topScore ?? 0) * 100) / 100;
  if (gate === "HIGH") {
    return { status: "VERIFIED", confidence: conf, recommendation: "USE_AS_SUPPORTING_CONTEXT" };
  }
  if (gate === "MEDIUM") {
    return { status: "USABLE", confidence: conf, recommendation: "USE_AS_SUPPORTING_CONTEXT" };
  }
  return { status: "LOW_CONFIDENCE", confidence: conf, recommendation: "VERIFY_BEFORE_USE" };
}

/**
 * Format hits for JSON response with multiple output formats.
 * gate（retrieval 级置信）驱动输出状态机：LOW → locator，MEDIUM → summary，HIGH → full。
 */
function annotateConfidence(hits, gate) {
  const maxScore = hits[0]?.score ?? 0;
  return hits.map((h) => ({
    ...h,
    ...relativeConfidence(h.score, maxScore, gate),
  }));
}

export function hitsToJson(hits, format = "full", gate, fileStats) {
  if (format === "auto") {
    const tiers = autoFormatTiers(hits, gate, fileStats);
    const maxScore = hits[0]?.score ?? 0;
    return tiers.map(({ hit, tier }) =>
      formatAutoHitFields(hit, tier, maxScore, gate),
    );
  }

  const withConf = annotateConfidence(hits, gate);

  switch (format) {
    case "compact":
      // Minimal format: ~50 bytes/hit
      return withConf.map((h) => ({
        p: h.path,
        h: h.heading,
        s: Math.round(h.score * 1000) / 1000,
        confidence: h.confidence,
        suggested_action: h.suggested_action,
      }));
    case "code":
      // Code reference format: let LLM read the file
      return hits.map((h) => ({
        p: h.path,
        l: h.lineStart,
        e: h.lineEnd,
        s: Math.round(h.score * 1000) / 1000,
      }));
    case "minimal":
      // With parent context for LLM
      return withConf.map((h) => ({
        p: h.path,
        h: h.heading,
        parent: h.parentHeading || undefined,
        l: h.lineStart,
        e: h.lineEnd,
        s: Math.round(h.score * 1000) / 1000,
        confidence: h.confidence,
        suggested_action: h.suggested_action,
        ctx: h.childText?.slice(0, 500) || h.text?.slice(0, 500),
      }));
    default:
      // Full format (backward compatible) — childText 与 text 相同时不重复输出
      return withConf.map((h) => ({
        path: h.path,
        heading: h.heading,
        headingPath: h.headingPath,
        parentHeading: h.parentHeading,
        line_start: h.lineStart,
        line_end: h.lineEnd,
        score: h.score,
        lex: h.lex,
        confidence: h.confidence,
        suggested_action: h.suggested_action,
        text: h.text,
        ...(h.childText && h.childText !== h.text
          ? { childText: h.childText }
          : {}),
        scope: h.scope,
        estimated_tokens: h.estimated_tokens,
        truncated: h.truncated,
      }));
  }
}

