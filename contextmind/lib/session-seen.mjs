/**
 * Session-seen index (host-side, not agent-memory).
 *
 * The model will re-Read / re-explore even after a stub. This table is the
 * enforcement surface: hooks deny a second unbounded Read of the same path,
 * and sessionStart reminds the model which queries already have handles.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_seen (
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  handle_id   TEXT,
  first_seen  TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, kind, key)
);
CREATE TABLE IF NOT EXISTS read_windows (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  first_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_read_windows_sess_path ON read_windows(session_id, path);
`;

/** Cursor Read window. Unbounded → a sentinel so a second whole-file read matches. */
export function lineWindow(offset, limit) {
	const hasOff = offset != null && offset !== "";
	const hasLim = limit != null && limit !== "";
	if (!hasOff && !hasLim) return { start: 1, end: 2_000_000_000, unbounded: true };
	const start = hasOff ? Math.max(1, Number(offset) || 1) : 1;
	if (hasOff && !hasLim) return { start, end: start + 399, unbounded: false };
	const len = Math.max(1, Number(limit) || 1);
	return { start, end: start + len - 1, unbounded: false };
}

export class SessionSeen {
	constructor(db) {
		this.db = db;
		if (this.db) {
			try {
				this.db.exec(SCHEMA);
			} catch {
				this.db = null;
			}
		}
	}

	get available() {
		return this.db !== null;
	}

	touch(sessionId, kind, key, handleId = null) {
		if (!this.db || !key) return;
		const sid = sessionId ?? "unknown";
		const now = new Date().toISOString();
		try {
			this.db
				.prepare(
					`INSERT INTO session_seen (session_id, kind, key, handle_id, first_seen, hits)
					 VALUES (?, ?, ?, ?, ?, 1)
					 ON CONFLICT(session_id, kind, key) DO UPDATE SET
					   hits = session_seen.hits + 1,
					   handle_id = COALESCE(excluded.handle_id, session_seen.handle_id)`,
				)
				.run(sid, kind, String(key), handleId, now);
		} catch {
			/* never load-bearing */
		}
	}

	lookup(sessionId, kind, key) {
		if (!this.db || !key) return null;
		try {
			return (
				this.db
					.prepare("SELECT handle_id, hits, first_seen FROM session_seen WHERE session_id = ? AND kind = ? AND key = ?")
					.get(sessionId ?? "unknown", kind, String(key)) ?? null
			);
		} catch {
			return null;
		}
	}

	addWindow(sessionId, path, start, end) {
		if (!this.db || !path) return;
		try {
			this.db
				.prepare(
					`INSERT INTO read_windows (session_id, path, start_line, end_line, first_seen)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(sessionId ?? "unknown", path, start, end, new Date().toISOString());
		} catch {
			/* never load-bearing */
		}
	}

	/** Earlier Read that fully contains this window (accuracy-safe to skip). */
	coveringWindow(sessionId, path, start, end) {
		if (!this.db || !path) return null;
		try {
			const rows = this.db
				.prepare(
					`SELECT start_line, end_line FROM read_windows
					 WHERE session_id = ? AND path = ?`,
				)
				.all(sessionId ?? "unknown", path);
			return rows.find((r) => Number(r.start_line) <= start && Number(r.end_line) >= end) ?? null;
		} catch {
			return null;
		}
	}

	coveringRead(sessionId, path, offset, limit) {
		const w = lineWindow(offset, limit);
		const hit = this.coveringWindow(sessionId, path, w.start, w.end);
		return hit ? { ...w, coveredBy: hit } : null;
	}

	recordRead(sessionId, path, offset, limit) {
		const w = lineWindow(offset, limit);
		this.addWindow(sessionId, path, w.start, w.end);
		this.touch(sessionId, "path", path, null);
		return w;
	}

	/** Compact reminder for sessionStart. Hard-capped so it cannot eat the window. */
	digest(sessionId, { max = 8, maxChars = 480 } = {}) {
		const standing =
			"[cm] orient once/symbol; no raw codegraph MCP; fetch line-capped unless full=true.";
		if (!this.db) return standing;
		let rows = [];
		try {
			rows = this.db
				.prepare(
					`SELECT kind, key, handle_id, hits FROM session_seen
					 WHERE session_id = ? ORDER BY first_seen DESC LIMIT ?`,
				)
				.all(sessionId ?? "unknown", max);
		} catch {
			return standing;
		}
		if (rows.length === 0) return standing;
		const lines = rows.map((r) => `${r.kind}:${String(r.key).slice(0, 48)}->${r.handle_id ?? "-"}×${r.hits}`);
		let body = `${standing}\nSeen: ${lines.join("; ")}`;
		if (body.length > maxChars) body = body.slice(0, maxChars - 1) + "…";
		return body;
	}

	clearSession(sessionId) {
		if (!this.db) return 0;
		try {
			const sid = sessionId ?? "unknown";
			const a = Number(this.db.prepare("DELETE FROM session_seen WHERE session_id = ?").run(sid).changes ?? 0);
			const b = Number(this.db.prepare("DELETE FROM read_windows WHERE session_id = ?").run(sid).changes ?? 0);
			return a + b;
		} catch {
			return 0;
		}
	}
}
