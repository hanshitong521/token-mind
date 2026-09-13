/**
 * Shell Guard — single-layer stdout wrap via context-compress (cc_balanced only).
 *
 * AI-NOTE:
 * - WHY: large install/build/docker dumps burn tokens; agent diagnostics must NOT wrap.
 * - DO NOT: re-add `git` / `rg` / `npm test` / bare `make` to WRAP_TARGETS (hang doc P1).
 *   Broken engine + wrap rewrite looks like "another layer failed".
 * - DO NOT: enable RTK or a second compression layer (locked first_layer).
 * - DO NOT: wrap when zod/CLI missing — isEngineCliReady() must stay fail-open skip.
 * - AFTER CHANGE TEST:
 *   1) `node --test` in token-mind/contextmind → shell guard suite (npm run build wraps;
 *      npm test / rg / git status do not)
 *   2) engine wrap: `node <ENGINE>/dist/cli/index.js wrap --mode balanced "echo ok"`
 *   3) doctor: no FAIL; hang doc WRAP section still accurate
 * Evidence: docs/agent-stack/AGENT-SESSION-HANG-2026-09-11.md
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./config.mjs";

export const WRAP_TARGETS = [
	// hang doc P1: git never wrapped. Agent diagnostics (rg/ls/ps/df, npm test) also skip —
	// wrapping them masks engine failures as "another layer broke" and adds little token win.
	/^(npm|yarn|pnpm|bun)\s+(install|i|add|run\s|update)\b/,
	/^cargo\s+(build|test|check|run|clippy|tree|search|metadata)\b/,
	/^(pytest|jest|mocha|vitest|tap|bats)\b/,
	/^docker\s+(build|ps|logs|images|inspect|stats)\b/,
	/^kubectl\s+(get|describe|logs|top|api-resources)\b/,
	/^terraform\s+(plan|show|state\s+list|state\s+show|validate)\b/,
	/^helm\s+(list|status|history|get)\b/,
	/^(make|gradle|bazel|nx|turbo)\s+(build|test|check|lint|compile)\b/,
	/^(go|rustc)\s+(test|build|vet|run)\b/,
	/^(mvn|mvnw|gradlew)\b/,
];

const ALREADY_WRAPPED = /context-compress[^\n]*\bwrap\b/;
const NEVER_WRAP = /^(top|htop|watch)\b/;

/** Quote one token for a POSIX-ish shell; paths with spaces must stay one word. */
export function shellQuote(s) {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function engineCliCommand() {
	return join(ENGINE_ROOT, "dist", "cli", "index.js");
}

/** Prefer stable Node for wrap child (avoid PATH nodejs_wheel drift). */
export function wrapNodeBin() {
	const envNode = process.env.CONTEXTMIND_NODE;
	if (envNode && existsSync(envNode)) return envNode;
	if (existsSync("D:\\nodejs\\node.exe")) return "D:\\nodejs\\node.exe";
	return process.execPath;
}

/** Fail-open: missing CLI or zod → skip wrap (hang doc: broken engine must not rewrite). */
export function isEngineCliReady() {
	const cli = engineCliCommand();
	if (!cli || !existsSync(cli)) return false;
	// dist/config.js imports zod; incomplete node_modules → wrap crashes after rewrite
	return existsSync(join(ENGINE_ROOT, "node_modules", "zod", "package.json"));
}

/**
 * Decide whether to rewrite a command, and to what.
 *
 * @returns {{action:"wrap"|"skip", command?:string, reason:string}}
 */
export function evaluateShell(command, { cfg, mode } = {}) {
	if (!cfg.shell.enabled) return { action: "skip", reason: "shell guard disabled" };
	if (cfg.shell.first_layer !== "cc_balanced") {
		return { action: "skip", reason: `first_layer=${cfg.shell.first_layer} (not cc_balanced)` };
	}

	const trimmed = (command ?? "").trim();
	if (trimmed.length === 0) return { action: "skip", reason: "empty command" };
	if (cfg.shell?.wrap_git === false && /^\s*git\b/i.test(trimmed)) {
		return { action: "skip", reason: "git porcelain (wrap_git=false)" };
	}
	if (ALREADY_WRAPPED.test(trimmed)) return { action: "skip", reason: "already wrapped (no double compression)" };
	if (NEVER_WRAP.test(trimmed)) return { action: "skip", reason: "never-terminating command" };

	// The user asked for raw output.
	if (/(?:^|\s)(?:>|>>|\d?>&)\s*\S/.test(trimmed)) return { action: "skip", reason: "output redirected" };
	// Piping means something downstream is already shaping the stream, and
	// wrapping the head would change which process sees which bytes.
	// `||` is not a pipe; `;` / `&&` still produce one concatenated stdout — wrap the whole string.
	if (/(^|[^|])\|([^|]|$)/.test(trimmed)) return { action: "skip", reason: "piped" };
	if (/\s--?watch\b/.test(trimmed)) return { action: "skip", reason: "watch mode" };
	if (/^(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|watch|serve)\b/.test(trimmed)) {
		return { action: "skip", reason: "dev server" };
	}
	if (/^(make|gradle|bazel|nx|turbo)\s+\S*\b(dev|watch|serve|start)\b/.test(trimmed)) {
		return { action: "skip", reason: "watcher target" };
	}
	if (/^vitest\b/.test(trimmed) && !/^vitest\s+(run|related|bench)\b/.test(trimmed)) {
		return { action: "skip", reason: "vitest defaults to watch" };
	}

	const statements = trimmed.split(/\s*(?:&&|;)\s*/).map((s) => s.trim()).filter(Boolean);
	if (!statements.some((s) => WRAP_TARGETS.some((re) => re.test(s)))) {
		return { action: "skip", reason: "not a wrap target" };
	}

	if (!isEngineCliReady()) {
		return { action: "skip", reason: "engine unavailable (missing cli or zod) — fail-open no wrap" };
	}

	const cli = engineCliCommand();
	const tokens = [wrapNodeBin(), cli, "wrap", "--mode", mode ?? cfg.engine.mode, trimmed];
	return {
		action: "wrap",
		command: tokens.map(shellQuote).join(" "),
		reason: "governed by cc_balanced (shell first layer)",
	};
}

/**
 * The disclosure the model sees alongside a rewritten command. Without it a
 * filtered result is indistinguishable from what the command actually printed,
 * which is how provenance gets lost.
 */
export function wrapDisclosure(reason) {
	return (
		`[contextmind] this shell command was wrapped so stdout flows through the ` +
		`${reason}; the output you receive is governed, not raw. ` +
		`Set CONTEXTMIND_SHELL=0 to disable.`
	);
}
