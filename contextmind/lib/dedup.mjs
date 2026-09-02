/**
 * Evidence dedup (spec 14).
 *
 * The second injection of the same evidence is pure waste: nothing changed
 * between the two reads, so the model is paying twice for one fact. But dedup
 * that cannot see a change is worse than no dedup — a stale stub presented as
 * current evidence is a lie. Every entry therefore keys on a fingerprint that
 * includes the content hash AND the freshness signal the caller can supply
 * (file mtime/hash, tool input fingerprint, graph freshness).
 *
 * Shares the handle DB connection so there is one file and one WAL to reason
 * about.
 */

import { createHash } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dedup (
  fingerprint   TEXT PRIMARY KEY,
  handle_id     TEXT,
  session_id    TEXT,
  source        TEXT,
  raw_tokens    INTEGER NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_dedup_session ON dedup(session_id);
`;

export function fingerprint(...parts) {
	return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

export class Dedup {
	/** @param {import('node:sqlite').DatabaseSync} db */
	constructor(db, { enabled = true } = {}) {
		this.db = enabled ? db : null;
		if (this.db) this.db.exec(SCHEMA);
	}

	get available() {
		return this.db !== null;
	}

	/**
	 * @returns {{handleId: string|null, hits: number, firstSeen: string}|null}
	 *   null when this fingerprint has not been seen in this session.
	 */
	lookup(key, sessionId) {
		if (!this.db) return null;
		const row = this.db
			.prepare("SELECT handle_id, hits, first_seen FROM dedup WHERE fingerprint = ? AND session_id = ?")
			.get(key, sessionId ?? "");
		if (!row) return null;
		this.db
			.prepare("UPDATE dedup SET hits = hits + 1, last_seen = ? WHERE fingerprint = ? AND session_id = ?")
			.run(new Date().toISOString(), key, sessionId ?? "");
		return { handleId: row.handle_id, hits: row.hits + 1, firstSeen: row.first_seen };
	}

	record(key, { sessionId, source, handleId, rawTokens }) {
		if (!this.db) return;
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO dedup (fingerprint, handle_id, session_id, source, raw_tokens, first_seen, last_seen)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(fingerprint) DO UPDATE SET
				   last_seen = excluded.last_seen,
				   handle_id = COALESCE(excluded.handle_id, dedup.handle_id),
				   hits = dedup.hits + 1`,
			)
			.run(key, handleId ?? null, sessionId ?? "", source ?? null, rawTokens ?? 0, now, now);
	}

	/** Forget everything for a session — called on sessionEnd. */
	clearSession(sessionId) {
		if (!this.db) return 0;
		return Number(this.db.prepare("DELETE FROM dedup WHERE session_id = ?").run(sessionId ?? "").changes ?? 0);
	}
}

/**
 * The stub a repeat emits (spec 14.3): identity and a handle, never the body.
 * "key facts" is the caller's responsibility to fill with what actually matters
 * about the earlier evidence, because only the caller knows what that was.
 */
export function duplicateStub({ handleId, source, firstSeen, hits, keyFacts = [] }) {
	const lines = [
		"[duplicate evidence]",
		`handle: ${handleId ?? "(none)"}`,
		`source: ${source ?? "(unknown)"}`,
		`unchanged_since: ${firstSeen ?? "(unknown)"}`,
		`repeat: ${hits ?? 1}`,
	];
	if (keyFacts.length > 0) lines.push(`key facts: ${keyFacts.join("; ")}`);
	lines.push("Body omitted: identical fingerprint already in this session. Fetch the handle to see it again.");
	return lines.join("\n");
}
