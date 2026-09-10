/**
 * Adapter result cache (Cursor efficiency).
 *
 * Mirrors work-mind slim: in-process LRU first, SQLite for MCP restart,
 * Redis only when CONTEXTMIND_REDIS_URL / cache.redis_url is set (fail-open).
 * Used to skip CodeGraph CLI on a repeat query — Output Gate dedup still
 * runs after a miss; this layer is *before* the expensive spawn.
 *
 * No npm client: Redis is a tiny RESP GET/SET over node:net.
 */

import { createHash } from "node:crypto";
import { connect } from "node:net";
import { normalizeOrientQuery } from "./orient-key.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS result_cache (
  cache_key   TEXT PRIMARY KEY,
  handle_id   TEXT,
  source      TEXT,
  raw_tokens  INTEGER NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  expires_at  TEXT
);
`;

function shaKey(...parts) {
	return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

/** Same collapse as orient DUP keys so FQCN / short name share one adapter cache entry. */
export function normalizeAdapterQuery(query) {
	return normalizeOrientQuery(query);
}

export function adapterCacheKey(toolName, query) {
	return shaKey("adapter", toolName, normalizeAdapterQuery(query));
}

export function fetchCacheKey(handle, selector) {
	const sel = selector && typeof selector === "object" ? selector : {};
	const start = sel.start != null && sel.start !== "" ? Number(sel.start) : null;
	const end = sel.end != null && sel.end !== "" ? Number(sel.end) : null;
	const payload = JSON.stringify({
		start: Number.isFinite(start) ? start : null,
		end: Number.isFinite(end) ? end : null,
		pattern: sel.pattern != null ? String(sel.pattern) : null,
		jsonPath: sel.jsonPath != null ? String(sel.jsonPath) : null,
		maxLines: sel.maxLines != null && Number.isFinite(Number(sel.maxLines)) ? Number(sel.maxLines) : null,
	});
	return shaKey("fetch", String(handle ?? "").trim().toLowerCase(), payload);
}

function parseRedisUrl(url) {
	try {
		const u = new URL(url);
		if (u.protocol !== "redis:" && u.protocol !== "rediss:") return null;
		return {
			host: u.hostname || "127.0.0.1",
			port: Number(u.port) || 6379,
			db: Number(u.pathname.replace("/", "") || 0) || 0,
			tls: u.protocol === "rediss:",
		};
	} catch {
		return null;
	}
}

function encodeResp(args) {
	let out = `*${args.length}\r\n`;
	for (const a of args) {
		const s = String(a);
		out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
	}
	return out;
}

function decodeBulk(buf) {
	const text = buf.toString("utf8");
	if (text.startsWith("$-1")) return null;
	if (text.startsWith("-")) return null;
	if (text.startsWith("+")) return text.slice(1).split("\r\n")[0];
	if (text.startsWith("$")) {
		const nl = text.indexOf("\r\n");
		const len = Number(text.slice(1, nl));
		if (!Number.isFinite(len) || len < 0) return null;
		return text.slice(nl + 2, nl + 2 + len);
	}
	return null;
}

function redisCall(parsed, args, timeoutMs = 40) {
	return new Promise((resolve) => {
		const sock = connect({ host: parsed.host, port: parsed.port });
		const chunks = [];
		const done = (v) => {
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(v);
		};
		const t = setTimeout(() => done(null), timeoutMs);
		sock.setNoDelay(true);
		sock.on("error", () => {
			clearTimeout(t);
			done(null);
		});
		sock.on("data", (c) => chunks.push(c));
		sock.on("end", () => {
			clearTimeout(t);
			done(decodeBulk(Buffer.concat(chunks)));
		});
		sock.on("connect", () => {
			const pipeline = [];
			if (parsed.db) pipeline.push(encodeResp(["SELECT", String(parsed.db)]));
			pipeline.push(encodeResp(args));
			sock.write(pipeline.join(""));
			sock.end();
		});
	});
}

export class ResultCache {
	/**
	 * @param {import('node:sqlite').DatabaseSync | null} db
	 * @param {object} cfg
	 */
	constructor(db, cfg = {}) {
		this.cfg = {
			enabled: cfg.enabled !== false,
			ttl_sec: Number(cfg.ttl_sec ?? 600),
			mem_max: Number(cfg.mem_max ?? 256),
			redis_url: String(cfg.redis_url ?? ""),
			backend: String(cfg.backend ?? "auto"),
		};
		this.mem = new Map();
		this.db = this.cfg.enabled ? db : null;
		this.redis = parseRedisUrl(this.cfg.redis_url);
		if (this.db) {
			try {
				this.db.exec(SCHEMA);
			} catch {
				this.db = null;
			}
		}
	}

	get backend() {
		if (!this.cfg.enabled) return "off";
		if (this.cfg.backend === "memory") return "memory";
		if (this.cfg.backend === "redis" && this.redis) return "redis";
		if (this.redis) return "auto+redis";
		if (this.db) return "sqlite";
		return "memory";
	}

	#memGet(key) {
		const row = this.mem.get(key);
		if (!row) return null;
		if (row.expires && Date.now() > row.expires) {
			this.mem.delete(key);
			return null;
		}
		row.hits += 1;
		this.mem.delete(key);
		this.mem.set(key, row);
		return row;
	}

	#memSet(key, value) {
		if (this.mem.size >= this.cfg.mem_max) {
			const oldest = this.mem.keys().next().value;
			if (oldest !== undefined) this.mem.delete(oldest);
		}
		this.mem.set(key, value);
	}

	#sqlGet(key) {
		if (!this.db) return null;
		try {
			const row = this.db
				.prepare(
					`SELECT handle_id, source, raw_tokens, first_seen, hits, expires_at
					 FROM result_cache WHERE cache_key = ?`,
				)
				.get(key);
			if (!row) return null;
			if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
				this.db.prepare("DELETE FROM result_cache WHERE cache_key = ?").run(key);
				return null;
			}
			this.db
				.prepare("UPDATE result_cache SET hits = hits + 1, last_seen = ? WHERE cache_key = ?")
				.run(new Date().toISOString(), key);
			return {
				handleId: row.handle_id,
				source: row.source,
				rawTokens: row.raw_tokens,
				firstSeen: row.first_seen,
				hits: Number(row.hits) + 1,
			};
		} catch {
			return null;
		}
	}

	#sqlSet(key, { handleId, source, rawTokens }) {
		if (!this.db) return;
		const now = new Date();
		const ttl = this.cfg.ttl_sec > 0 ? this.cfg.ttl_sec : 0;
		const expires = ttl ? new Date(now.getTime() + ttl * 1000).toISOString() : null;
		try {
			this.db
				.prepare(
					`INSERT INTO result_cache (cache_key, handle_id, source, raw_tokens, first_seen, last_seen, hits, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, 1, ?)
					 ON CONFLICT(cache_key) DO UPDATE SET
					   handle_id = excluded.handle_id,
					   source = excluded.source,
					   raw_tokens = excluded.raw_tokens,
					   last_seen = excluded.last_seen,
					   hits = result_cache.hits + 1,
					   expires_at = excluded.expires_at`,
				)
				.run(key, handleId ?? null, source ?? null, rawTokens ?? 0, now.toISOString(), now.toISOString(), expires);
		} catch {
			/* never load-bearing */
		}
	}

	/**
	 * Sync lookup (memory + sqlite). Redis is consulted asynchronously via lookupAsync.
	 * @returns {{handleId:string|null, source:string|null, rawTokens:number, firstSeen:string, hits:number}|null}
	 */
	lookup(key) {
		if (!this.cfg.enabled) return null;
		const mem = this.#memGet(key);
		if (mem) return { handleId: mem.handleId, source: mem.source, rawTokens: mem.rawTokens, firstSeen: mem.firstSeen, hits: mem.hits };
		if (this.cfg.backend === "memory") return null;
		const sql = this.#sqlGet(key);
		if (sql) {
			this.#memSet(key, {
				handleId: sql.handleId,
				source: sql.source,
				rawTokens: sql.rawTokens,
				firstSeen: sql.firstSeen,
				hits: sql.hits,
				expires: this.cfg.ttl_sec > 0 ? Date.now() + this.cfg.ttl_sec * 1000 : 0,
			});
			return sql;
		}
		return null;
	}

	async lookupAsync(key) {
		const local = this.lookup(key);
		if (local) return local;
		if (!this.redis || this.cfg.backend === "memory" || this.cfg.backend === "sqlite") return null;
		const raw = await redisCall(this.redis, ["GET", `cm:ac:${key}`]);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			this.#memSet(key, {
				...parsed,
				hits: (parsed.hits ?? 1) + 1,
				expires: Date.now() + this.cfg.ttl_sec * 1000,
			});
			return parsed;
		} catch {
			return null;
		}
	}

	store(key, { handleId, source, rawTokens }) {
		if (!this.cfg.enabled) return;
		const now = new Date().toISOString();
		const row = {
			handleId: handleId ?? null,
			source: source ?? null,
			rawTokens: rawTokens ?? 0,
			firstSeen: now,
			hits: 1,
			expires: this.cfg.ttl_sec > 0 ? Date.now() + this.cfg.ttl_sec * 1000 : 0,
		};
		this.#memSet(key, row);
		if (this.cfg.backend !== "memory") this.#sqlSet(key, row);
		if (this.redis && this.cfg.ttl_sec > 0 && this.cfg.backend !== "memory" && this.cfg.backend !== "sqlite") {
			const payload = JSON.stringify({
				handleId: row.handleId,
				source: row.source,
				rawTokens: row.rawTokens,
				firstSeen: row.firstSeen,
				hits: 1,
			});
			redisCall(this.redis, ["SET", `cm:ac:${key}`, payload, "EX", String(this.cfg.ttl_sec)]).catch(() => {});
		}
	}
}

export const _test = { parseRedisUrl, encodeResp, shaKey };
