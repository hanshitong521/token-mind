/**
 * Handle store (spec 13).
 *
 * Reversibility is the contract: anything we compress, truncate or omit must be
 * retrievable byte-for-byte by a short id. The engine's ContentStore is a
 * *search* index (chunked, FTS, retrieval-oriented) and carries none of the
 * fields spec 13.1 requires — expiry, provenance, compression method, raw token
 * counts — so this is the handle store, not a second one.
 *
 * Raw bytes live in the same SQLite file as the metadata. A separate blob dir
 * would mean two things to back up and two things to leak; the DB is capped and
 * pruned by `gc` instead.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countTokens, TOKENIZER_ID } from "./tokens.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS handles (
  handle_id          TEXT PRIMARY KEY,
  session_id         TEXT,
  source_type        TEXT NOT NULL,
  tool_name          TEXT,
  command            TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  raw_hash           TEXT NOT NULL,
  raw_bytes          INTEGER NOT NULL,
  raw_tokens         INTEGER NOT NULL,
  compressed_tokens  INTEGER NOT NULL DEFAULT 0,
  content_type       TEXT,
  compression_method TEXT,
  provenance         TEXT,
  metadata_json      TEXT,
  blob               BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handles_expires ON handles(expires_at);
CREATE INDEX IF NOT EXISTS idx_handles_created ON handles(created_at);
CREATE INDEX IF NOT EXISTS idx_handles_hash ON handles(raw_hash);
`;

/** Short, path-free, loggable. 8 chars of base32 ≈ 40 bits: no guessing at this TTL. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function newHandleId() {
	const bytes = randomBytes(8);
	let id = "";
	for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
	return `h_${id}`;
}

export function defaultDbPath(projectRoot) {
	return join(projectRoot, ".contextmind", "handles.db");
}

export class HandleStore {
	constructor({ dbPath, ttlHours = 12, maxDiskMb = 1024, enabled = true }) {
		this.dbPath = dbPath;
		this.ttlHours = ttlHours;
		this.maxDiskMb = maxDiskMb;
		this.enabled = enabled;
		this.db = null;
		this.failed = null;
		if (!enabled) return;
		try {
			mkdirSync(dirname(dbPath), { recursive: true });
			this.db = new DatabaseSync(dbPath);
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA busy_timeout = 5000");
			this.db.exec(SCHEMA);
		} catch (err) {
			this.failed = err instanceof Error ? err.message : String(err);
			this.db = null;
		}
	}

	get available() {
		return this.db !== null;
	}

	/**
	 * Store raw content and return its handle id, or null when unavailable.
	 * Capacity is enforced on the way in, not only by `gc`: a runaway session
	 * should not be able to fill the disk before the next gc runs.
	 */
	put(raw, meta = {}) {
		if (!this.db) return null;
		const blob = Buffer.from(raw, "utf8");
		if (blob.byteLength > this.maxDiskMb * 1024 * 1024) return null;
		this.enforceCap(blob.byteLength);

		const id = newHandleId();
		const now = new Date();
		const ttl = Number.isFinite(this.ttlHours) && this.ttlHours > 0 ? this.ttlHours : null;
		const expiresAt = ttl ? new Date(now.getTime() + ttl * 3_600_000).toISOString() : null;
		try {
			this.db
				.prepare(
					`INSERT INTO handles (
						handle_id, session_id, source_type, tool_name, command, created_at, expires_at,
						raw_hash, raw_bytes, raw_tokens, compressed_tokens, content_type,
						compression_method, provenance, metadata_json, blob
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					meta.sessionId ?? null,
					meta.sourceType ?? "tool_output",
					meta.toolName ?? null,
					meta.command ?? null,
					now.toISOString(),
					expiresAt,
					meta.rawHash ?? "",
					blob.byteLength,
					countTokens(raw),
					meta.compressedTokens ?? 0,
					meta.contentType ?? null,
					meta.compressionMethod ?? null,
					meta.provenance ?? null,
					meta.metadata ? JSON.stringify(meta.metadata) : null,
					blob,
				);
			return id;
		} catch (err) {
			this.failed = err instanceof Error ? err.message : String(err);
			return null;
		}
	}

	/** Metadata without the payload — cheap enough to render in a listing. */
	meta(handleId) {
		if (!this.db) return null;
		const row = this.db
			.prepare(
				`SELECT handle_id, session_id, source_type, tool_name, command, created_at, expires_at,
				        raw_hash, raw_bytes, raw_tokens, compressed_tokens, content_type,
				        compression_method, provenance, metadata_json
				 FROM handles WHERE handle_id = ?`,
			)
			.get(handleId);
		return row ?? null;
	}

	/** Raw text for a handle, or null if unknown/expired. */
	get(handleId) {
		if (!this.db) return null;
		const row = this.db.prepare("SELECT blob, expires_at FROM handles WHERE handle_id = ?").get(handleId);
		if (!row) return null;
		if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
		return Buffer.from(row.blob).toString("utf8");
	}

	/**
	 * Apply a selector (spec 9.6). One switch, five shapes; every branch returns
	 * text plus how much of the raw it represents so telemetry stays honest.
	 */
	fetch(handleId, selector = {}) {
		const raw = this.get(handleId);
		if (raw === null) return null;
		const rawTokens = countTokens(raw);

		if (selector.jsonPath) {
			const value = pickJsonPath(raw, selector.jsonPath);
			if (value === undefined) {
				return { text: `(no match for jsonPath "${selector.jsonPath}")`, tokens: 0, rawTokens, kind: "jsonPath" };
			}
			const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
			return { text, tokens: countTokens(text), rawTokens, kind: "jsonPath" };
		}

		if (selector.pattern) {
			const lines = raw.split("\n");
			const re = new RegExp(selector.pattern, selector.flags ?? "");
			const cap = selector.maxLines ?? 200;
			const hits = [];
			for (let i = 0; i < lines.length && hits.length < cap; i++) {
				if (re.test(lines[i])) hits.push(`${i + 1}: ${lines[i]}`);
			}
			const text = hits.length ? hits.join("\n") : `(no match for /${selector.pattern}/)`;
			return { text, tokens: countTokens(text), rawTokens, kind: "pattern" };
		}

		if (selector.start !== undefined || selector.end !== undefined) {
			const start = Math.max(1, Number(selector.start ?? 1));
			const end = Number(selector.end ?? (selector.lines ? start + Number(selector.lines) - 1 : start + 200));
			const lines = raw.split("\n").slice(start - 1, end);
			const text = lines.join("\n");
			return { text, tokens: countTokens(text), rawTokens, kind: "lines" };
		}

		if (selector.offset !== undefined || selector.page) {
			const size = Number(selector.page ?? 400);
			const offset = Math.max(0, Number(selector.offset ?? 0));
			const text = raw.slice(offset, offset + size);
			return { text, tokens: countTokens(text), rawTokens, kind: "offset" };
		}

		return { text: raw, tokens: rawTokens, rawTokens, kind: "raw" };
	}

	/** Oldest-first eviction until the incoming blob fits. */
	enforceCap(incomingBytes = 0) {
		if (!this.db) return 0;
		const capBytes = this.maxDiskMb * 1024 * 1024;
		let total = Number(this.db.prepare("SELECT COALESCE(SUM(raw_bytes), 0) AS n FROM handles").get().n);
		if (total + incomingBytes <= capBytes) return 0;
		const rows = this.db
			.prepare("SELECT handle_id, raw_bytes FROM handles ORDER BY created_at ASC LIMIT 200")
			.all();
		const del = this.db.prepare("DELETE FROM handles WHERE handle_id = ?");
		let removed = 0;
		for (const row of rows) {
			if (total + incomingBytes <= capBytes) break;
			del.run(row.handle_id);
			total -= row.raw_bytes;
			removed++;
		}
		return removed;
	}

	/** Drop expired handles and anything over the disk cap. Returns rows removed. */
	gc() {
		if (!this.db) return 0;
		const now = new Date().toISOString();
		const expired = this.db.prepare("DELETE FROM handles WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
		const evicted = this.enforceCap(0);
		return Number(expired.changes ?? 0) + evicted;
	}

	stats() {
		if (!this.db) return null;
		return this.db
			.prepare(
				`SELECT COUNT(*) AS handles,
				        COALESCE(SUM(raw_bytes), 0)  AS bytes,
				        COALESCE(SUM(raw_tokens), 0) AS raw_tokens,
				        COALESCE(SUM(compressed_tokens), 0) AS compressed_tokens
				 FROM handles`,
			)
			.get();
	}

	list(limit = 20) {
		if (!this.db) return [];
		return this.db
			.prepare(
				`SELECT handle_id, source_type, tool_name, command, created_at, raw_bytes, raw_tokens,
				        compressed_tokens, content_type, compression_method
				 FROM handles ORDER BY created_at DESC LIMIT ?`,
			)
			.all(limit);
	}

	close() {
		try {
			this.db?.close();
		} catch {
			/* already closed */
		}
		this.db = null;
	}
}

/**
 * Resolve a dotted JSON path against text that may be JSON or NDJSON.
 * Returns undefined only for "no such path" — a parse failure returns undefined
 * too, and the caller distinguishes them by the surrounding message.
 */
export function pickJsonPath(text, path) {
	const parts = String(path)
		.split(".")
		.flatMap((p) => {
			const m = p.match(/^([^[]+)((\[\d+\])*)$/);
			if (!m) return [p];
			const out = [m[1]].filter(Boolean);
			for (const idx of m[2].match(/\d+/g) ?? []) out.push(idx);
			return out;
		})
		.filter((p) => p !== "");

	const roots = [];
	try {
		roots.push(JSON.parse(text));
	} catch {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				roots.push(JSON.parse(line));
			} catch {
				/* not json */
			}
		}
	}
	if (roots.length === 0) return undefined;

	let cur = roots.length === 1 ? roots[0] : roots;
	for (const part of parts) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur)) {
			const i = Number(part);
			if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
			cur = cur[i];
		} else if (typeof cur === "object") {
			if (!(part in cur)) return undefined;
			cur = cur[part];
		} else {
			return undefined;
		}
	}
	return cur;
}

export function openHandles(cfg) {
	const dbPath = cfg.telemetry.db ? join(dirname(cfg.telemetry.db), "handles.db") : defaultDbPath(cfg.project_root ?? process.cwd());
	return new HandleStore({
		dbPath,
		ttlHours: cfg.handles.ttl_hours,
		maxDiskMb: cfg.handles.max_disk_mb,
		enabled: cfg.handles.enabled,
	});
}

export { newHandleId, TOKENIZER_ID };
