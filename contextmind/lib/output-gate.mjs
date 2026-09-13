/**
 * Output Gate (spec 12) — the pipeline every governed surface funnels through.
 *
 * Order matters and is not negotiable:
 *   count -> fast path -> dedup -> handle raw -> first layer -> structural
 *   reduce -> preservation check -> ABSTAIN
 *
 * Handle-then-compress is deliberate: reversibility is established before
 * anything is thrown away, so a later failure in the compressor cannot turn
 * into lost evidence. The preservation check at the end is the belt to that
 * braces — if a failure-shaped payload comes back missing its critical lines,
 * we give the model the raw text back rather than a tidy summary of nothing
 * (spec P5: failure defaults to fidelity).
 */

import { classify, criticalLines } from "./classify.mjs";
import { duplicateStub, fingerprint } from "./dedup.mjs";
import { compress } from "./engine.mjs";
import { countTokens, truncateFromTokens, truncateToTokens } from "./tokens.mjs";

/**
 * How much raw text we will hand back when the gate abstains. Bounded because
 * "preserve everything" is not a policy for a 40MB build log, but generous
 * enough that any real failure evidence survives intact.
 */
const ABSTAIN_CAP_TOKENS = 20_000;

/** Fraction of critical lines that may go missing before we abstain. */
const PRESERVATION_TOLERANCE = 0.2;

const STOPWORDS = new Set([
	"the", "and", "for", "with", "this", "that", "from", "error", "failed", "passed",
	"test", "tests", "line", "warning", "info", "at", "assert", "expected", "actual",
]);

/**
 * The identifiers a critical line exists to carry.
 *
 * A structured report preserves a failure by restating its facts, not by
 * replaying the line it came from — `FAILED test_a.py::test_x - assert 1 == 2`
 * becomes a JSON object with the same test id and the same values. Comparing
 * lines verbatim therefore reports every structured report as lossy and makes
 * the gate abstain on exactly the cases the adapter was built for. Matching on
 * identifiers (test id, file:line, exception name) is the contract spec 12.3
 * actually states: the *information* survives.
 */
function salientTokens(line) {
	const out = new Set();
	for (const m of line.match(/[A-Za-z_][\w$./\\-]{3,}/g) ?? []) {
		if (!STOPWORDS.has(m.toLowerCase())) out.add(m);
	}
	for (const m of line.match(/[\w./\\-]+:\d+/g) ?? []) out.add(m);
	// A summary banner's entire payload is its counts and duration; the `====`
	// padding around it is decoration. "1 failed, 127 passed in 3.42s" is what
	// has to survive, in whatever phrasing the report uses.
	for (const m of line.match(/\d+(?:\.\d+)?\s*(?:failed|passed|errors?|skipped|warnings?|todo)/gi) ?? []) {
		out.add(m.replace(/\s+/g, " ").toLowerCase());
	}
	for (const m of line.match(/\bin\s+\d+(?:\.\d+)?m?s\b/gi) ?? []) out.add(m.toLowerCase());
	if (out.size === 0) {
		const stripped = line.replace(/^[=\-*\s]+|[=\-*\s]+$/g, "").trim();
		if (stripped) return [stripped.slice(0, 60)];
		return [];
	}
	return [...out];
}

function lineCovered(line, haystack) {
	const tokens = salientTokens(line);
	if (tokens.length === 0) return haystack.includes(line.trim().slice(0, 40));
	// Case-insensitive: reports reformat identifiers freely, and a case
	// difference is not lost evidence.
	const lower = haystack.toLowerCase();
	return tokens.every((t) => lower.includes(t.toLowerCase()));
}

export function budgetFor(cfg, { surface = "shell", failure = false } = {}) {
	if (surface === "orient") return cfg.budget.orient;
	if (surface === "find") return cfg.budget.find;
	if (surface === "impact") return cfg.budget.impact;
	if (surface === "mcp") return failure ? cfg.budget.mcp_error : cfg.budget.mcp_default;
	if (surface === "tool") return failure ? cfg.budget.get : cfg.budget.get;
	return failure ? cfg.budget.shell_failure : cfg.budget.shell_success;
}

/**
 * Structural reduce: keep the head, every critical line, and the tail.
 *
 * Head-only truncation is what spec 11.4 rules out as a sole strategy — the
 * build result, the assertion summary and the final stack frames all live at
 * the end. Critical lines are spliced back in their original order so a reader
 * sees one coherent excerpt rather than three concatenated fragments.
 */
export function structuralReduce(raw, { type, budgetTokens, critical = [] }) {
	const lines = raw.split("\n");
	if (lines.length === 0) return "";

	const headTokens = Math.floor(budgetTokens * 0.4);
	const tailTokens = Math.floor(budgetTokens * 0.25);
	const critTokens = budgetTokens - headTokens - tailTokens;

	let head = takeTokensFrom(lines, 0, headTokens, "head");
	let tail = takeTokensFrom(lines, Math.max(head.end, 0), tailTokens, "tail");

	// Window fallback. When the first line alone exceeds the head budget — a
	// single-line JSON payload (`json.dumps` / `JSON.stringify` default, i.e. the
	// shape most MCP tools return), or any no-newline blob — line packing yields
	// an empty head *and* an empty tail, and the payload would be replaced by its
	// own omission markers. That is silent data loss, and because `json` is
	// classified as non-failure the preservation check never fires to catch it.
	// Window the raw text instead so content always survives.
	let windowed = false;
	if (head.text.trim() === "" && tail.text.trim() === "") {
		windowed = true;
		head = { text: truncateToTokens(raw, headTokens), omitted: 0 };
		tail = { text: truncateFromTokens(raw, tailTokens), omitted: 0 };
	}

	const critLines = [];
	let used = 0;
	for (const line of critical) {
		const t = countTokens(line);
		if (used + t > critTokens) break;
		critLines.push(line);
		used += t;
	}

	const parts = [];
	parts.push(head.text.trimEnd());
	if (windowed) {
		const kept = head.text.length + tail.text.length;
		parts.push(`\n... [${Math.max(0, raw.length - kept)} chars omitted] ...\n`);
	} else if (head.omitted > 0) {
		parts.push(`\n... [${head.omitted} lines omitted] ...\n`);
	}
	if (critLines.length > 0) {
		parts.push(`\n--- critical evidence (${critLines.length} lines) ---\n`);
		parts.push(critLines.join("\n"));
	}
	if (!windowed && tail.omitted > 0) parts.push(`\n... [${tail.omitted} lines omitted] ...\n`);
	if (tail.text.trim()) parts.push(`\n${tail.text.trim()}`);

	return truncateToTokens(parts.join("\n"), budgetTokens + Math.floor(budgetTokens * 0.1));
}

function takeTokensFrom(lines, start, tokenBudget, mode) {
	let used = 0;
	const picked = [];
	if (mode === "head") {
		for (let i = start; i < lines.length; i++) {
			const t = countTokens(lines[i]) + 1;
			if (used + t > tokenBudget) return { text: picked.join("\n"), end: i, omitted: lines.length - i };
			used += t;
			picked.push(lines[i]);
		}
		return { text: picked.join("\n"), end: lines.length, omitted: 0 };
	}
	for (let i = lines.length - 1; i >= start; i--) {
		const t = countTokens(lines[i]) + 1;
		if (used + t > tokenBudget) {
			return { text: picked.reverse().join("\n"), end: i + 1, omitted: i + 1 - start };
		}
		used += t;
		picked.push(lines[i]);
	}
	return { text: picked.reverse().join("\n"), end: start, omitted: 0 };
}

function handleFooter({ rawTokens, emittedTokens, method, handleId, contentType, budget, note }) {
	const bits = [
		`[contextmind] ${rawTokens} -> ${emittedTokens} tok`,
		`type=${contentType}`,
		`method=${method}`,
		`budget=${budget}`,
	];
	if (handleId) bits.push(`handle=${handleId}`);
	if (note) bits.push(note);
	return `\n${bits.join(" ")}`;
}

/**
 * Run the gate.
 *
 * @param {object} args
 * @param {string} args.raw          The payload that would otherwise enter the window.
 * @param {string} [args.cmd]        Originating command, when there is one.
 * @param {string} [args.toolName]
 * @param {"shell"|"mcp"|"tool"} [args.surface]
 * @param {number|null} [args.budgetTokens] Caller-supplied budget (an MCP tool
 *   profile), used instead of the surface default for non-failure payloads.
 * @param {number|null} [args.exitCode]
 * @param {object} args.cfg
 * @param {import('./handles.mjs').HandleStore} args.handles
 * @param {import('./dedup.mjs').Dedup} [args.dedup]
 * @param {string} [args.sessionId]
 * @param {string} [args.source]     Human label for provenance.
 * @param {string} [args.freshness]  Extra dedup key: file mtime/hash, tool input fingerprint.
 */
export function runOutputGate({
	raw,
	cmd,
	toolName,
	surface = "shell",
	exitCode = null,
	budgetTokens = null,
	cfg,
	handles,
	dedup = null,
	sessionId = null,
	source = null,
	freshness = null,
}) {
	const started = performance.now();
	const rawText = raw ?? "";
	const rawTokens = countTokens(rawText);

	const cls = classify(rawText, cmd);
	const failure =
		typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode !== 0 : cls.failure;
	const contentType = cls.type;
	const budget =
		!failure && Number.isFinite(budgetTokens) ? budgetTokens : budgetFor(cfg, { surface, failure });

	const finish = (text, extra = {}) => ({
		text,
		rawTokens,
		emittedTokens: countTokens(text),
		contentType,
		failure,
		budget,
		abstained: false,
		dedupHit: false,
		handleId: null,
		method: "passthrough",
		latencyMs: performance.now() - started,
		engineLatencyMs: 0,
		note: null,
		...extra,
	});

	// spec 45.1: already inside budget — do not pay for compression.
	if (rawTokens <= budget) return finish(rawText, { method: "passthrough" });

	// Dedup before anything else: the cheapest token is the one never emitted.
	if (dedup?.available) {
		const fp = fingerprint(freshness ?? "", contentType, rawText);
		const hit = dedup.lookup(fp, sessionId);
		if (hit) {
			const stub = duplicateStub({
				handleId: hit.handleId,
				source: source ?? toolName ?? cmd,
				firstSeen: hit.firstSeen,
				hits: hit.hits,
			});
			return finish(stub, { method: "dedup_stub", dedupHit: true, handleId: hit.handleId });
		}
	}

	// Reversibility first.
	const handleId = handles?.available
		? handles.put(rawText, {
				sessionId,
				toolName,
				command: cmd,
				contentType,
				sourceType: surface,
				provenance: source,
			})
		: null;

	if (dedup?.available) {
		dedup.record(fingerprint(freshness ?? "", contentType, rawText), {
			sessionId,
			source: source ?? toolName ?? cmd,
			handleId,
			rawTokens,
		});
	}

	// First layer: the locked single owner. Never enlarges the payload.
	let text = rawText;
	let method = "raw_oversized";
	let engineLatencyMs = 0;
	let note = null;
	if (cfg.shell.first_layer === "cc_balanced") {
		const res = compress(rawText, cmd, { mode: cfg.engine.mode });
		engineLatencyMs = res.latencyMs;
		if (res.ok && countTokens(res.output) < countTokens(text)) {
			text = res.output;
			method = "cc_balanced";
		} else if (!res.ok) {
			note = `engine_unavailable(${res.error})`;
		}
	}

	const critical = criticalLines(rawText, contentType);

	// Second layer: only when the first layer is still over budget.
	if (countTokens(text) > budget) {
		const reduced = structuralReduce(rawText, { type: contentType, budgetTokens: budget, critical });
		if (countTokens(reduced) < countTokens(text)) {
			text = reduced;
			method = `${method}+structural`;
		}
	}

	// Preservation check. A failure payload that lost its evidence is worse
	// than an uncompressed one; give the raw back, capped and still reversible.
	if (failure && critical.length > 0) {
		const missing = critical.filter((line) => !lineCovered(line, text)).length;
		if (missing / critical.length > PRESERVATION_TOLERANCE) {
			// Abstain means "fidelity over savings", not "fidelity and a bigger
			// bill": a footer that pushes the payload past its raw size would make
			// the ledger report negative savings on exactly the runs we tried to
			// protect. Provenance is still recorded in telemetry.
			const rawCapped = truncateToTokens(rawText, ABSTAIN_CAP_TOKENS);
			const footer = handleFooter({
				rawTokens,
				emittedTokens: countTokens(rawCapped),
				method: "ABSTAIN",
				handleId,
				contentType,
				budget,
				note: `preservation contract failed (${missing}/${critical.length} critical facts lost); returning raw`,
			});
			const withFooter = rawCapped + footer;
			const text_out = countTokens(withFooter) <= rawTokens ? withFooter : rawCapped;
			return finish(
				text_out,
				{
					method: "ABSTAIN",
					handleId,
					abstained: true,
					engineLatencyMs,
					note: `abstain: ${missing}/${critical.length} critical facts lost`,
				},
			);
		}
	}

	return (
		finish(
			text.trimEnd() +
				handleFooter({
					rawTokens,
					emittedTokens: countTokens(text),
					method,
					handleId,
					contentType,
					budget,
					note,
				}),
			{ method, handleId, engineLatencyMs, note },
		)
	);
}
