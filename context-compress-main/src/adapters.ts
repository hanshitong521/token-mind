/**
 * Structured tool adapters.
 *
 * For tools with a fixed output contract (pytest, jest/vitest, gradle/maven),
 * parsing beats compressing: the counts, failing tests, and first error lines
 * the agent needs are extracted deterministically instead of heuristically
 * kept, so the report is small AND evidence-complete.
 *
 * Two routing channels feed the same parsers:
 *   - command-keyed: the invoked command names the tool (pytest, gradle, npm test);
 *   - shape-keyed:   stdin-only buffers (the `filter` CLI path has no command
 *                    context) are sniffed via strong anchors — pytest header +
 *                    counts footer, jest Suites/Tests pair, BUILD result line.
 *
 * Adapters must never guess: an unmatched tool returns null and the caller
 * falls through to the regular pipeline. No LLM calls, ever.
 */
import type { FilterResult } from "./filters.js";

interface Failure {
	id: string;
	error?: string;
	loc?: string;
	/** The tool's own phrasing of this failure line, preserved verbatim. */
	line?: string;
}

interface ToolReport {
	tool: string;
	/** Human summary line, verbatim count phrasing (e.g. "1 failed, 127 passed in 3.42s"). */
	summary: string;
	data: Record<string, unknown>;
}

const MAX_FAILURES = 50;

function parseCounts(text: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const m of text.matchAll(/(\d+)\s+(failed|passed|errors?|skipped|warnings?|todo|deselected|xfailed|xpassed)/g)) {
		const key = m[2].replace(/s$/, "");
		counts[key] = (counts[key] ?? 0) + Number(m[1]);
	}
	return counts;
}

function parseDuration(text: string): number | undefined {
	const m = text.match(/\bin\s+([\d.]+)(m\d+)?s?\b/);
	if (m) return Number(m[1]) + (m[2] ? Number(m[2].slice(1)) / 60 : 0);
	const m2 = text.match(/Total time:\s+([\d.]+)\s*s/);
	if (m2) return Number(m2[1]);
	return undefined;
}

function render(report: ToolReport, sourceLines: number): FilterResult {
	const failures = report.data.failures as Failure[] | undefined;
	const data: Record<string, unknown> = { ...report.data };
	if (failures && failures.length > MAX_FAILURES) {
		data.failures = failures.slice(0, MAX_FAILURES);
		data.failures_truncated = `${failures.length - MAX_FAILURES} more not shown`;
	}
	const header = `[tool_report ${report.tool}] ${report.summary}`;
	return {
		output: `${header}\n${JSON.stringify(data)}\n[+${sourceLines} lines omitted — structured ${report.tool} report above is complete]`,
		filtered: true,
	};
}

// ---------- pytest ----------

function parsePytest(out: string): ToolReport | null {
	const tail = out.match(/^\s*=+\s*(.+?\b(?:failed|passed|error|no tests ran)\b.*?)\s+in\s+([\d.]+)s\s*=+\s*$/m);
	if (!tail) return null;
	const counts = parseCounts(tail[1]);
	const failures: Failure[] = [];
	for (const m of out.matchAll(/^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.*))?$/gm)) {
		const id = m[2];
		const file = id.split("::")[0];
		const loc = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):`, "m").exec(out);
		failures.push({ id, error: m[3], loc: loc ? `${file}:${loc[1]}` : undefined, line: m[0].trim() });
	}
	return {
		tool: "pytest",
		summary: `${tail[1]} in ${tail[2]}s`,
		data: { ...counts, duration_s: Number(tail[2]), failures, no_tests_ran: tail[1].includes("no tests ran") || undefined },
	};
}

// ---------- jest / vitest ----------

function parseJest(out: string): ToolReport | null {
	const suites = out.match(/^Test Suites:\s+(.*)$/m);
	const tests = out.match(/^Tests:\s+(.*)$/m);
	if (!suites || !tests) return null;
	const counts = { ...parseCounts(suites[1]), ...parseCounts(tests[1]) };
	// Jest badges FAIL with a leading space (" FAIL  src/a.test.ts"); anchor on
	// the line break so the summary line "Test Suites: 2 failed" never matches.
	const suiteMatches = [...out.matchAll(/(^|\n)\s*FAIL\s+(\S+)/g)];
	const failures: Failure[] = suiteMatches.map((m, i) => {
		const suite = m[2];
		const blockStart = m.index + m[1].length;
		const blockEnd = i + 1 < suiteMatches.length ? suiteMatches[i + 1].index : out.length;
		const block = out.slice(blockStart, blockEnd);
		const caseLine = block.match(/^\s*●\s+(.+?)\s+›\s+(.+)$/m);
		const errLine = block.match(/^\s{2,}(.*(?:expect\(|Error|assert).*?)\s*$/m);
		return {
			id: caseLine ? `${suite} › ${caseLine[1]} › ${caseLine[2]}` : suite,
			error: errLine?.[1]?.trim(),
			line: `FAIL ${suite}`,
		};
	});
	return {
		tool: "jest",
		summary: `Tests: ${tests[1]}`,
		data: { ...counts, suites: suites[1], failing_suites: suiteMatches.map((m) => m[2]), failures },
	};
}

// ---------- gradle / maven ----------

function parseBuild(out: string): ToolReport | null {
	const gradle = out.match(/^\s*BUILD (SUCCESSFUL|FAILED)(?:\s+in\s+([\d.]+m?s))?/m);
	const maven = out.match(/^\[INFO\] BUILD (SUCCESS|FAILURE)\s*$/m);
	if (!gradle && !maven) return null;
	const result = (gradle?.[1] ?? maven?.[1]) === "SUCCESS" || gradle?.[1] === "SUCCESSFUL" ? "success" : "failure";
	const duration = gradle?.[2] ? gradle[2] : parseDuration(out);
	const failures: Failure[] = [];
	for (const m of out.matchAll(/^> Task (.+?) FAILED/mg)) failures.push({ id: m[1] });
	for (const m of out.matchAll(/^\[ERROR\]\s+(Tests run: .*|\S+\.java.*)$/gm)) {
		if (!failures.some((f) => m[1].includes(f.id))) failures.push({ id: m[1] });
	}
	const whatWentWrong = out.match(/^\* What went wrong:\s*\n([\s\S]{0,400}?)(?:\n\* Try:|\n\* Exception is:)/m)?.[1]?.trim().split("\n")[0];
	const data: Record<string, unknown> = {
		result,
		duration_s: duration ? String(duration).replace(/m(\d+)s?$/, ".$1") : undefined,
		failures: failures.length ? failures : undefined,
		what_went_wrong: whatWentWrong,
	};
	// Embed matched lines verbatim: downstream checks (bench critical
	// substrings, humans diffing reports) expect the tool's own phrasing.
	const totalLine = out.match(/^\[INFO\] Total time:.*$/m)?.[0];
	const summaryLine = gradle
		? `BUILD ${gradle[1]}${gradle[2] ? ` in ${gradle[2]}` : ""}`
		: `[INFO] BUILD ${maven?.[1]}${totalLine ? ` | ${totalLine}` : ""}`;
	return { tool: "build", summary: summaryLine, data };
}

// ---------- routing ----------

const CMD_HINTS: Array<[RegExp, (out: string) => ToolReport | null]> = [
	[/\b(pytest|py\.test)\b/, parsePytest],
	[/\b(jest|vitest)\b|\b(npm|yarn|pnpm|bun)\s+(test|run\s+test)\b/, parseJest],
	[/\b(gradle|gradlew|mvn)\b/, parseBuild],
];

const SHAPE_ORDER = [parsePytest, parseJest, parseBuild];

/**
 * Parse a structured report from tool output. Tries the command-keyed channel
 * first, then (only when no command is known) the shape-sniffing channel —
 * with `cmd` present a shape misfire must not override what the command says.
 */
export function applyToolAdapter(cmd: string | undefined, stdout: string): ToolReport | null {
	if (cmd) {
		for (const [re, parse] of CMD_HINTS) {
			if (re.test(cmd)) return parse(stdout);
		}
		return null;
	}
	for (const parse of SHAPE_ORDER) {
		const report = parse(stdout);
		if (report) return report;
	}
	return null;
}

/** Entry for the filter pipeline: null means "not a known tool, fall through". */
export function runToolAdapter(cmd: string | undefined, stdout: string): FilterResult | null {
	const report = applyToolAdapter(cmd, stdout);
	if (!report) return null;
	return render(report, stdout.split("\n").length - 1);
}
