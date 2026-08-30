import crypto from "crypto";

/** @typedef {"REUSED" | "UNCHANGED" | "PARTIAL_DELTA" | "NEW_CONTENT" | "DUPLICATE_SUPPRESSED"} DedupStatus */

const MAX_ENTRIES = Number(process.env.TOKEN_SKILL_DEDUP_MAX || 128);

/**
 * @typedef {{
 *   resource_id: string,
 *   content_hash: string,
 *   body: string,
 *   context_id: string,
 *   range?: string,
 *   updated_at: number,
 * }} DedupEntry
 */

/** @type {Map<string, DedupEntry>} */
const byResource = new Map();
/** @type {Map<string, string>} content_hash -> context_id */
const byHash = new Map();

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

function trimStore() {
  while (byResource.size > MAX_ENTRIES) {
    const first = byResource.keys().next().value;
    if (first === undefined) break;
    const old = byResource.get(first);
    if (old) byHash.delete(old.content_hash);
    byResource.delete(first);
  }
}

/**
 * @param {string} resource_id
 * @param {string} body
 * @param {{ range?: string, forceNew?: boolean }} [opts]
 */
export function registerDeliveredContent(resource_id, body, opts = {}) {
  const rid = String(resource_id || "unknown").trim();
  const content_hash = sha256(body);
  const prev = byResource.get(rid);

  if (!opts.forceNew && prev && prev.content_hash === content_hash) {
    return {
      status: /** @type {DedupStatus} */ ("UNCHANGED"),
      context_id: prev.context_id,
      resource_id: rid,
      content_hash,
      delivered: false,
      message: `status: UNCHANGED | context_id: ${prev.context_id} | resource: ${rid} | hash: ${content_hash}`,
    };
  }

  const dupId = byHash.get(content_hash);
  if (!opts.forceNew && dupId && (!prev || prev.context_id !== dupId)) {
    return {
      status: /** @type {DedupStatus} */ ("DUPLICATE_SUPPRESSED"),
      context_id: dupId,
      resource_id: rid,
      content_hash,
      delivered: false,
      message: `status: DUPLICATE_SUPPRESSED | reuse context_id: ${dupId} | resource: ${rid} | hash: ${content_hash}`,
    };
  }

  const context_id = `ctx_${crypto.randomBytes(3).toString("hex")}`;
  const entry = {
    resource_id: rid,
    content_hash,
    body: String(body),
    context_id,
    range: opts.range,
    updated_at: Date.now(),
  };
  if (prev) byHash.delete(prev.content_hash);
  byResource.set(rid, entry);
  byHash.set(content_hash, context_id);
  trimStore();

  const status =
    prev && prev.content_hash !== content_hash
      ? /** @type {DedupStatus} */ ("PARTIAL_DELTA")
      : /** @type {DedupStatus} */ ("NEW_CONTENT");

  return {
    status,
    context_id,
    resource_id: rid,
    content_hash,
    delivered: true,
    message: `status: ${status} | context_id: ${context_id} | resource: ${rid} | hash: ${content_hash}`,
  };
}

/**
 * Before sending tool output to the agent — detect exact duplicate delivery.
 * @param {string} resource_id
 * @param {string} body
 */
export function checkBeforeDeliver(resource_id, body) {
  const rid = String(resource_id || "unknown").trim();
  const content_hash = sha256(body);
  const prev = byResource.get(rid);
  if (prev && prev.content_hash === content_hash) {
    return {
      status: /** @type {DedupStatus} */ ("REUSED"),
      context_id: prev.context_id,
      resource_id: rid,
      content_hash,
      delivered: false,
      message: `status: REUSED | context_id: ${prev.context_id} | resource: ${rid} | hash: ${content_hash}\naction: content already in session context; do not re-read unless user asks for refresh.`,
    };
  }
  const dupId = byHash.get(content_hash);
  if (dupId) {
    return {
      status: /** @type {DedupStatus} */ ("DUPLICATE_SUPPRESSED"),
      context_id: dupId,
      resource_id: rid,
      content_hash,
      delivered: false,
      message: `status: DUPLICATE_SUPPRESSED | reuse context_id: ${dupId} | same hash as prior delivery`,
    };
  }
  return null;
}

export function clearDedupStore() {
  byResource.clear();
  byHash.clear();
}

/** @param {string} resource_id */
export function getStoredBody(resource_id) {
  const row = byResource.get(String(resource_id || "").trim());
  return row?.body ?? null;
}
