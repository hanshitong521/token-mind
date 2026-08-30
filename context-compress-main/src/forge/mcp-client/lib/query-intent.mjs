import { normalizeQueryForCache } from "./query-normalize.mjs";

const EVIDENCE_ID_RE = /\b(F-[0-9A-F]{4,8})\b/i;
const EVIDENCE_PHRASE_RE =
  /^(?:evidence|证据|刚才那个坑|刚才那条)\s*(F-[0-9A-F]{4,8})?\s*$/i;

const CODE_RES = [
  /\b(codegraph|codegraph_explore)\b/i,
  /\b(java|\.java\b|mapper\.xml|mybatis)\b/i,
  /\b(serviceimpl|controller|repository|dao)\b/i,
  /\bmapper\b/i,
  /(调用链|爆炸半径|谁调|谁调用|改哪文件|哪个类)/,
  /\b[A-Z][a-zA-Z0-9]*(Service|Controller|Mapper|Impl|Dto|Vo)\b/,
  /\bT[A-Z][A-Za-z0-9]*(Task|Issue|Controller)\b/,
  /\b[a-z]+[A-Z][a-zA-Z0-9]*(Task|Amount|Schedule)\b/,
  /\bcom\.shejiu\./i,
];

const DB_RES = [
  /\b(mysql_query|ads-mysql|mysql mcp)\b/i,
  /\b(select|insert|update|delete)\s+/i,
  /\b(生产库|cloud_test|cloud\b|ads\.)/i,
  /\b(t_[a-z0-9_]{4,})\b/i,
  /(表结构|字段|列名|索引).*(表|库)/,
];

const DOC_HINT_RES = [
  /pitfalls?|踩坑|口径|workflow|handoff|memory|active\.md/i,
  /决策|历史|流程|约定|token[-\s]*budget|规范|规则|标准/i,
  /为什么这么|为何这么|以前|有没有坑|设计原因|为什么.*设计/,
  /分工|contextforge|双引擎|dual[-\s_]*engine|mcp|gate|min[-\s_]*score|search[-\s_]*cache|scope|authority/i,
  /报告|测试|文档|优化|benchmark|audit|report|deploy|install|release/i,
  /设计文档|架构|改造方案|修复|回归|交付|打包|安装/i,
];

export function extractKnownDocPath(query) {
  const raw = String(query || "").trim();
  let m = raw.match(/(?:@|路径[：:]|文件[：:])\s*([\w./\\-]+\.(?:md|mdx|mdc|markdown))\b/i);
  if (m) return m[1].replace(/\\/g, "/");
  m = raw.match(/(?:看看|打开|查看|read)\s+([\w./\\-]+\.(?:md|mdx|mdc))\b/i);
  if (m) return m[1].replace(/\\/g, "/");
  m = raw.match(/\b([\w./\\-]+\.(?:md|mdx|mdc))\s*(?:里|中|的内容|怎么)/i);
  if (m) return m[1].replace(/\\/g, "/");
  // 裸文档名（README / AGENTS 等）+ 文档语境词 → READ 路由（API 层会解析真实路径）
  m = raw.match(/\b(readme|agents|active|quickstart)\b\s*(?:里|中|的|文件|内容|怎么|规定|写了)/i);
  if (m) return `${m[1]}.md`;
  // 裸完整相对路径（整个 query 就是路径或 query 主体是带目录深度的 md 路径，非比较语境）
  if (!/比较|对比|和\s|与\s|vs\.?\b|versus|以及/i.test(raw)) {
    m = raw.match(/^\s*([\w./\\-]+\.(?:md|mdx|mdc))\s*$/i);
    if (m) return m[1].replace(/\\/g, "/");
    // 包含 2+ 层目录 + .md，且不是比较句（像已知文档路径）
    m = raw.match(/\b((?:\w+[\\/]){2,}[\w.\-]+\.(?:md|mdx|mdc))\b/i);
    if (m) return m[1].replace(/\\/g, "/");
  }
  return null;
}

export function extractEvidenceId(query) {
  const q = String(query || "").trim();
  const m = q.match(EVIDENCE_ID_RE);
  if (m) return m[1].toUpperCase();
  const pm = q.match(EVIDENCE_PHRASE_RE);
  if (pm?.[1]) return pm[1].toUpperCase();
  if (/^(F-[0-9A-F]{4,8})$/i.test(q)) return q.toUpperCase();
  return null;
}

function scorePatterns(text, patterns) {
  let score = 0;
  for (const re of patterns) {
    if (re.test(text)) score += 1;
  }
  return score;
}

export function hasDocIntent(raw) {
  return DOC_HINT_RES.some((r) => r.test(raw));
}

/**
 * @returns {{
 *   intent: 'EVIDENCE'|'CODE_ONLY'|'CODE_DOC'|'DB'|'DOC',
 *   evidenceId?: string,
 *   codeScore: number,
 *   dbScore: number,
 *   docHint: boolean,
 * }}
 */
export function classifyQueryIntent(query) {
  const evidenceId = extractEvidenceId(query);
  if (evidenceId) {
    return {
      intent: "EVIDENCE",
      evidenceId,
      codeScore: 0,
      dbScore: 0,
      docHint: false,
    };
  }

  const raw = String(query || "");
  const norm = normalizeQueryForCache(raw);
  const codeScore = scorePatterns(raw + " " + norm, CODE_RES);
  const dbScore = scorePatterns(raw + " " + norm, DB_RES);
  const docHint = hasDocIntent(raw);

  let intent = "DOC";
  if (dbScore >= 2 && dbScore > codeScore) intent = "DB";
  else if (dbScore === 1 && codeScore === 0) intent = "DB";
  else if (codeScore >= 1 && docHint) intent = "CODE_DOC";
  else if (codeScore >= 1) intent = "CODE_ONLY";

  return { intent, codeScore, dbScore, docHint };
}

const OVERVIEW_RES = [
  /(项目|系统|整体|全局|仓库|知识库).*(地图|全貌|概览|结构|架构|介绍|总结|梳理|组织|包含)/,
  /(有哪些|有什么|都有什么|都有哪些).*(内容|文档|文件|资料)/,
  /(目录|文件).*(结构|组织|清单|列表)/,
  /^(项目|系统|仓库)(地图|全貌|概览)/,
  /(总结|梳理|介绍一下).*(整个|全部|项目|系统)/,
  /\boverview\b|\bproject\s*map\b|\blist\s*(all\s*)?files\b/i,
];

/**
 * 概览性问题：需要宽泛上下文，chunk 片段性价比低，应直接 Read 完整文件。
 */
export function isOverviewQuery(query) {
  const q = String(query || "").trim();
  if (!q || q.length > 120) return false;
  return OVERVIEW_RES.some((re) => re.test(q));
}

const PRECISE_RES = [
  /\bP\d{1,4}\b/, // P57
  /#[0-9]{1,6}\b/, // #123
  /\b[A-Z]{2,}-\d{1,6}\b/, // JIRA-123 / F-8A21
  /\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]{5,}\b/, // 长下划线标识符
  /\b[a-z]+[A-Z][a-zA-Z0-9]{3,}\b/, // 长驼峰标识符 publishIndexReady
  /(第\s*\d+\s*(条|点|坑|节|章))/,
];

/**
 * 精确定位查询（含 ID/编号/长标识符）：top_k 收紧 + format=code（只回路径行号）。
 */
export function isPreciseLookup(query) {
  const q = String(query || "").trim();
  if (!q) return false;
  return PRECISE_RES.some((re) => re.test(q));
}

// v1.6.4 §4.1 spec：踩坑类 query 必须 → pitfall scope。
// v1.6.3 旧 spec 故意排除"踩坑"防假阴性 0-hit，但 MCP 层（server.mjs L534-548）已有
// scope 0-hit → 无 scope 自动重查兜底，"防假阴性"已不成立 → 排除是 bug。
// 关键词覆盖 §4.1 列表：踩坑 / 有哪些坑 / 之前踩过什么坑 / 这个功能有什么坑 / 历史踩坑 / 常见坑 等。
// ponytail: 通用语义规则（坑 + 上下文动词），不是 if(query==="踩坑") hardcode。
const PITFALL_STRONG_RE =
  /\bpitfalls?\b|ads-sql|\bP\d{1,4}\b|ADS[_\s-]*红线|VALUES[_\s-]*批量|批量[_\s-]*INSERT|严禁|禁止|SSOT|pitfalls[_\s-]*shejiuPro|踩坑|踩过.*坑|有哪些坑|有什么坑|历史.*坑|常见.*坑|之前.*坑|容易出问题|出过.*问题|出问题的地方/i;

const WORKFLOW_RE = /workflow|流程|handoff|交接|公海|autolink|link_status|seasList/i;
const MEMORY_RE = /memory|active\.md|project_map|知识库?地图/i;
const DAILY_RE = /daily|日报|决策记录|历史记录|(?:\d{6,8})[_\s-]*(?:daily|记录|会议)/i;
const RULE_RE = /\brule\b|token[-\s]*budget|codegraph\.mdc|规范|约定|规则|标准|红线/i;
/** 财账 / finc / 对账类：勿因 query 含「日报」等词收窄到 daily scope（性能工程 doc 在 performance/）。 */
const FINC_ACCOUNTING_RE = /财账|finc\b|backfill|对账|日表|drift/i;

export function inferDocScope(query) {
  const q = String(query || "");
  if (PITFALL_STRONG_RE.test(q)) return "pitfall";
  if (WORKFLOW_RE.test(q)) return "workflow";
  if (MEMORY_RE.test(q)) return "memory";
  if (FINC_ACCOUNTING_RE.test(q)) return undefined;
  if (DAILY_RE.test(q)) return "daily";
  if (RULE_RE.test(q)) return "rule";
  return undefined;
}
