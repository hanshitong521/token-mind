#!/usr/bin/env node
/**
 * ContextMind Dashboard (read-only, zero-dependency).
 *
 * A decision-2C exception, owner-requested (2026-09-02): a *view* over the
 * existing telemetry SQLite, not a new data layer. One process serves one
 * HTML page plus a /api/data endpoint backed by the SAME summary() the CLI
 * report uses — S8's ledger invariants and the frozen accounting rules are
 * inherited, not duplicated. No writes, ever.
 *
 *   node contextmind/dashboard.mjs [projectDir] [--port 8899]
 */

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Host capabilities come from the registry beside this file. Read-guard rows
// can only ever come from a tool hook, so "0" on a hook-less host (Trae) means
// "not available", not "nothing was blocked" — the page needs the caps to label
// the difference.
function hostCaps(host) {
	if (!host) return null;
	const p = join(HERE, "hosts.json");
	if (!existsSync(p)) return null;
	try {
		const doc = JSON.parse(readFileSync(p, "utf8"));
		const prof = (doc.hosts || []).find((h) => h.id === host);
		return prof ? prof.capabilities ?? null : null;
	} catch {
		return null;
	}
}

// ─── args ───

function parse(argv) {
	const out = { projectRoot: null, port: 8899 };
	const rest = [...argv];
	const portIdx = rest.indexOf("--port");
	if (portIdx >= 0) {
		out.port = Number(rest[portIdx + 1]);
		rest.splice(portIdx, 2);
	}
	if (rest[0]) out.projectRoot = resolve(rest[0]);
	if (!out.projectRoot) {
		out.projectRoot = process.env.CONTEXTMIND_PROJECT_DIR ?? process.cwd();
	}
	return out;
}

const { projectRoot, port } = parse(process.argv.slice(2));

// Resolve the DB the same way the runtime does. The shejiu-data remap
// (lib/shejiu-data-root.mjs) moves telemetry off-repo to
// <SHEJIU_DATA_ROOT>/projects/<key>/contextmind/telemetry.db, so hardcoding
// <project>/.contextmind/telemetry.db silently reads a file the engine never
// writes — an empty dashboard over real data. getConfig() owns that decision.
const { getConfig } = await import(pathToFileURL(join(HERE, "lib", "config.mjs")).href);
const cfg = getConfig(projectRoot);
const dbPath = cfg?.telemetry?.db ?? join(projectRoot, ".contextmind", "telemetry.db");
if (!existsSync(dbPath)) {
	console.error(`[contextmind] no telemetry database at ${dbPath}`);
	console.error("  Nothing has been governed for this project yet, or the project dir is wrong.");
	process.exit(1);
}
// No host list lives here: a new agent only has to write rows for this chart to
// filter on it. The value is interpolated into a CREATE VIEW, so the shape test
// below is also the injection guard — keep it strict.
const HOST_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const probe = new DatabaseSync(dbPath, { readOnly: true });
const HAS_HOST = probe
	.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'host'")
	.get() !== undefined;
probe.close();

function openLedger(host) {
	const handle = new DatabaseSync(dbPath, { readOnly: true });
	// A temp view shadows the real table, so every query below filters by host
	// without a single one of them being rewritten.
	if (host) {
		// Legacy rows hold NULL; the ledger reports them under 'unknown'.
		const pred =
			host === "unknown" ? "COALESCE(host, 'unknown') = 'unknown'" : `host = '${host}'`;
		handle.exec(`CREATE TEMP VIEW events AS SELECT * FROM main.events WHERE ${pred}`);
	}
	return handle;
}

let dbHost = "";
let db = openLedger(dbHost);

const TOKENIZER_ID = "heuristic:chars/4";

// ─── queries (read-only; the API mirrors the S8 ledger semantics exactly) ───

const EVENT_FIELDS = `
	ts, session_id, task_id, surface, tool_name, content_type, success,
	raw_tokens, emitted_tokens, prevented_read_tokens, tool_emitted_savings,
	proxy_llm_savings, handle_id, handle_created, handle_fetched, dedup_hit,
	read_blocked, read_override, first_layer, adapter_used, adapter_missing,
	hook_latency_ms, gate_latency_ms, note`;

function totals(where = "", args = []) {
	return db.prepare(`
		SELECT COUNT(*) AS events,
		       COALESCE(SUM(raw_tokens), 0) AS raw,
		       COALESCE(SUM(emitted_tokens), 0) AS emitted,
		       COALESCE(SUM(tool_emitted_savings), 0) AS avoided,
		       COALESCE(SUM(prevented_read_tokens), 0) AS prevented,
		       COALESCE(SUM(proxy_llm_savings), 0) AS proxy,
		       COALESCE(SUM(handle_created), 0) AS handles_created,
		       COALESCE(SUM(handle_fetched), 0) AS handles_fetched,
		       COALESCE(SUM(dedup_hit), 0) AS dedup_hits,
		       COALESCE(SUM(read_blocked), 0) AS reads_blocked,
		       COALESCE(SUM(read_override), 0) AS overrides,
		       COALESCE(SUM(success), 0) AS successes,
		       COALESCE(AVG(gate_latency_ms), 0) AS avg_gate_ms
		FROM events ${where}
	`).get(...args);
}

function groupBy(col, where = "", args = []) {
	return db.prepare(`
		SELECT COALESCE(${col}, '(none)') AS key,
		       COUNT(*) AS events,
		       COALESCE(SUM(raw_tokens), 0) AS raw,
		       COALESCE(SUM(emitted_tokens), 0) AS emitted,
		       COALESCE(SUM(tool_emitted_savings), 0) AS avoided,
		       COALESCE(SUM(prevented_read_tokens), 0) AS prevented,
		       COALESCE(SUM(proxy_llm_savings), 0) AS proxy,
		       COALESCE(SUM(dedup_hit), 0) AS dedup,
		       COALESCE(SUM(handle_created), 0) AS created,
		       COALESCE(SUM(handle_fetched), 0) AS fetched,
		       COALESCE(SUM(read_blocked), 0) AS reads_blocked,
		       COALESCE(SUM(read_override), 0) AS overrides,
		       COALESCE(SUM(success), 0) AS successes,
		       COALESCE(AVG(gate_latency_ms), 0) AS avg_gate_ms
		FROM events ${where}
		GROUP BY ${col} ORDER BY raw DESC
	`).all(...args).map((r) => ({ ...r, key: String(r.key), ratio: r.raw > 0 ? r.avoided / r.raw : null }));
}

/** Events bucketed by a strftime granularity, oldest first. */
function timeBuckets(fmt) {
	return db.prepare(`
		SELECT strftime('${fmt}', ts) AS bucket,
		       COUNT(*) AS events,
		       COALESCE(SUM(raw_tokens), 0) AS raw,
		       COALESCE(SUM(emitted_tokens), 0) AS emitted,
		       COALESCE(SUM(tool_emitted_savings), 0) AS avoided,
		       COALESCE(SUM(prevented_read_tokens), 0) AS prevented,
		       COALESCE(SUM(proxy_llm_savings), 0) AS proxy,
		       COALESCE(SUM(dedup_hit), 0) AS dedup,
		       COALESCE(SUM(handle_created), 0) AS created,
		       COALESCE(SUM(handle_fetched), 0) AS fetched,
		       COALESCE(SUM(read_blocked), 0) AS reads_blocked,
		       COALESCE(AVG(gate_latency_ms), 0) AS avg_gate_ms
		FROM events GROUP BY bucket ORDER BY bucket
	`).all().map((r) => ({ ...r, ratio: r.raw > 0 ? r.avoided / r.raw : null }));
}

/**
 * Where the saved tokens actually came from, one row per first-layer method.
 * The three saving columns are exclusive by construction (see telemetry.record),
 * so they add up without double counting: a layer's avoided tokens, plus the
 * reads that never happened, plus what the proxy kept out of the window.
 */
function savingsByChannel() {
	const byLayer = db.prepare(`
		SELECT COALESCE(first_layer, '(none)') AS key,
		       COUNT(*) AS events,
		       COALESCE(SUM(tool_emitted_savings), 0) AS avoided,
		       COALESCE(SUM(raw_tokens), 0) AS raw,
		       COALESCE(SUM(emitted_tokens), 0) AS emitted
		FROM events WHERE COALESCE(tool_emitted_savings, 0) > 0
		GROUP BY first_layer ORDER BY avoided DESC
	`).all();
	const prevented = db.prepare(`
		SELECT COALESCE(SUM(prevented_read_tokens), 0) AS tokens, COUNT(*) AS events
		FROM events WHERE COALESCE(prevented_read_tokens, 0) > 0
	`).get();
	const proxy = db.prepare(`
		SELECT COALESCE(SUM(proxy_llm_savings), 0) AS tokens, COUNT(*) AS events
		FROM events WHERE COALESCE(proxy_llm_savings, 0) > 0
	`).get();
	return { byLayer, prevented, proxy };
}

/**
 * Hit / miss counters. "Miss" is the tuning signal: a dedup miss on a repeated
 * payload, a handle that was built but never fetched, a read the guard blocked
 * that the agent then overrode.
 */
function hitMiss() {
	return db.prepare(`
		SELECT COUNT(*) AS events,
		       COALESCE(SUM(dedup_hit), 0) AS dedup_hits,
		       COALESCE(SUM(handle_created), 0) AS handles_created,
		       COALESCE(SUM(handle_fetched), 0) AS handles_fetched,
		       COALESCE(SUM(read_blocked), 0) AS reads_blocked,
		       COALESCE(SUM(read_override), 0) AS overrides,
		       COALESCE(SUM(adapter_missing IS NOT NULL), 0) AS adapter_missing,
		       COALESCE(SUM(success), 0) AS successes
		FROM events
	`).get();
}

/** The rows that spent the most raw tokens — where a policy change pays off. */
function topConsumers(limit = 15) {
	return db.prepare(`
		SELECT ts, tool_name, surface, content_type, first_layer, raw_tokens, emitted_tokens,
		       tool_emitted_savings, prevented_read_tokens, adapter_used, adapter_missing, note
		FROM events WHERE raw_tokens > 0 ORDER BY raw_tokens DESC LIMIT ${Math.max(1, Math.floor(limit))}
	`).all();
}

/**
 * Rows where the gate moved nothing: emitted >= raw and no read was prevented.
 * These are the honest "why did this not save?" list — an unknown content type,
 * a payload already at budget, or a surface that is not governed at all.
 */
function noSaving(limit = 40) {
	return db.prepare(`
		SELECT ts, tool_name, surface, content_type, first_layer, raw_tokens, emitted_tokens,
		       tool_emitted_savings, prevented_read_tokens, adapter_missing, note
		FROM events
		WHERE raw_tokens > 0
		  AND COALESCE(tool_emitted_savings, 0) <= 0
		  AND COALESCE(prevented_read_tokens, 0) <= 0
		ORDER BY raw_tokens DESC LIMIT ${Math.max(1, Math.floor(limit))}
	`).all();
}

const PERIODS = {
	hour: { fmt: "%Y-%m-%d %H:00", label: "Hourly" },
	day: { fmt: "%Y-%m-%d", label: "Daily" },
	week: { fmt: "%Y-W%W", label: "Weekly" },
	month: { fmt: "%Y-%m", label: "Monthly" },
	year: { fmt: "%Y", label: "Yearly" },
};

function apiData(requested = "") {
	// A pre-host ledger cannot answer a per-host question; serve it unfiltered.
	const host = HAS_HOST && HOST_RE.test(requested) ? requested : "";
	if (host !== dbHost) {
		try {
			db.close();
		} catch {
			/* a read-only handle that will not close is not worth a 500 */
		}
		db = openLedger(host);
		dbHost = host;
	}
	const events = db
		.prepare(`SELECT ${EVENT_FIELDS} FROM events ORDER BY ts DESC LIMIT 500`)
		.all()
		.map((e) => ({ ...e, key: undefined }));
	const periods = {};
	for (const [k, p] of Object.entries(PERIODS)) periods[k] = { label: p.label, buckets: timeBuckets(p.fmt) };
	return {
		generated_at: new Date().toISOString(),
		project: projectRoot,
		host: host || null,
		host_caps: hostCaps(host),
		host_filter_dropped: Boolean(requested) && !host,
		tokenizer: TOKENIZER_ID,
		totals: totals(),
		savings: savingsByChannel(),
		hits: hitMiss(),
		byLayer: groupBy("first_layer").filter((r) => r.key !== "(none)"),
		byTool: groupBy("tool_name"),
		bySurface: groupBy("surface"),
		byAdapter: groupBy("adapter_used").filter((r) => r.key !== "(none)"),
		bySession: groupBy("session_id").filter((r) => r.key !== "(none)"),
		byContentType: groupBy("content_type").filter((r) => r.key !== "(none)"),
		bySuccess: groupBy("success"),
		topConsumers: topConsumers(15),
		noSaving: noSaving(40),
		periods,
		events,
	};
}

// ─── html (single file, no external assets; charts hand-rolled SVG) ───

const HTML = readFileSync(join(HERE, "dashboard.html"), "utf8");

// ─── server ───

const server = createServer((req, res) => {
	if (req.url === "/" || req.url === "/index.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(HTML);
		return;
	}
	if (req.url === "/api/data" || req.url?.startsWith("/api/data?")) {
		try {
			const wanted = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("host") ?? "";
			const data = apiData(wanted);
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(data));
		} catch (err) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
		return;
	}
	res.writeHead(404);
	res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
	console.log(`ContextMind dashboard — http://127.0.0.1:${port}`);
	console.log(`  project: ${projectRoot}`);
	console.log(`  db:      ${dbPath} (read-only)`);
	console.log("  refresh: page auto-reloads every 15s; Ctrl+C to stop");
});
