/**
 * v1.7 P0-A 元文档角色与权威性策略（doc §4-§8）。
 *
 * 集中管理 doc_role 路径推导 + scope-aware authority 权重表。
 * 单点配置，避免散落多文件（doc §6 要求）。
 *
 * ponytail: 当前采用「检索时按 path 实时推导」方案，不侵入 ingest。
 *   - 优点：零 rebuild 成本，老索引立即受益，单点修改
 *   - 升级路径：若 chunk 已带 doc_role/authority metadata（ingest 持久化），
 *     deriveDocRole 会优先用 chunk 自带值，路径推导只作兜底
 */

// doc §6 权重表：scope=pitfall 下的 source role 初始权重
const ROLE_AUTHORITY_BY_SCOPE = {
  pitfall: {
    knowledge_ssot: 1.0,
    canonical_doc: 0.95,
    engineering_doc: 0.9,
    daily: 0.7,
    report: 0.4,
    test_report: 0.25,
    benchmark: 0.2,
    generated_artifact: 0.1,
    archive: 0.05,
    unknown: 0.5,
  },
  // v1.6.4 §4.3 S10：default scope（query 无明确 scope 时）轻度压权 daily。
  // v1.6.3 default={} → daily 与 SSOT/canonical/memory 同 1.0 → daily 凭文本相似度
  // 抢 Top-1（如 "finc drift" 命中 prod-backfill-brand-link-status.md 而非 project_map.md）。
  // 不能粗暴降 daily 全部权（§4.3 禁止），故只 -0.15（bonus -0.0225）。
  // 真正"与 Query Domain 强相关"的 daily 文本相似度通常更高，仍可保留 Top-1；
  // 无关 daily 凭弱文本相似度抢 Top-1 时被这 0.0225 翻转。
  // ponytail: 一行 entry，零新 framework；不做 domain classifier（§2.1 禁）。
  default: {
    daily: 0.85,
    engineering_doc: 0.9,
    report: 0.88,
    test_report: 0.75,
    benchmark: 0.75,
    generated_artifact: 0.55,
  },
  all: {},
  architecture: {},
};

// doc §7 路径推导规则：显式 metadata > 路径推导 > 默认 unknown
// 顺序敏感：先匹配的优先。文件名模式更具体，放目录规则前（否则 daily/test-report.md 先匹配 daily/）
const PATH_RULES = [
  // P0-2A: PITFALL SSOT 文件名精确匹配 — 必须放在宽泛 skills/ 规则前面。
  // 真实 SSOT 路径：`.cursor/skills/ads-sql/pitfalls-shejiuPro.md`，没有 pitfall/ 目录。
  { re: /(?:^|\/)pitfalls?-shejiuPro\.md$/i, role: "knowledge_ssot" },
  // v1.6.6-rc: Cursor policy / rules SSOT (F09/F11/F10 — avoid handoff & meta docs)
  { re: /(?:^|\/)docs\/agents\/editor[_-]?policy\.md$/i, role: "knowledge_ssot" },
  { re: /(?:^|\/)agents\.md$/i, role: "engineering_doc" },
  // test_report 文件名优先于 contextforge-*-token-accuracy 等 benchmark 规则
  { re: /test[-_ ]?report|audit[-_ ]?report|doctor[-_ ]?report|verification[-_ ]?report|验收报告|测试报告|审计报告/i, role: "test_report" },
  { re: /test[-_]?report/i, role: "test_report" },
  // v1.6.6-rc S10: release/evidence 验收产物勿抢业务 Top-1（见 05-s10-forensics.md）
  { re: /(^|\/)docs\/evidence\//i, role: "generated_artifact" },
  { re: /contextforge-v\d+[-_].*closure[-_]?pack/i, role: "generated_artifact" },
  { re: /contextforge-v\d+[-_].*(?:upgrade-test|efficiency|token-accuracy|rc-upgrade)/i, role: "benchmark" },
  { re: /(^|\/)docs\/performance\//i, role: "engineering_doc" },
  { re: /shejiu-core\.mdc$/i, role: "canonical_doc" },
  { re: /(^|\/)\.cursor\/rules\//i, role: "canonical_doc" },
  { re: /workflows-quick\.md$/i, role: "canonical_doc" },
  { re: /cursor-handoff\.md$/i, role: "daily" },
  // ============================================================
  // v1.6.4 P0.9（规范 §23-24）：Index Pollution 排除层
  // 不是硬编码「contextforge-v140-token-accuracy-test-report.md」这个单文件名，
  // 而是产品规则：凡属于 test_report / benchmark / generated_artifact 的文件，
  // 不得抢占 SSOT / knowledge / canonical 的权威池。
  // 规则表达（由 PATH_RULES 先命中）+ authority 表（压权）+ shouldExcludeFromProductionIndex()（供 doctor/ingest 调）三层配合。
  // ============================================================
  { re: /(^|\/)bench(?:marks?)?\/|bench[-_ ]?mark|session[-_ ]?replay|golden[-_ ]?path|bench[-_ ]?agent/i, role: "benchmark" },
  { re: /generated[-_ ]?artifact|build[-_ ]?output|(^|\/)output\/|replay[-_ ]?result|preflight[-_ ]?report/i, role: "generated_artifact" },
  { re: /(^|\/)tmp\/|\.tmp\.|\.swp$|\.bak$|~$|(^|\/)\.Trash\//i, role: "archive" },
  // 文件名模式（不依赖目录）—— 更具体，优先
  { re: /(^|\/)benchmarks?\//i, role: "benchmark" },
  { re: /benchmark/i, role: "benchmark" },
  { re: /generated[-_]?artifact/i, role: "generated_artifact" },
  // 目录规则
  { re: /(^|\/)pitfalls?\//i, role: "knowledge_ssot" },
  { re: /(^|\/)rules?\//i, role: "canonical_doc" },
  // v1.6.4 §4.3 S10：memory/ 目录（project_map.md / ACTIVE.md 等）= 项目路由 SSOT，
  // 原落 unknown（authority 1.0 default）→ 与 daily 同权，被 daily 抢 Top-1。
  // 归 canonical_doc 让 search-role-policy 识别为权威文档。
  // ponytail: 仅加 path rule，零新 scope；canonical_doc 在 default scope 不抬权（1.0），
  //          但与 daily(0.85) 形成 0.0225 bonus 差，daily 被压权。
  { re: /(^|\/)memory\//i, role: "canonical_doc" },
  { re: /(^|\/)architecture\//i, role: "engineering_doc" },
  { re: /(^|\/)daily\//i, role: "daily" },
  { re: /(^|\/)reports?\//i, role: "report" },
  { re: /(^|\/)performance\//i, role: "report" }, // v1.6.6: performance/ 目录含财账/ADS/brandHandle 等性能优化 report
  { re: /(^|\/)archive\//i, role: "archive" },
];

const DEFAULT_ROLE = "unknown";

/**
 * v1.6.4 P0.9（规范 §24）：产品化排除规则 —— 回答「为什么这个文件不能进入 production index？」。
 *
 * 不是硬编码单个文件名，而是用 doc_role 类别表达策略：
 *   - test_report / benchmark / generated_artifact : 元产物 / 自测输出 / 报告 ——
 *     可以检索到（让开发/测试查自己的报告），但永远不能与 SSOT 抢权威。
 *     因此这里返回 {exclude:false, polluteSignal:true} —— 只做「压权/污染警告」，
 *     不做「直接丢弃」（否则会让用户搜不到自己写的报告，反而更糟）。
 *   - archive / tmp : 旧归档 / 临时文件，可标记 exclude 建议（默认不主动排除，
 *     因为用户放 archive 可能真要偶尔查；由 ingest 或用户手动开启 strict 模式才真排除）。
 *
 * @param {string} filePath
 * @param {{strict?:boolean}} [opts]
 * @returns {{exclude:boolean, polluteSignal:boolean, doc_role:string, reason:string}}
 */
export function shouldExcludeFromProductionIndex(filePath, opts = {}) {
  const { doc_role } = deriveDocRole({ path: filePath });
  // 低权威但不直接排除：允许用户检索自己的报告，但会被 authorityBonus 压权 + doctor 标污染警告
  const LOW_AUTH_ROLES = new Set(["test_report", "benchmark", "generated_artifact"]);
  if (LOW_AUTH_ROLES.has(doc_role)) {
    return {
      exclude: false,
      polluteSignal: true,
      doc_role,
      reason: `low-authority meta-artifact (${doc_role}) — indexed but de-ranked via authorityBonus in scoped queries`,
    };
  }
  // archive/tmp：strict 模式才排除（默认保留，符合「不主动删用户数据」原则）
  if (doc_role === "archive") {
    return {
      exclude: !!opts.strict,
      polluteSignal: !!opts.strict,
      doc_role,
      reason: opts.strict ? "archive excluded by strict policy" : "archive retained (opt-in strict mode)",
    };
  }
  return {
    exclude: false,
    polluteSignal: false,
    doc_role,
    reason: "default — not a pollution signal",
  };
}

/**
 * 推导单个 chunk 的 doc_role + authority。
 * 优先用 chunk 自带 metadata（未来 ingest 持久化路径），否则按 path 推导。
 *
 * @param {{path?: string, doc_role?: string, authority?: number}} chunk
 * @returns {{doc_role: string, authority: number}}
 */
export function deriveDocRole(chunk) {
  if (chunk?.doc_role && chunk?.authority != null) {
    return { doc_role: chunk.doc_role, authority: chunk.authority };
  }
  const normPath = String(chunk?.path || "").replace(/\\/g, "/");
  let role = DEFAULT_ROLE;
  for (const rule of PATH_RULES) {
    if (rule.re.test(normPath)) {
      role = rule.role;
      break;
    }
  }
  // 默认 scope=default 时 authority 统一 1.0（不偏置）
  const authority = 1.0;
  return { doc_role: role, authority };
}

/**
 * 计算 scope-aware authority bonus。
 *
 * doc §5 公式：final_score = semantic*0.55 + lexical*0.15 + authority*0.20 + source_role*0.10
 * 但本仓已有 twoStageRerank 的成熟融合公式（vector/lex/heading/path/identity），
 * 不能整体替换，否则回退 G1~G5。
 *
 * ponytail: 最小侵入做法 —— authority 作为独立加性 bonus，仅在 scope=pitfall 时启用。
 *   bonus = AUTHORITY_BONUS_WEIGHT * (authority - 1.0)
 *   authority=1.0 → bonus=0（不变）；authority<1.0 → bonus<0（降权 test_report 等）
 *   authority>1.0 不存在（上限 1.0），故不会不公平抬升
 *
 * 这样 pitfall SSOT（authority=1.0）原分不变，test_report（0.25）被压 0.75*WEIGHT。
 */
export const AUTHORITY_BONUS_WEIGHT = 0.15;

export function authorityBonus(chunk, scope) {
  const table = ROLE_AUTHORITY_BY_SCOPE[scope] || ROLE_AUTHORITY_BY_SCOPE.default;
  if (!table || Object.keys(table).length === 0) return 0;
  const { doc_role, authority } = deriveDocRole(chunk);
  const scopedAuthority = table[doc_role] ?? authority;
  return AUTHORITY_BONUS_WEIGHT * (scopedAuthority - 1.0);
}

/**
 * 批量附加 doc_role/authority 到候选列表（用于 /v1/search 输出 candidates 元数据）。
 * 不修改原 chunk，返回新对象。
 */
export function annotateRoleMetadata(hits, scope) {
  const table = ROLE_AUTHORITY_BY_SCOPE[scope] || ROLE_AUTHORITY_BY_SCOPE.default;
  return hits.map((h) => {
    const { doc_role, authority } = deriveDocRole(h);
    const scopedAuthority = table[doc_role] ?? authority;
    return { ...h, doc_role, authority: scopedAuthority };
  });
}
