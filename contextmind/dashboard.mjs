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
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

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
const dbPath = join(projectRoot, ".contextmind", "telemetry.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

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
		       COALESCE(SUM(dedup_hit), 0) AS dedup,
		       COALESCE(SUM(handle_fetched), 0) AS fetched
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
		       COALESCE(SUM(dedup_hit), 0) AS dedup,
		       COALESCE(SUM(handle_created), 0) AS created,
		       COALESCE(SUM(handle_fetched), 0) AS fetched
		FROM events GROUP BY bucket ORDER BY bucket
	`).all().map((r) => ({ ...r, ratio: r.raw > 0 ? r.avoided / r.raw : null }));
}

const PERIODS = {
	hour: { fmt: "%Y-%m-%d %H:00", label: "Hourly" },
	day: { fmt: "%Y-%m-%d", label: "Daily" },
	week: { fmt: "%Y-W%W", label: "Weekly" },
	month: { fmt: "%Y-%m", label: "Monthly" },
	year: { fmt: "%Y", label: "Yearly" },
};

function apiData() {
	const events = db
		.prepare(`SELECT ${EVENT_FIELDS} FROM events ORDER BY ts DESC LIMIT 500`)
		.all()
		.map((e) => ({ ...e, key: undefined }));
	const periods = {};
	for (const [k, p] of Object.entries(PERIODS)) periods[k] = { label: p.label, buckets: timeBuckets(p.fmt) };
	return {
		generated_at: new Date().toISOString(),
		project: projectRoot,
		tokenizer: TOKENIZER_ID,
		totals: totals(),
		byTool: groupBy("tool_name"),
		bySurface: groupBy("surface"),
		byAdapter: groupBy("adapter_used").filter((r) => r.key !== "(none)"),
		bySession: groupBy("session_id").filter((r) => r.key !== "(none)"),
		byContentType: groupBy("content_type").filter((r) => r.key !== "(none)"),
		bySuccess: groupBy("success"),
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
	if (req.url === "/api/data") {
		try {
			const data = apiData();
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
