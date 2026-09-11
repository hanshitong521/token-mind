/**
 * Content classification for the Output Gate (spec 12.2).
 *
 * Deterministic only — no LLM, no network. Every classifier is an anchor test
 * with a reason, because a wrong classification picks the wrong reducer and the
 * wrong reducer is how evidence gets dropped (spec P5).
 */

export const CONTENT_TYPES = [
	"json",
	"tabular",
	"build_log",
	"test_log",
	"stacktrace",
	"git_diff",
	"git_log",
	"grep",
	"source",
	"generic",
];

const JAVA_FRAME = /^\s+at\s+[\w$.<>]+\([\w$.]+:\d+\)/m;
const PYTHON_FRAME = /^\s+File "[^"]+", line \d+, in /m;
const BUILD_TOOL = /^\[INFO\]\s|^(BUILD SUCCESSFUL|BUILD FAILED)|^> Task /m;
const TEST_COUNTS = /Tests run:|\d+ (?:failed|passed)|Test Suites:|^=+ .*(?:failed|passed|error).*=+$/m;
const DIFF_HEADER = /^(diff --git |--- [^\n]+\n\+\+\+ |@@ -\d+)/m;
const GIT_LOG_LINE = /^commit [0-9a-f]{7,40}\b/m;
const GREP_LINE = /^(?=[^\s:]*[/.])[^\s:]+:\d+:/m;

/**
 * Classify a payload. `cmd` is the originating command when known — it is the
 * strongest signal available and must win over shape sniffing, the same
 * precedence the engine's tool adapters use.
 */
export function classify(text, cmd) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { type: "generic", reason: "empty", failure: false };

	if (cmd) {
		const byCmd = classifyByCommand(cmd, trimmed);
		// A command hint is a prior, not a verdict: `git log` piped through a
		// test runner can still be a test log, and the reducers differ.
		if (byCmd) return byCmd;
	}

	if (looksLikeJson(trimmed)) return { type: "json", reason: "shape", failure: false };
	if (DIFF_HEADER.test(trimmed)) return { type: "git_diff", reason: "shape", failure: false };
	if (GIT_LOG_LINE.test(trimmed)) return { type: "git_log", reason: "shape", failure: false };
	if (JAVA_FRAME.test(trimmed) || PYTHON_FRAME.test(trimmed)) {
		return { type: "stacktrace", reason: "shape", failure: true };
	}
	if (TEST_COUNTS.test(trimmed)) return { type: "test_log", reason: "shape", failure: isFailure(trimmed, 0) };
	if (BUILD_TOOL.test(trimmed)) return { type: "build_log", reason: "shape", failure: isFailure(trimmed, 0) };
	if (looksLikeGrep(trimmed)) return { type: "grep", reason: "shape", failure: false };
	if (looksLikeTabular(trimmed)) return { type: "tabular", reason: "shape", failure: false };
	if (looksLikeSource(trimmed)) return { type: "source", reason: "shape", failure: false };
	return { type: "generic", reason: "fallback", failure: false };
}

function classifyByCommand(cmd, text) {
	const c = cmd.trim();
	if (/^git\s+(diff|show)\b/.test(c)) return { type: "git_diff", reason: "cmd", failure: false };
	if (/^git\s+log\b/.test(c)) return { type: "git_log", reason: "cmd", failure: false };
	if (/^git\s+(status|branch|ls-files|blame)\b/.test(c)) return { type: "generic", reason: "cmd", failure: false };
	if (/\b(pytest|py\.test|jest|vitest|mocha|go test|mvn test|gradle test|cargo test)\b/.test(c)) {
		return { type: "test_log", reason: "cmd", failure: isFailure(text, 0) };
	}
	if (/\b(mvn|mvnw|gradle|gradlew|cargo build|make|npm run build|tsc)\b/.test(c)) {
		return { type: "build_log", reason: "cmd", failure: isFailure(text, 0) };
	}
	if (/^(find|grep|rg|fd|ag|ripgrep)\b/.test(c)) {
		return { type: "grep", reason: "cmd", failure: false };
	}
	return null;
}

function looksLikeJson(text) {
	if (!/^[[{]/.test(text)) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return looksLikeNdjson(text);
	}
}

function looksLikeNdjson(text) {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 2) return false;
	let ok = 0;
	for (const line of lines.slice(0, 20)) {
		try {
			JSON.parse(line);
			ok++;
		} catch {
			/* not ndjson */
		}
	}
	return ok >= Math.min(2, lines.length);
}

function looksLikeGrep(text) {
	const lines = text.split("\n").filter((l) => l.trim().length > 0).slice(0, 40);
	if (lines.length < 3) return false;
	const hits = lines.filter((l) => GREP_LINE.test(l)).length;
	return hits / lines.length > 0.6;
}

function looksLikeTabular(text) {
	if (/^[{[]/.test(text)) return false;
	const lines = text.split("\n").filter((l) => l.trim().length > 0).slice(0, 30);
	if (lines.length < 3) return false;
	const pipe = lines.filter((l) => l.includes("|")).length;
	const tsv = lines.filter((l) => /\t/.test(l)).length;
	return (pipe > 0 && pipe / lines.length > 0.6) || tsv / lines.length > 0.6;
}

const SOURCE_ANCHORS = [
	/^\s*(public|private|protected|package|import|class|interface|enum|function|const|def|func)\b/m,
	/^\s*(package|import)\s+[\w.]+;/m,
	/^\s*@(Override|Autowired|Service|Repository|RestController|GetMapping|PostMapping)\b/m,
	/^\s*<\?xml|^\s*<(select|insert|update|delete|mapper)\b/m,
];

function looksLikeSource(text) {
	const head = text.slice(0, 4000);
	return SOURCE_ANCHORS.some((re) => re.test(head));
}

/**
 * Failure detection. `exitCode` is authoritative when it is a number; the text
 * anchors only decide when the caller did not supply one (the MCP path often
 * has no exit code).
 */
export function isFailure(text, exitCode) {
	if (typeof exitCode === "number" && exitCode !== 0) return true;
	const head = text.slice(0, 20000);
	return (
		JAVA_FRAME.test(head) ||
		PYTHON_FRAME.test(head) ||
		/\bBUILD (FAILED|FAILURE)\b/.test(head) ||
		/\b(ERROR|FAIL|FAILED|Exception|AssertionError|error TS\d+)\b/.test(head)
	);
}

/**
 * Critical lines a reducer must never drop (spec 12.3 Preservation Contract).
 * Returned as the raw lines in their original order, ready to be spliced back.
 *
 * Two things the line-oriented form cannot express, both added after measuring
 * real payloads against Headroom:
 *
 *  1. **Severity order.** A build log with 40 `ERROR` lines and one `FATAL` is
 *     not 41 equivalent facts. The reducer's critical budget is finite, so when
 *     it runs out the line that must survive is the FATAL — not whichever ERROR
 *     happened to sit earliest in the file. Tier-1 lines (FATAL/CRITICAL/SEVERE/
 *     PANIC) are therefore emitted first.
 *  2. **Single-line JSON.** `json.dumps` / `JSON.stringify` default output has no
 *     newlines, so the whole payload is one line and every `mark()` below either
 *     matches that one line (keeping 55 KB) or nothing at all. The preservation
 *     contract was structurally inoperative on the shape most MCP tools return.
 *     `jsonCriticalFacts` extracts the salient *values* instead.
 */
export function criticalLines(text, type) {
	const lines = text.split("\n");
	const keep = new Set();
	const tier1 = new Set();

	const mark = (re, cap = 25, tier = 2) => {
		let n = 0;
		for (let i = 0; i < lines.length && n < cap; i++) {
			if (re.test(lines[i])) {
				keep.add(i);
				if (tier === 1) tier1.add(i);
				n++;
			}
		}
	};

	mark(/^\s+at\s+[\w$.<>]+\(/, 15);
	mark(/^\s+File "[^"]+", line \d+/, 15);
	mark(/\b(BUILD (FAILED|FAILURE)|BUILD SUCCESS)\b/);
	mark(/^\[ERROR\]/m, 40);
	mark(/^\s*(FAILED|ERROR)\s+\S+/, 50);
	mark(/\bTests? run:.*(Failures|Errors):\s*[1-9]/);
	mark(/^(#+\s*)?(AssertionError|Exception|Error|Caused by|Suppressed):/m, 20);
	mark(/^error(\[[E0-9]+\]| TS\d+)?:/m, 30);
	mark(/^npm ERR!/m, 30);
	mark(/^(fatal|panic):/m, 20, 1);

	// Timestamp-prefixed service logs. Every pattern above assumes the level
	// starts the line, which is the minority format in practice — most logs read
	// `2026-09-10T14:00:00Z ERROR [api] ...`. Without these, a FATAL buried in a
	// timestamped log is not "critical" and the preservation contract never sees
	// it, so the one line the operator needed is the one that gets dropped.
	mark(/(?:^|\s)(FATAL|CRITICAL|SEVERE|PANIC)(?=\s|:)/, 30, 1);
	mark(/(?:^|\s)ERROR(?=\s|:)/, 40);

	if (type === "test_log") {
		mark(/^\s*=+\s+.*(failed|passed|error).*=+\s*$/m, 5);
		mark(/^\s*(E\s+assert|>\s+E\s+|assert\s)/m, 40);
	}
	if (type === "git_diff") {
		mark(/^diff --git /, 200);
		mark(/^@@ /, 200);
		mark(/^(new file|deleted file|similarity index|rename from|rename to)/, 60);
	}
	if (type === "build_log") {
		mark(/^(BUILD (SUCCESSFUL|FAILED)|\[INFO\] BUILD (SUCCESS|FAILURE))/m, 25, 1);
		mark(/^> Task .* FAILED/m, 40);
		mark(/^e:\s|^\/(.+):\s(error|warning):/m, 40);
	}

	const ordered = [...keep].sort((a, b) => a - b);
	const prioritized = [
		...ordered.filter((i) => tier1.has(i)),
		...ordered.filter((i) => !tier1.has(i)),
	];

	// JSON is frequently one line, where line marks cannot help. Extract the
	// values a reader needs (error text, status, message) and put them first:
	// they are the payload's whole point, so they must outrank everything else
	// for the critical budget.
	const facts = type === "json" && lines.length <= 3 ? jsonCriticalFacts(text) : [];

	return [...facts, ...prioritized.map((i) => lines[i])];
}

const JSON_FACT_KEY =
	/^(error|errors|exception|exceptions|stack|stacktrace|traceback|failure|failures|panic|reason)$/i;
const JSON_ERRORISH =
	/\b(error|errors|exception|fail|failed|failure|refused|timeout|timed out|exhausted|denied|unauthorized|forbidden|panic|fatal|critical|not available|stack trace|traceback)\b/i;

/**
 * Salient string values inside a JSON payload, as literal substrings.
 *
 * Only *evidence* qualifies. Matching a broad key such as `message` would make
 * every row of a log-search result a "critical fact" — a 300-entry result set
 * then fills the whole fact budget with `Request processed successfully` and
 * crowds out the four error strings the reader actually needs. So a value is
 * taken when its key is inherently an error field, or when the value itself
 * reads like a failure.
 *
 * Bounded on purpose: this feeds a critical budget measured in hundreds of
 * tokens, so an unbounded walk over a 100 000-row result set would defeat the
 * reducer it is meant to protect.
 */
function jsonCriticalFacts(text, cap = 16) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const out = [];
	const seen = new Set();
	const push = (s) => {
		if (typeof s !== "string" || s.trim().length < 4) return;
		const t = (s.length > 160 ? s.slice(0, 160) : s).replace(/\s+/g, " ").trim();
		if (seen.has(t)) return;
		seen.add(t);
		out.push(t);
	};
	const walk = (node, key) => {
		if (out.length >= cap) return;
		if (Array.isArray(node)) {
			for (const v of node) {
				if (out.length >= cap) return;
				walk(v, key);
			}
			return;
		}
		if (node && typeof node === "object") {
			for (const [k, v] of Object.entries(node)) {
				if (out.length >= cap) return;
				walk(v, k);
			}
			return;
		}
		if (typeof node === "string" && ((key && JSON_FACT_KEY.test(key)) || JSON_ERRORISH.test(node))) {
			push(node);
		}
	};
	walk(parsed, null);
	return out;
}
