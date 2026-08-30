/**
 * Corpus digest + index manifest hash (Phase A SSOT).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

function sha256Hex(bufOrStr) {
  const h = crypto.createHash("sha256");
  if (typeof bufOrStr === "string") h.update(bufOrStr, "utf8");
  else h.update(bufOrStr);
  return h.digest("hex");
}

function normalizeRelPath(rel) {
  return String(rel || "").replace(/\\/g, "/").normalize("NFC");
}

/**
 * @param {string} rawRoot absolute path to project raw/ tree
 */
export function computeCorpusDigest(rawRoot) {
  if (!rawRoot || !fs.existsSync(rawRoot)) {
    return { digest: null, file_count: 0 };
  }
  const files = [];
  const stack = [rawRoot];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) files.push(p);
    }
  }
  files.sort((a, b) =>
    normalizeRelPath(path.relative(rawRoot, a)).localeCompare(
      normalizeRelPath(path.relative(rawRoot, b)),
    ),
  );
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const rel = normalizeRelPath(path.relative(rawRoot, f));
    const contentHash = sha256Hex(fs.readFileSync(f));
    h.update(rel);
    h.update("\0");
    h.update(contentHash);
    h.update("\n");
  }
  return { digest: h.digest("hex"), file_count: files.length };
}

/** Deterministic JSON for manifest hash (sorted keys, no whitespace). */
function canonicalJsonString(obj) {
  const sortKeys = (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(sortKeys(obj));
}

/**
 * @param {Record<string, string|number>} fields mandatory manifest fields (no nulls)
 */
export function computeIndexManifestHash(fields) {
  const required = [
    "schema_version",
    "scope_policy_version",
    "chunker_version",
    "embed_model",
    "embed_dimension",
    "retrieval_profile",
    "ingest_policy_version",
    "corpus_digest",
    "document_count",
    "chunk_count",
  ];
  for (const k of required) {
    if (fields[k] === undefined || fields[k] === null) {
      throw new Error(`MANIFEST_INCOMPLETE: missing ${k}`);
    }
  }
  const payload = {};
  for (const k of required) {
    payload[k] = fields[k];
  }
  return sha256Hex(canonicalJsonString(payload));
}
