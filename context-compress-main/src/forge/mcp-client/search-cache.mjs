import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isRelease } from "./lib/release.mjs";
import { normalizeQueryForCache } from "./lib/query-normalize.mjs";

// Bump when: scope/authority/rerank/gate policy changes → local cache auto invalidates.
// Matches src/lib/search-cache.mjs POLICY_VERSION concept (value intentionally aligned by suffix).
const POLICY_VERSION = "v8-scope-unified-auth-decoupled";

const MAX = isRelease()
  ? 128
  : Number(process.env.TOKEN_SKILL_LOCAL_CACHE_MAX || 128);
const enabled = () =>
  isRelease() ? true : process.env.TOKEN_SKILL_LOCAL_CACHE !== "0";

const diskEnabled = () =>
  process.env.TOKEN_SKILL_DISK_CACHE === "1" ||
  (isRelease() && process.env.TOKEN_SKILL_DISK_CACHE !== "0");

const DISK_MAX = Number(process.env.TOKEN_SKILL_DISK_CACHE_MAX || 96);

/** @type {Map<string, { text: string, version: number }>} */
const mem = new Map();

let knownVersion = 0;

function diskPath() {
  const base =
    process.env.TOKEN_SKILL_DISK_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "token-skill");
  return path.join(base, "search-cache.json");
}

function loadDisk() {
  if (!diskEnabled()) return {};
  try {
    const raw = fs.readFileSync(diskPath(), "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveDisk(data) {
  if (!diskEnabled()) return;
  try {
    const file = diskPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
  } catch {
    /* best-effort */
  }
}

export function noteIndexVersion(v) {
  const n = Number(v) || 0;
  if (n > knownVersion) knownVersion = n;
}

export function invalidateLocalSearchCache() {
  mem.clear();
  if (diskEnabled()) saveDisk({});
}

function paramsHash(projectId, query, opts) {
  const normQ = normalizeQueryForCache(query);
  // Align "pitfalls" → "pitfall" in cache key (same scope normalization as server).
  // Adding POLICY_VERSION explicitly so policy/rank/scope changes invalidate local cache too
  // (POLICY_VERSION changes when rerank/gate formulas change; index version handles content).
  const rawScope = opts.scope ?? "";
  const scope =
    rawScope === "pitfalls"
      ? "pitfall"
      : rawScope;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        project_id: String(projectId || ""),
        q: normQ,
        raw_len: String(query).trim().length,
        top_k: opts.top_k ?? 5,
        min_score: opts.min_score ?? 0.15,
        scope,
        max_tokens: opts.max_tokens ?? 0,
        search_mode: opts.format ?? "",
        policy_version: POLICY_VERSION,
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

function key(projectId, version, query, opts) {
  return `${projectId}/v${version}/${paramsHash(projectId, query, opts)}`;
}

/** @internal benchmark / tests */
export function buildSearchCacheKey(projectId, version, query, opts) {
  return key(projectId, version, query, opts);
}

/** @returns {string|null} formatted hit text */
export function getLocalSearchCache(projectId, query, opts) {
  if (!enabled() || knownVersion < 1) return null;
  const k = key(projectId, knownVersion, query, opts);
  const hit = mem.get(k);
  if (hit?.text) return hit.text;
  if (!diskEnabled()) return null;
  const disk = loadDisk();
  const row = disk[k];
  if (row?.text && Number(row.version) === knownVersion) {
    mem.set(k, { text: row.text, version: knownVersion });
    return row.text;
  }
  return null;
}

export function getKnownIndexVersion() {
  return knownVersion;
}

export function searchFlightKeyLocal(projectId, query, opts) {
  if (knownVersion < 1) return null;
  return `${projectId}/v${knownVersion}/${paramsHash(projectId, query, opts)}`;
}

/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

export function coalesceLocalSearch(flightKey, fn) {
  if (!flightKey) return fn();
  const pending = inflight.get(flightKey);
  if (pending) return pending;
  const p = fn().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

export function setLocalSearchCache(projectId, version, query, opts, text) {
  if (!enabled()) return;
  noteIndexVersion(version);
  const k = key(projectId, knownVersion, query, opts);
  mem.set(k, { text, version: knownVersion });
  while (mem.size > MAX) {
    const first = mem.keys().next().value;
    if (first === undefined) break;
    mem.delete(first);
  }
  if (!diskEnabled()) return;
  const disk = loadDisk();
  disk[k] = { text, version: knownVersion, at: Date.now() };
  const keys = Object.keys(disk);
  if (keys.length > DISK_MAX) {
    keys
      .sort((a, b) => (disk[a].at || 0) - (disk[b].at || 0))
      .slice(0, keys.length - DISK_MAX)
      .forEach((dk) => delete disk[dk]);
  }
  saveDisk(disk);
}
