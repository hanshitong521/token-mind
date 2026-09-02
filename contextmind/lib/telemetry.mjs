/**
 * Three-column token accounting (spec 24.2-24.5).
 *
 * The whole point of the split is that a Cursor subscription window has no
 * proxy in the loop, so `proxy_llm_savings` is 0 there *by design* — reporting
 * one blended "saved N tokens" number is the thing spec 24.4 forbids. Columns:
 *
 *   prevented_read_tokens  Read Guard / Dedup kept it out of the window entirely
 *   tool_emitted_savings   raw tool payload minus what we actually emitted
 *   proxy_llm_savings      8787-style conversation compression (0 on Grok/Auto)
 *
 * Storage is node:sqlite — built into Node 22.5+, no native module, no network.
 * Every write is a single INSERT; hooks are on the fast path and must not
 * fsync a batch manager into existence (spec 45.4).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TOKENIZER_ID } from "./tokens.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                     TEXT    NOT NULL,
  session_id             TEXT,
  task_id                TEXT,
  surface                TEXT    NOT NULL,
  tool_name              TEXT,
  content_type           TEXT,
  success                INTEGER,
  raw_tokens             INTEGER NOT NULL DEFAULT 0,
  emitted_tokens         INTEGER NOT NULL DEFAULT 0,
  prevented_read_tokens  INTEGER NOT NULL DEFAULT 0,
  tool_emitted_savings   INTEGER NOT NULL DEFAULT 0,
  proxy_llm_savings      INTEGER NOT NULL DEFAULT 0,
  handle_id              TEXT,
  handle_created         INTEGER NOT NULL DEFAULT 0,
  handle_fetched         INTEGER NOT NULL DEFAULT 0,
  dedup_hit              INTEGER NOT NULL DEFAULT 0,
  read_blocked           INTEGER NOT NULL DEFAULT 0,
  read_override          INTEGER NOT NULL DEFAULT 0,
  first_layer            TEXT,
  adapter_used           TEXT,
  adapter_missing        TEXT,
  hook_latency_ms        REAL,
  gate_latency_ms        REAL,
  tokenizer              TEXT,
  note                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_surface ON events(surface);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

/** Default DB location, mirroring where the engine keeps its own state. */
export function defaultDbPath(projectRoot) {
	return join(projectRoot, ".contextmind", "telemetry.db");
}

export class Telemetry {
	/** @param {{dbPath: string, enabled?: boolean}} opts */
	constructor({ dbPath, enabled = true }) {
		this.dbPath = dbPath;
		this.enabled = enabled;
		this.db = null;
		this.failed = null;
		if (!enabled) return;
		try {
			mkdirSync(dirname(dbPath), { recursive: true });
			this.db = new DatabaseSync(dbPath);
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec(SCHEMA);
			this.insert = this.db.prepare(`
				INSERT INTO events (
					ts, session_id, task_id, surface, tool_name, content_type, success,
					raw_tokens, emitted_tokens, prevented_read_tokens, tool_emitted_savings,
					proxy_llm_savings, handle_id, handle_created, handle_fetched, dedup_hit,
					read_blocked, read_override, first_layer, adapter_used, adapter_missing,
					hook_latency_ms, gate_latency_ms, tokenizer, note
				) VALUES (
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				)
			`);
		} catch (err) {
			// A telemetry failure must never break the tool call it observes.
			// Recorded so doctor can surface it rather than lose the signal.
			this.failed = err instanceof Error ? err.message : String(err);
			this.db = null;
		}
	}

	get available() {
		return this.db !== null;
	}

	/**
	 * Record one governance decision.
	 *
	 * `rawTokens` is what would have entered the window, `emittedTokens` what
	 * did. Both are measured on this call — spec 24.3 forbids estimating the
	 * saving any other way.
	 */
	record(ev) {
		if (!this.db) return false;
		const raw = ev.rawTokens ?? 0;
		const emitted = ev.emittedTokens ?? 0;
		// The columns are exclusive by construction (spec 24.4): a proxy surface's
		// raw-minus-emitted belongs in proxy_llm_savings, and defaulting it into
		// tool_emitted_savings as well would double count every proxy event.
		// S8 G-S8-05 hardens the other boundary too: an event that carried
		// prevented-read tokens never also claims emitted savings — those are
		// tokens that never entered any payload and live in their own column only.
		const toolSavings =
			ev.preventedReadTokens > 0
				? 0
				: (ev.toolEmittedSavings ?? (ev.surface === "proxy" ? 0 : Math.max(0, raw - emitted)));
		const row = [
			new Date().toISOString(),
			ev.sessionId ?? null,
			ev.taskId ?? null,
			ev.surface ?? "unknown",
			ev.toolName ?? null,
			ev.contentType ?? null,
			ev.success === undefined ? null : ev.success ? 1 : 0,
			raw,
			emitted,
			ev.preventedReadTokens ?? 0,
			toolSavings,
			ev.proxyLlmSavings ?? 0,
			ev.handleId ?? null,
			ev.handleCreated ? 1 : 0,
			ev.handleFetched ? 1 : 0,
			ev.dedupHit ? 1 : 0,
			ev.readBlocked ? 1 : 0,
			ev.readOverride ? 1 : 0,
			ev.firstLayer ?? null,
			ev.adapterUsed ?? null,
			ev.adapterMissing ?? null,
			ev.hookLatencyMs ?? null,
			ev.gateLatencyMs ?? null,
			ev.tokenizer ?? TOKENIZER_ID,
			ev.note ?? null,
		];
		try {
			this.insert.run(...row);
			return true;
		} catch (err) {
			this.failed = err instanceof Error ? err.message : String(err);
			return false;
		}
	}

	/**
	 * Aggregate the ledger plus counters, over every dimension the S8 report
	 * needs (spec 24 / S8 freeze): total, session, task, tool, adapter,
	 * content_type and success/failure. `since` is an ISO timestamp.
	 *
	 * The headline numbers are derived ONCE here (ledger) so the text and the
	 * JSON report cannot disagree (G-S8-09).
	 */
	summary({ since = null, sessionId = null } = {}) {
		if (!this.db) return null;
		const where = [];
		const args = [];
		if (since) {
			where.push("ts >= ?");
			args.push(since);
		}
		if (sessionId) {
			where.push("session_id = ?");
			args.push(sessionId);
		}
		const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

		const AGG = `
			COUNT(*)                        AS events,
			COALESCE(SUM(raw_tokens), 0)            AS raw_tokens,
			COALESCE(SUM(emitted_tokens), 0)        AS emitted_tokens,
			COALESCE(SUM(prevented_read_tokens), 0) AS prevented_read_tokens,
			COALESCE(SUM(tool_emitted_savings), 0)  AS tool_emitted_savings,
			COALESCE(SUM(proxy_llm_savings), 0)     AS proxy_llm_savings,
			COALESCE(SUM(handle_created), 0)        AS handle_created,
			COALESCE(SUM(handle_fetched), 0)        AS handle_fetched,
			COALESCE(SUM(dedup_hit), 0)             AS dedup_hit,
			COALESCE(SUM(read_blocked), 0)          AS read_blocked,
			COALESCE(SUM(read_override), 0)         AS read_override`;

		const totals = this.db
			.prepare(`SELECT ${AGG} FROM events ${w}`)
			.get(...args);

		const groupBy = (col) => {
			const rows = this.db
				.prepare(
					`SELECT COALESCE(${col}, '(none)') AS key,
					        COUNT(*)                        AS events,
					        COALESCE(SUM(raw_tokens), 0)            AS raw_tokens,
					        COALESCE(SUM(emitted_tokens), 0)        AS emitted_tokens,
					        COALESCE(SUM(prevented_read_tokens), 0) AS prevented_read_tokens,
					        COALESCE(SUM(tool_emitted_savings), 0)  AS tool_emitted_savings
					 FROM events ${w} GROUP BY ${col} ORDER BY raw_tokens DESC`,
				)
				.all(...args);
			for (const r of rows) {
				r.key = String(r.key); // sqlite returns 0/1 as numbers; group keys are strings
				r.ratio = r.raw_tokens > 0 ? r.tool_emitted_savings / r.raw_tokens : null;
			}
			return rows;
		};

		// The headline ledger, derived once (G-S8-09: text and JSON share it).
		const ledger = {
			raw: totals.raw_tokens,
			emitted: totals.emitted_tokens,
			avoided: totals.tool_emitted_savings,
			prevented_read: totals.prevented_read_tokens,
			proxy_llm: totals.proxy_llm_savings,
			ratio: totals.raw_tokens > 0 ? totals.tool_emitted_savings / totals.raw_tokens : null,
		};

		const missing = this.db.prepare(`
			SELECT adapter_missing AS name, COUNT(*) AS events
			FROM events ${w ? `${w} AND` : "WHERE"} adapter_missing IS NOT NULL
			GROUP BY adapter_missing
		`).all(...args);

		return {
			totals,
			ledger,
			bySurface: groupBy("surface"),
			byTool: groupBy("tool_name"),
			bySession: groupBy("session_id"),
			byTask: groupBy("task_id"),
			byAdapter: groupBy("adapter_used"),
			byContentType: groupBy("content_type"),
			bySuccess: groupBy("success"),
			missing,
		};
	}

	/** Delete events older than `days`. Returns rows removed. */
	prune(days) {
		if (!this.db) return 0;
		const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
		const res = this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
		return Number(res.changes ?? 0);
	}

	close() {
		try {
			this.db?.close();
		} catch {
			/* closing a closed db is not an error worth surfacing */
		}
		this.db = null;
	}
}

/** Open telemetry for a project, honouring the config. */
export function openTelemetry(cfg) {
	const dbPath = cfg.telemetry.db ?? defaultDbPath(cfg.project_root ?? process.cwd());
	return new Telemetry({ dbPath, enabled: cfg.telemetry.enabled });
}

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(2)}%`);

/**
 * Render the ledger as text (S8 freeze format). Every number comes from the
 * same summary object the JSON report serializes, so the two cannot disagree
 * (G-S8-09). No invented values: an empty ledger prints zeros, not blanks.
 */
export function formatSummary(sum, { title = "ContextMind Token Ledger", period = "All time" } = {}) {
	const t = sum.totals;
	const l = sum.ledger;
	const lines = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`Period: ${period}`);
	lines.push(`tokenizer: ${TOKENIZER_ID}`);
	lines.push("");
	lines.push("## Ledger");
	lines.push("");
	lines.push(`RAW        ${t.raw_tokens.toLocaleString("en-US")} tokens`);
	lines.push(`EMITTED    ${t.emitted_tokens.toLocaleString("en-US")} tokens`);
	lines.push(`AVOIDED    ${l.avoided.toLocaleString("en-US")} tokens`);
	lines.push(`REDUCTION  ${pct(l.ratio)}`);
	lines.push("");
	lines.push(`PREVENTED READ  ${l.prevented_read.toLocaleString("en-US")} tokens  (separate column; not counted in AVOIDED)`);
	if (l.proxy_llm > 0) lines.push(`PROXY LLM SAVINGS  ${l.proxy_llm.toLocaleString("en-US")} tokens  (BYOK only; 0 expected on Cursor subscription)`);
	lines.push("");
	lines.push(`Handles created ${t.handle_created}   fetched ${t.handle_fetched}   dedup hits ${t.dedup_hit}   reads blocked ${t.read_blocked}   overrides ${t.read_override}`);
	lines.push(`Events ${t.events}`);
	lines.push("");

	lines.push("## By tool");
	lines.push("");
	lines.push("| tool | events | raw | emitted | avoided | ratio |");
	lines.push("|---|---:|---:|---:|---:|---:|");
	for (const r of sum.byTool) {
		lines.push(`| ${r.key} | ${r.events} | ${r.raw_tokens} | ${r.emitted_tokens} | ${r.tool_emitted_savings} | ${pct(r.ratio)} |`);
	}
	lines.push("");

	// Failure preservation (S8 must-test): failures must appear in the ledger
	// and their ratio shows whether error evidence was protected rather than
	// trimmed — a high failure ratio is a red flag, not a win.
	lines.push("## By success / failure");
	lines.push("");
	lines.push("| outcome | events | raw | emitted | avoided |");
	lines.push("|---|---:|---:|---:|---:|");
	for (const r of sum.bySuccess) {
		const label = r.key === "1" ? "success" : r.key === "0" ? "failure" : "unknown";
		lines.push(`| ${label} | ${r.events} | ${r.raw_tokens} | ${r.emitted_tokens} | ${r.tool_emitted_savings} |`);
	}
	lines.push("");

	if (sum.byAdapter.length > 0) {
		lines.push("## By adapter");
		lines.push("");
		lines.push("| adapter | events | raw | emitted | avoided |");
		lines.push("|---|---:|---:|---:|---:|");
		for (const r of sum.byAdapter) {
			lines.push(`| ${r.key} | ${r.events} | ${r.raw_tokens} | ${r.emitted_tokens} | ${r.tool_emitted_savings} |`);
		}
		lines.push("");
	}

	if (sum.missing.length > 0) {
		lines.push("## Missing adapters");
		lines.push("");
		for (const r of sum.missing) lines.push(`- ${r.name}: ${r.events} event(s)`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
