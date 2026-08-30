/**
 * L0 文档误读陷阱：禁止 Agent 整读 workflows / pitfalls 等，改走 Forge 或 quick SSOT。
 * API 路由、MCP query-gate、token 归因、Cursor hook 共用。
 */

/** @typedef {{ kind: string, baseline_tokens: number, redirect: string, agent_hint: string }} DocReadTrap */

const BASELINE = {
  workflows_full: 5284,
  pitfalls_ssot: 5118,
  pitfalls_legacy: 143,
  ads_reference: 3500,
};

/**
 * @param {string} path
 */
export function normalizeDocPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * @param {string} path
 * @returns {DocReadTrap | null}
 */
export function getTrapForPath(path) {
  const p = normalizeDocPath(path);
  if (!p) return null;

  if (
    (p.endsWith("workflows.md") || p.includes("/workflows.md")) &&
    !p.includes("workflows-quick")
  ) {
    return {
      kind: "workflows_full",
      baseline_tokens: BASELINE.workflows_full,
      redirect: ".cursor/reference/workflows-quick.md",
      agent_hint:
        "禁整读 workflows.md → semantic_search（业务词）或 Read workflows-quick.md（≤120 行）。",
    };
  }
  if (p.includes("pitfalls-shejiupro.md")) {
    return {
      kind: "pitfalls_ssot",
      baseline_tokens: BASELINE.pitfalls_ssot,
      redirect: "semantic_search + pitfalls SSOT 单行追加",
      agent_hint:
        "禁整读 pitfalls-shejiuPro.md → semantic_search；仅允许当轮 +1 行 pitfall。",
    };
  }
  if (p.includes("docs/agents/pitfalls.md")) {
    return {
      kind: "pitfalls_legacy",
      baseline_tokens: BASELINE.pitfalls_legacy,
      redirect: ".cursor/skills/ads-sql/pitfalls-shejiuPro.md（单行）",
      agent_hint: "禁 Read docs/agents/pitfalls.md → Forge 或 SSOT 单行。",
    };
  }
  if (p.includes("ads-sql/reference/") || p.includes(".cursor/skills/ads-sql/reference/")) {
    return {
      kind: "ads_reference",
      baseline_tokens: BASELINE.ads_reference,
      redirect: "semantic_search 或单分册 @attach",
      agent_hint: "禁整读 ads-sql/reference/** → Forge 或单轮一分册。",
    };
  }
  if (p.endsWith("workflows.md") && p.includes("reference")) {
    return getTrapForPath(".cursor/reference/workflows.md");
  }
  return null;
}

/**
 * @param {string} path
 */
export function isTrapDocPath(path) {
  return getTrapForPath(path) != null;
}

/**
 * @param {Array<{ path?: string, p?: string, fl?: number }>} hits
 */
export function estimateAvoidedFullReadTokens(hits) {
  let best = 0;
  for (const h of hits || []) {
    const raw = h.p ?? h.path ?? "";
    const trap = getTrapForPath(raw);
    if (trap) {
      best = Math.max(best, trap.baseline_tokens);
      continue;
    }
    const fl = Number(h.fl);
    if (Number.isFinite(fl) && fl > 0) {
      best = Math.max(best, Math.ceil(fl * 10));
    }
  }
  return best;
}

export function trapDocRouteMessage(path) {
  const trap = getTrapForPath(path);
  const p = String(path || "").replace(/\\/g, "/");
  if (!trap) {
    return [
      "NO_SEARCH",
      "route: READ",
      `path: ${p}`,
      "Named doc file — use IDE Read or @path; semantic_search wastes tokens vs read_file.",
    ].join("\n");
  }
  return [
    "NO_SEARCH",
    "route: FORGE_NOT_READ",
    `trap: ${trap.kind}`,
    `path: ${p}`,
    `redirect: ${trap.redirect}`,
    trap.agent_hint,
    "Do not Read this file in full; retry semantic_search with business terms.",
  ].join("\n");
}
