/**
 * 轻量 query 归一化，用于 search cache key（非 embedding）。
 */
export function normalizeQueryForCache(query) {
  let q = String(query || "")
    .toLowerCase()
    .normalize("NFKC");
  q = q.replace(/[\s？?！!。，,、；;：:]+/g, " ");
  q = q.replace(
    /\b(为什么|为何|怎么|如何|什么|啥|请问|帮我|一下|吗)\b/g,
    " ",
  );
  q = q.replace(/\s+/g, " ").trim();
  return q || String(query || "").trim().toLowerCase();
}
