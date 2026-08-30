/**
 * Unified doc scope enum + normalization.
 * Single source of truth for query intent, file scoping, index filter.
 * Legacy alias support: "pitfalls" -> "pitfall" (old index compatibility)
 */

// P0-06（规范 §16）：scope policy version。
// classifyFileScope 规则变更（新增/修改 scope 分类模式）时 bump，rebuild 写入 meta，
// 启动校验 meta.scope_policy_version !== 当前 → 标 stale（旧索引 scope 可能与新策略不一致）。
// v2: ingest path-policy SSOT（§15 path classifier + ingest YAML）
export const SCOPE_POLICY_VERSION = "v2-20260827-ingest";

export const DOC_SCOPES = Object.freeze({
  PITFALL: "pitfall",
  WORKFLOW: "workflow",
  MEMORY: "memory",
  DAILY: "daily",
  RULE: "rule",
  SKILLS: "skills",
  OTHER: "other",
});

export const VALID_DOC_SCOPES = new Set(Object.values(DOC_SCOPES));

// Old aliases -> canonical name. Used to read legacy index without rebuild.
const SCOPE_ALIASES = Object.freeze({
  pitfalls: DOC_SCOPES.PITFALL,
  pitfall: DOC_SCOPES.PITFALL,
  workflow: DOC_SCOPES.WORKFLOW,
  handoff: DOC_SCOPES.WORKFLOW,
  memory: DOC_SCOPES.MEMORY,
  daily: DOC_SCOPES.DAILY,
  rule: DOC_SCOPES.RULE,
  skills: DOC_SCOPES.SKILLS,
  other: DOC_SCOPES.OTHER,
});

export function normalizeDocScope(scope) {
  if (!scope) return undefined;
  const key = String(scope).toLowerCase().trim();
  const normalized = SCOPE_ALIASES[key] || key;
  return VALID_DOC_SCOPES.has(normalized) ? normalized : undefined;
}

/**
 * Classify a chunk file path into one of DOC_SCOPES.
 * Order matters: PITFALL SSOT patterns before broad directory matches.
 * e.g. `.cursor/skills/ads-sql/pitfalls-shejiuPro.md` → pitfall (not skills)
 * because PITFALL SSOT is the primary business role of the file.
 */
export function classifyFileScope(relPath) {
  const p = String(relPath || "").replace(/\\/g, "/");
  // 1. PITFALL SSOT first (filename pattern or pitfall directory / pitfall- stemmed file)
  if (/(?:^|\/)pitfalls?-shejiuPro\.md$/i.test(p)) return DOC_SCOPES.PITFALL;
  if (/(^|\/)pitfalls?(\/|\.md$)/i.test(p) || /pitfall/i.test(p)) return DOC_SCOPES.PITFALL;
  // 2. WORKFLOW / handoff
  if (/(^|\/)workflows?(\/|$)|handoff|交接|公海.*流程|(autolink|link_status|seasList).*\.md$/i.test(p))
    return DOC_SCOPES.WORKFLOW;
  // 3. MEMORY / project memory
  if (/(^|\/)memory\/|active\.md$|project_map/i.test(p)) return DOC_SCOPES.MEMORY;
  // 4. DAILY
  if (/(^|\/)daily\/|日报|决策记录|\d{6,8}[_-]*(?:daily|记录|会议)[^/]*\.md$/i.test(p))
    return DOC_SCOPES.DAILY;
  // 5. RULE
  if (/(^|\/)rules?\/|token[-_ ]?budget|codegraph\.mdc$|规范|约定|规则|标准|红线/i.test(p))
    return DOC_SCOPES.RULE;
  // 6. SKILLS (broader, after pitfall/workflow which might live under skills/)
  if (/(^|\/)skills?\//i.test(p)) return DOC_SCOPES.SKILLS;
  return DOC_SCOPES.OTHER;
}

/**
 * P0-07（规范 §15）：Effective Scope SSOT。
 * 持久化 chunk.scope 只是 cache；文件路径分类（classifyFileScope）才是 authority。
 *
 * v1.6.3 真 bug 根因：旧索引 chunk.scope 可能错（旧 enum/旧 classifier 逻辑），
 * 但文件路径未变 → 检索过滤若直接信 chunk.scope，path=pitfall 但 scope=other → 0 hit。
 *
 * 策略：path classifier 优先。path 归为 OTHER 时，fallback 到持久化 scope
 * （保留旧索引价值，避免 path 模式未覆盖的文件全丢）。path 能分类为具体 scope 时，
 * 永远以 path 为准——这正是「路径分类 = SSOT，持久化 = cache」语义。
 *
 * @param {{path?: string, scope?: string}|undefined} chunk
 * @returns {string} DOC_SCOPES 值（永远有值，最差 OTHER）
 */
export function effectiveChunkScope(chunk) {
  return effectiveChunkScopeMeta(chunk).scope;
}

/**
 * v1.6.4 P0.8（规范 §7）：带 scopeSource 元数据的 effective scope。
 * scopeSource 可诊断「结果来源」，未来出现旧 metadata 依赖时能追溯。
 *
 * scopeSource 取值：
 *   "path-classification" : path 能明确分类（path SSOT）
 *   "persisted-fallback"  : path=OTHER，但持久化 scope 有效（兼容旧索引）
 *   "default-other"       : 两者都无，退化为 OTHER
 *
 * @param {{path?: string, scope?: string}|undefined} chunk
 * @returns {{scope: string, scopeSource: "path-classification"|"persisted-fallback"|"default-other"}}
 */
export function effectiveChunkScopeMeta(chunk) {
  const pathScope = classifyFileScope(chunk?.path);
  if (pathScope !== DOC_SCOPES.OTHER) {
    return { scope: pathScope, scopeSource: "path-classification" };
  }
  if (chunk?.scope_source === "path-policy") {
    const s = normalizeDocScope(chunk.scope) || DOC_SCOPES.OTHER;
    return { scope: s, scopeSource: "path-classification" };
  }
  const persisted = normalizeDocScope(chunk?.scope);
  if (persisted && persisted !== DOC_SCOPES.OTHER) {
    return { scope: persisted, scopeSource: "persisted-fallback" };
  }
  return { scope: DOC_SCOPES.OTHER, scopeSource: "default-other" };
}

