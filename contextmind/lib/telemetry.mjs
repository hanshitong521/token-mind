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
		const toolSavings =
			ev.toolEmittedSavings ?? (ev.surface === "proxy" ? 0 : Math.max(0, raw - emitted));
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

	/** Aggregate the three columns plus counters. `since` is an ISO timestamp. */
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

		const totals = this.db.prepare(`
			SELECT
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
				COALESCE(SUM(read_override), 0)         AS read_override
			FROM events ${w}
		`).get(...args);

		const bySurface = this.db.prepare(`
			SELECT
				surface,
				COUNT(*)                        AS events,
				COALESCE(SUM(raw_tokens), 0)            AS raw_tokens,
				COALESCE(SUM(emitted_tokens), 0)        AS emitted_tokens,
				COALESCE(SUM(prevented_read_tokens), 0) AS prevented_read_tokens,
				COALESCE(SUM(tool_emitted_savings), 0)  AS tool_emitted_savings
			FROM events ${w}
			GROUP BY surface
			ORDER BY raw_tokens DESC
		`).all(...args);

		const byTool = this.db.prepare(`
			SELECT
				COALESCE(tool_name, '(none)')  AS tool_name,
				COUNT(*)                       AS events,
				COALESCE(SUM(raw_tokens), 0)            AS raw_tokens,
				COALESCE(SUM(emitted_tokens), 0)        AS emitted_tokens,
				COALESCE(SUM(prevented_read_tokens), 0) AS prevented_read_tokens,
				COALESCE(SUM(tool_emitted_savings), 0)  AS tool_emitted_savings
			FROM events ${w}
			GROUP BY tool_name
			ORDER BY raw_tokens DESC
			LIMIT 20
		`).all(...args);

		const missing = this.db.prepare(`
			SELECT adapter_missing AS name, COUNT(*) AS events
			FROM events ${w ? `${w} AND` : "WHERE"} adapter_missing IS NOT NULL
			GROUP BY adapter_missing
		`).all(...args);

		return { totals, bySurface, byTool, missing };
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

/**
 * Render a summary as text. Deliberately narrow: this is the S8 data model
 * check and the `contextmind report` surface, not the dashboard (spec 24.5 says
 * the data model comes first).
 */
export function formatSummary(sum, { title = "ContextMind token ledger" } = {}) {
	const t = sum.totals;
	const lines = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`tokenizer: ${TOKENIZER_ID}`);
	lines.push("");
	lines.push("## Three-column accounting");
	lines.push("");
	lines.push("| column | tokens | meaning |");
	lines.push("|---|---:|---|");
	lines.push(
		`| prevented_read_tokens | ${t.prevented_read_tokens} | Read Guard / Dedup kept out of the window |`,
	);
	lines.push(`| tool_emitted_savings | ${t.tool_emitted_savings} | raw tool payload minus emitted |`);
	lines.push(`| proxy_llm_savings | ${t.proxy_llm_savings} | conversation proxy (0 on Cursor subscription) |`);
	lines.push("");
	lines.push(`events=${t.events}  raw=${t.raw_tokens}  emitted=${t.emitted_tokens}`);
	const avoided = t.prevented_read_tokens + t.tool_emitted_savings + t.proxy_llm_savings;
	const denom = t.raw_tokens + t.prevented_read_tokens;
	lines.push(
		`avoided_total=${avoided}` +
			(denom > 0 ? `  ratio=${((avoided / denom) * 100).toFixed(1)}%` : "  ratio=n/a"),
	);
	lines.push("");
	lines.push("## Counters");
	lines.push("");
	lines.push(
		`handle_created=${t.handle_created} handle_fetched=${t.handle_fetched} dedup_hit=${t.dedup_hit} ` +
			`read_blocked=${t.read_blocked} read_override=${t.read_override}`,
	);
	if (sum.bySurface.length > 0) {
		lines.push("");
		lines.push("## By surface");
		lines.push("");
		lines.push("| surface | events | raw | emitted | prevented_read | tool_savings |");
		lines.push("|---|---:|---:|---:|---:|---:|");
		for (const r of sum.bySurface) {
			lines.push(
				`| ${r.surface} | ${r.events} | ${r.raw_tokens} | ${r.emitted_tokens} | ${r.prevented_read_tokens} | ${r.tool_emitted_savings} |`,
			);
		}
	}
	if (sum.byTool.length > 0) {
		lines.push("");
		lines.push("## Top tools by raw tokens");
		lines.push("");
		lines.push("| tool | events | raw | emitted | prevented_read | tool_savings |");
		lines.push("|---|---:|---:|---:|---:|---:|");
		for (const r of sum.byTool) {
			lines.push(
				`| ${r.tool_name} | ${r.events} | ${r.raw_tokens} | ${r.emitted_tokens} | ${r.prevented_read_tokens} | ${r.tool_emitted_savings} |`,
			);
		}
	}
	if (sum.missing.length > 0) {
		lines.push("");
		lines.push("## Missing adapters");
		lines.push("");
		for (const r of sum.missing) lines.push(`- ${r.name}: ${r.events} event(s)`);
	}
	return `${lines.join("\n")}\n`;
}
