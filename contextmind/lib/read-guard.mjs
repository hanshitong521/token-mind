/**
 * Read Guard (spec 15) — the single biggest source of wasted context.
 *
 * A whole `*ServiceImpl.java` or a whole `*Mapper.xml` entering the window is
 * tens of thousands of tokens bought with nothing the task asked for. The
 * thresholds are calibrated against shejiuPro (spec 43): a Java Service without
 * a successful prior explore is denied past 80 lines, XML is only ever read as
 * a statement slice.
 *
 * Line counting is deliberately capped: we read at most LINE_SAMPLE_BYTES. If
 * the sample already crosses the threshold the answer is decided and reading
 * more would only pay for the very tokens we are trying to avoid.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { evaluatePathScope } from "./task-bundle.mjs";
import { FORBIDDEN_SCAN_HINT, forbiddenAgentScanPath } from "./path-guards.mjs";

const LINE_SAMPLE_BYTES = 8_192;

const JAVA_SERVICE = /(Service|ServiceImpl)\.java$/i;
const MAPPER_JAVA = /Mapper\.java$/i;
const MAPPER_XML = /Mapper\.xml$/i;
const JAVA = /\.java$/i;
const LONG_DOC = /(workflows|pitfalls-[^/\\]*|decided[^/\\]*)\.md$/i;

export function statFile(path) {
	try {
		const s = statSync(path);
		return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile() };
	} catch {
		return null;
	}
}

/** Newline count within the first `maxBytes`, plus whether the file ended there. */
export function lineSample(path, maxBytes = LINE_SAMPLE_BYTES) {
	let fd;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.alloc(maxBytes);
		const n = readSync(fd, buf, 0, maxBytes, 0);
		let lines = 0;
		for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
		if (n > 0 && buf[n - 1] !== 10) lines++;
		return { lines, bytesRead: n, complete: n < maxBytes };
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

function matchesDenylist(name, patterns) {
	for (const pattern of patterns) {
		if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return pattern;
		if (name === pattern) return pattern;
	}
	return null;
}

/** Tokens the window would have paid for a full read of `size` bytes. */
export function estimateFullReadTokens(size) {
	return Math.ceil(size / 4);
}

export const DENY_NEXT_STEP =
	"Large unbounded read blocked by ContextMind. Use context_orient / context_find / context_get for bounded evidence, " +
	"or re-read with an explicit offset+limit. Set override_reason if the whole file is genuinely required.";

/**
 * Decide one Read.
 *
 * @returns {{decision:"allow"|"deny"|"warn", rule:string, reason:string,
 *            preventedTokens:number, fileTokens:number, message?:string}}
 */
export function evaluateRead({ filePath, offset, limit, cfg, prompt = "", toolInput = {}, taskBundle = null, projectRoot = null }) {
	const cfgRead = cfg.read_guard;
	if (!cfgRead.enabled) {
		return { decision: "allow", rule: "disabled", reason: "read_guard disabled", preventedTokens: 0, fileTokens: 0 };
	}

	const bounded = Number.isFinite(Number(offset)) || Number.isFinite(Number(limit));
	const forbidden = forbiddenAgentScanPath(filePath);
	if (forbidden.blocked && !bounded) {
		return {
			decision: "deny",
			rule: "forbidden_scan_path",
			reason: forbidden.reason,
			preventedTokens: 0,
			fileTokens: 0,
			message: FORBIDDEN_SCAN_HINT,
		};
	}

	// Relative paths must resolve against project root — otherwise stat fails and we
	// fail-open ("unreadable"), which silently lets whole ServiceImpl files through.
	let resolved = String(filePath ?? "");
	if (resolved && projectRoot && !isAbsolute(resolved)) {
		resolved = resolve(projectRoot, resolved);
	}

	const stat = statFile(resolved);
	if (!stat || !stat.isFile) {
		// Unknown or missing: not ours to block. Failing closed on a path we
		// cannot stat would break legitimate creation workflows.
		return { decision: "allow", rule: "unreadable", reason: "cannot stat path", preventedTokens: 0, fileTokens: 0 };
	}

	const fileTokens = estimateFullReadTokens(stat.size);
	const name = basename(resolved);

	// Escape hatches first: an explicit override is a decision, not a bypass,
	// and it is counted so a rule that misfires shows up in telemetry.
	const overrideReason = toolInput.override_reason ?? (process.env.CONTEXTMIND_READ_OVERRIDE === "1" ? "env" : null);
	if (overrideReason) {
		return {
			decision: "allow",
			rule: "override",
			reason: String(overrideReason).slice(0, 200),
			preventedTokens: 0,
			fileTokens,
		};
	}

	// Bounded range is the approved way to read large Java — check before TaskBundle
	// so offset+limit is never blocked as "outside allow_globs".
	if (bounded) {
		return { decision: "allow", rule: "bounded_range", reason: "explicit offset/limit", preventedTokens: 0, fileTokens };
	}

	if (taskBundle && projectRoot) {
		const scope = evaluatePathScope({
			filePath,
			projectRoot,
			bundle: taskBundle,
			enforceAllow: cfg.sdlc?.enforce_allow !== false,
		});
		if (scope.decision === "deny") {
			return {
				decision: "deny",
				rule: scope.rule,
				reason: scope.reason,
				preventedTokens: fileTokens,
				fileTokens,
				message: `ContextMind TaskBundle: ${scope.reason}\n${DENY_NEXT_STEP}`,
			};
		}
	}

	const denied = (rule, reason) => ({
		decision: "deny",
		rule,
		reason,
		preventedTokens: fileTokens,
		fileTokens,
		message: `ContextMind Read Guard: ${reason}\n${DENY_NEXT_STEP}`,
	});

	const listHit = matchesDenylist(name, cfgRead.denylist);
	if (listHit) {
		return denied("generated_or_lockfile", `matches denylist "${listHit}" (generated/lockfile/minified)`);
	}

	if (MAPPER_XML.test(name)) {
		return denied(
			"mapper_xml",
			"*Mapper.xml must never be read whole — target a <select|insert|update|delete id=\"...\"> statement",
		);
	}

	if (LONG_DOC.test(name) && stat.size > 8_192) {
		return denied("long_canonical_doc", `canonical doc "${name}" is ${stat.size} bytes — query it, do not read it whole`);
	}

	if (JAVA.test(name)) {
		const sample = lineSample(resolved);
		const threshold = JAVA_SERVICE.test(name)
			? cfgRead.java_service_unbounded_lines
			: MAPPER_JAVA.test(name)
				? 120
				: cfgRead.max_unbounded_lines;

		// The sample only tells us the file exceeds the threshold when it
		// actually saw that many lines within the cap. A file with fewer lines
		// than the threshold in the whole file is allowed through by the size
		// check above combined with this not firing.
		if (sample && sample.lines > threshold) {
			return denied(
				JAVA_SERVICE.test(name) ? "java_service" : MAPPER_JAVA.test(name) ? "mapper_java" : "java_large",
				`${name} is >${threshold} lines with no range (sample saw ${sample.lines} lines in the first ${sample.bytesRead} bytes)`,
			);
		}
		if (!sample) {
			return denied("unreadable_java", `${name} could not be sampled`);
		}
		// Large but under the line threshold: allow, it is genuinely small enough.
		return { decision: "allow", rule: "java_under_threshold", reason: `${sample.lines} lines`, preventedTokens: 0, fileTokens };
	}

	// A small file has nothing to save; blocking it would only add a round trip.
	// Checked after the typed rules on purpose: a 4KB Java service is still 90
	// lines of nothing the task asked for, and the line rule is what governs it.
	if (stat.size <= 4_096) {
		return { decision: "allow", rule: "small_file", reason: `${stat.size} bytes`, preventedTokens: 0, fileTokens };
	}

	if (stat.size > cfgRead.max_unbounded_bytes) {
		return denied(
			"oversized",
			`${name} is ${stat.size} bytes (cap ${cfgRead.max_unbounded_bytes}) with no range`,
		);
	}

	return { decision: "allow", rule: "under_cap", reason: `${stat.size} bytes`, preventedTokens: 0, fileTokens };
}
