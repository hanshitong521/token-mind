/**
 * 负节约旁路：信封比正文还长且未截断时，只交正文。
 * @param {{ body: string, evidence_ids?: string[], truncated?: boolean, key_facts?: Record<string, unknown> }} opts
 * @param {(s: string) => number} estimateTokens
 */
export function wrapIfSaves(opts, estimateTokens) {
  const body = String(opts?.body || "");
  if (opts?.truncated) return formatGateEnvelope(opts);
  const env = formatGateEnvelope(opts);
  if (typeof estimateTokens !== "function") return env;
  if (estimateTokens(env) >= estimateTokens(body)) return body;
  return env;
}

export function formatGateEnvelope(opts) {
  const ids = (opts.evidence_ids || []).filter(Boolean);
  const lines = [
    "[GATE]",
    `evidence_ids: ${ids.length ? ids.join(", ") : "none"}`,
    `truncated: ${opts.truncated ? "true" : "false"}`,
  ];
  if (opts.key_facts && Object.keys(opts.key_facts).length) {
    lines.push(`key_facts: ${JSON.stringify(opts.key_facts)}`);
  }
  lines.push("hint: use get_evidence(id) to expand; do not re-read same resource_id.");
  return `${lines.join("\n")}\n\n${opts.body}`;
}

export function extractEvidenceIds(text) {
  const s = String(text || "");
  const found = new Set();
  for (const m of s.matchAll(/\bF-[A-F0-9]{4}\b/g)) found.add(m[0]);
  return [...found];
}
