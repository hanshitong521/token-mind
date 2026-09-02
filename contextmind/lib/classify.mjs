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
const GREP_LINE = /^[^:]+:\d+:/m;

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
 */
export function criticalLines(text, type) {
	const lines = text.split("\n");
	const keep = new Set();

	const mark = (re, cap = 25) => {
		let n = 0;
		for (let i = 0; i < lines.length && n < cap; i++) {
			if (re.test(lines[i])) {
				keep.add(i);
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
	mark(/^(fatal|panic):/m, 20);

	if (type === "test_log") {
		mark(/^\s*=+\s+.*(failed|passed|error).*=+\s*$/m, 5);
		mark(/^\s*(E\s+assert|>\s+E\s+|assert\s)/m, 40);
	}
	if (type === "git_diff") {
		mark(/^diff --git /, 200);
		mark(/^@@ /, 200);
		mark(/^(new file|deleted file|similarity index|rename from|rename to)/, 60);
	}
	if (type === "json") {
		mark(/"(error|errors|message|status|code|exception)"\s*:/, 20);
	}
	if (type === "build_log") {
		mark(/^(BUILD (SUCCESSFUL|FAILED)|\[INFO\] BUILD (SUCCESS|FAILURE))/m);
		mark(/^> Task .* FAILED/m, 40);
		mark(/^e:\s|^\/(.+):\s(error|warning):/m, 40);
	}

	return [...keep].sort((a, b) => a - b).map((i) => lines[i]);
}
