/**
 * Shell Guard (spec 16) — transparent single-layer wrapping.
 *
 * The model is not asked to "remember to compress". A preToolUse rewrite puts
 * the command through the locked first layer so stdout is governed before it
 * ever reaches the window.
 *
 * The wrap-target table and the safety heuristics are carried over from the
 * engine's own pretooluse hook (context-compress-main/src/hooks/pretooluse.ts)
 * rather than reinvented — it encodes several dead ends (watchers that hang a
 * buffered capture, `npm test` resolving to `vitest --watch`). It is duplicated
 * here instead of imported because that file is a standalone bundled script
 * written for Claude Code's tool names; the seam to watch is theirs moving, not
 * this list drifting on its own.
 *
 * RTK has no code path here at all. See lib/engine.mjs for why.
 */

import { join } from "node:path";
import { ENGINE_ROOT } from "./config.mjs";

export const WRAP_TARGETS = [
	// hang doc P1: git porcelain never wrapped (agent diagnostic path)
	/^(npm|yarn|pnpm|bun)\s+(install|i|add|test|run\s|update|outdated|audit|list|ls|view|info)/,
	/^cargo\s+(build|test|check|run|clippy|tree|search|metadata)/,
	/^(pytest|jest|mocha|vitest|tap|bats)\b/,
	/^(find|grep|rg|fd|ag|ripgrep)\b/,
	/^ls\s+(-R|-la|-al)/,
	/^docker\s+(build|ps|logs|images|inspect|stats)/,
	/^kubectl\s+(get|describe|logs|top|api-resources)/,
	/^terraform\s+(plan|show|state\s+list|state\s+show|validate)/,
	/^helm\s+(list|status|history|get)/,
	/^(make|gradle|bazel|nx|turbo)\b/,
	/^ps\s+(aux|-ef)/,
	/^(df|du)\b/,
	/^(go|rustc)\s+(test|build|vet|run)/,
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

	const cli = engineCliCommand();
	const tokens = [process.execPath, cli, "wrap", "--mode", mode ?? cfg.engine.mode, trimmed];
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
