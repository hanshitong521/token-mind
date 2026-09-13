/**
 * Task / stack scorecard from telemetry notes + TaskBundle eval writeback.
 * Complements three-column token ledger — answers “did the stack hold?”.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadTaskBundle, taskFilePath } from "./task-bundle.mjs";
import { buildAgentManifest, writeAgentManifest } from "./agent-manifest.mjs";

/**
 * Aggregate governance quality from telemetry events table.
 * @param {import("./telemetry.mjs").Telemetry} telemetry
 * @param {{ since?: string|null, sessionId?: string|null, taskId?: string|null }} [opts]
 */
export function stackScorecard(telemetry, opts = {}) {
	if (!telemetry?.db) return null;
	const where = [];
	const args = [];
	if (opts.since) {
		where.push("ts >= ?");
		args.push(opts.since);
	}
	if (opts.sessionId) {
		where.push("session_id = ?");
		args.push(opts.sessionId);
	}
	if (opts.taskId) {
		where.push("task_id = ?");
		args.push(opts.taskId);
	}
	const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

	const totals = telemetry.db
		.prepare(
			`SELECT COUNT(*) AS events,
			        COALESCE(SUM(read_blocked), 0) AS read_blocked,
			        COALESCE(SUM(read_override), 0) AS read_override,
			        COALESCE(SUM(prevented_read_tokens), 0) AS prevented_read_tokens,
			        COALESCE(SUM(tool_emitted_savings), 0) AS tool_emitted_savings,
			        COALESCE(SUM(raw_tokens), 0) AS raw_tokens
			 FROM events ${w}`,
		)
		.get(...args);

	const noteRows = telemetry.db
		.prepare(`SELECT note, COUNT(*) AS n FROM events ${w ? `${w} AND` : "WHERE"} note IS NOT NULL GROUP BY note`)
		.all(...args);

	const notes = {};
	for (const r of noteRows) notes[String(r.note)] = Number(r.n);

	const countPrefix = (prefix) =>
		Object.entries(notes)
			.filter(([k]) => k.startsWith(prefix))
			.reduce((s, [, n]) => s + n, 0);

	const orient_ok = notes.orient_ok ?? 0;
	const orient_dup = notes.orient_dup ?? 0;
	const orient_cache_hit = notes.orient_cache_hit ?? 0;
	const orient_total = orient_ok + orient_dup + orient_cache_hit;
	const write_without_bundle = notes.write_without_bundle ?? 0;
	const write_denied_no_bundle = notes.write_denied_no_bundle ?? 0;
	const self_check_pass = notes.self_check_pass ?? 0;
	const self_check_fail = notes.self_check_fail ?? 0;
	const blocked_raw_codegraph = notes.blocked_raw_codegraph ?? 0;
	const task_scope_denies = countPrefix("task_scope:");
	const read_rule_denies = countPrefix("rule:");

	const orient_hit_rate =
		orient_total > 0 ? (orient_ok + orient_cache_hit) / orient_total : null;
	const self_check_rate =
		self_check_pass + self_check_fail > 0
			? self_check_pass / (self_check_pass + self_check_fail)
			: null;

	// Health 0–100: start 100, penalize dual-path / missing checks / overrides.
	let health = 100;
	if (orient_dup > 0) health -= Math.min(20, orient_dup * 5);
	if (write_without_bundle > 0) health -= Math.min(25, write_without_bundle * 5);
	if (write_denied_no_bundle > 0) health -= Math.min(10, write_denied_no_bundle * 2);
	if (self_check_fail > 0) health -= Math.min(30, self_check_fail * 15);
	if (self_check_pass === 0 && (totals.events ?? 0) > 20) health -= 10;
	if ((totals.read_override ?? 0) > 5) health -= 10;
	if (blocked_raw_codegraph > 0) health += Math.min(5, blocked_raw_codegraph); // enforcement working
	health = Math.max(0, Math.min(100, Math.round(health)));

	return {
		events: totals.events ?? 0,
		read_blocked: totals.read_blocked ?? 0,
		read_override: totals.read_override ?? 0,
		prevented_read_tokens: totals.prevented_read_tokens ?? 0,
		tool_emitted_savings: totals.tool_emitted_savings ?? 0,
		raw_tokens: totals.raw_tokens ?? 0,
		orient_ok,
		orient_dup,
		orient_cache_hit,
		orient_hit_rate,
		write_without_bundle,
		write_denied_no_bundle,
		self_check_pass,
		self_check_fail,
		self_check_rate,
		blocked_raw_codegraph,
		task_scope_denies,
		read_rule_denies,
		health,
		notes_top: Object.entries(notes)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([note, n]) => ({ note, n })),
	};
}

export function formatScorecard(sc, { title = "Stack Scorecard", period = "All time" } = {}) {
	if (!sc) return "# Stack Scorecard\n\n(unavailable)\n";
	const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
	const lines = [
		`# ${title}`,
		"",
		`Period: ${period}`,
		`Health: ${sc.health}/100`,
		"",
		`orient_hit_rate   ${pct(sc.orient_hit_rate)}  (ok=${sc.orient_ok} cache=${sc.orient_cache_hit ?? 0} dup=${sc.orient_dup})`,
		`self_check_rate   ${pct(sc.self_check_rate)}  (pass=${sc.self_check_pass} fail=${sc.self_check_fail})`,
		`read_blocked      ${sc.read_blocked}   overrides ${sc.read_override}`,
		`write_wo_bundle   ${sc.write_without_bundle}   denied ${sc.write_denied_no_bundle}`,
		`task_scope_denies ${sc.task_scope_denies}   raw_codegraph_blocks ${sc.blocked_raw_codegraph}`,
		`prevented_read    ${sc.prevented_read_tokens} tok   tool_savings ${sc.tool_emitted_savings} tok`,
		"",
	];
	if (sc.notes_top?.length) {
		lines.push("## Top notes", "");
		for (const r of sc.notes_top) lines.push(`- ${r.note}: ${r.n}`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Persist SELF-CHECK result onto TaskBundle.eval.self_check + refresh manifest.
 * @returns {{ updated: boolean, path?: string }}
 */
export function writeSelfCheckToBundle(projectRoot, cfg, { exitCode, command, at = null }) {
	const path = taskFilePath(projectRoot, cfg);
	if (!existsSync(path)) return { updated: false };
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { updated: false };
	}
	if (!raw || typeof raw !== "object") return { updated: false };
	raw.eval = raw.eval && typeof raw.eval === "object" ? raw.eval : {};
	raw.eval.self_check = {
		exit_code: exitCode,
		command: String(command || "").slice(0, 400),
		at: at || new Date().toISOString(),
	};
	raw.meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
	raw.meta.updated = new Date().toISOString().slice(0, 10);
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	try {
		writeAgentManifest(projectRoot, { cfg });
	} catch {
		/* manifest refresh is best-effort */
	}
	return { updated: true, path };
}

/**
 * Match shell command against TaskBundle eval.commands (normalized).
 */
export function matchEvalCommand(bundle, command) {
	const cmd = String(command || "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
	const evals = bundle?.eval?.commands ?? [];
	for (const e of evals) {
		const needle = String(e)
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim();
		if (!needle) continue;
		if (cmd.includes(needle) || needle.includes(cmd.slice(0, Math.min(80, cmd.length)))) {
			return e;
		}
	}
	return null;
}

export function projectScorecardView(projectRoot, cfg, telemetry, opts = {}) {
	const sc = stackScorecard(telemetry, opts);
	const loaded = loadTaskBundle(projectRoot, cfg);
	const manifest = buildAgentManifest(projectRoot, { cfg });
	return {
		scorecard: sc,
		task_id: loaded?.bundle?.id ?? null,
		goal: loaded?.bundle?.intent?.goal ?? null,
		self_check: loaded?.bundle?.eval?.self_check ?? null,
		route: manifest.route,
		gate_ready: manifest.what.gate_ready,
		health: sc?.health ?? null,
	};
}
