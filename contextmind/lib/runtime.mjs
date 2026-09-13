/**
 * Shared plumbing for every ContextMind hook.
 *
 * Kept deliberately small so a hook process pays one import, not a framework.
 * Two invariants live here and nowhere else:
 *
 *  1. stdout carries exactly one JSON object. A stray console.log in a hook is
 *     an unparseable hook result, and Cursor then treats the hook as failed —
 *     which for `failClosed: true` means a blocked tool call. Diagnostics go to
 *     stderr, always.
 *  2. Every hook records its own latency. The gate's compression time is
 *     recorded separately (spec G4: it must not be disguised as hook latency).
 */

import { getConfig } from "./config.mjs";
import { Dedup } from "./dedup.mjs";
import { openHandles } from "./handles.mjs";
import { ResultCache } from "./result-cache.mjs";
import { SessionSeen } from "./session-seen.mjs";
import { CacheEngine } from "./cache-engine/index.mjs";
import { openTelemetry } from "./telemetry.mjs";
import { runOutputGate } from "./output-gate.mjs";

export function readStdin() {
	return new Promise((resolve) => {
		let raw = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			raw += chunk;
		});
		process.stdin.on("end", () => resolve(raw));
		process.stdin.on("error", () => resolve(raw));
	});
}

export async function readHookInput() {
	const raw = await readStdin();
	if (!raw || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function emit(output) {
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** Exit 0 with a no-op result. Used whenever the hook has nothing to say. */
export function noop(extra) {
	emit({ ...extra });
	process.exit(0);
}

/**
 * Session identity. `conversation_id` is the stable one across turns
 * (sessionStart's `session_id` is documented as the same value); a hook can be
 * invoked with either, and falling back to a per-process id would make every
 * call look like a new session and disable dedup entirely.
 */
export function sessionIdOf(input) {
	return (
		input?.conversation_id ??
		input?.session_id ??
		process.env.CURSOR_SESSION_ID ??
		process.env.CONTEXTMIND_SESSION_ID ??
		"unknown"
	);
}

export function projectRootOf(input) {
	return (
		input?.workspace_roots?.[0] ??
		input?.cwd ??
		process.env.CURSOR_PROJECT_DIR ??
		process.env.CONTEXTMIND_PROJECT_ROOT ??
		process.env.CLAUDE_PROJECT_DIR ??
		process.cwd()
	);
}

/**
 * Open the resources a hook needs. Every failure is captured rather than
 * thrown: a governance layer that takes the tool call down with it is worse
 * than one that fails open and reports the fault.
 */
export function openRuntime(projectRoot) {
	const cfg = getConfig(projectRoot);
	const telemetry = openTelemetry(cfg);
	const handles = openHandles(cfg);
	// Dedup shares the handle DB connection: one file, one WAL, one thing to gc.
	const dedup = new Dedup(handles.db, { enabled: cfg.telemetry.enabled && handles.available });
	const cache = new ResultCache(handles.db, cfg.cache ?? {});
	const cacheEngine = new CacheEngine(handles.db, cfg);
	const seen = new SessionSeen(handles.db);
	const sessionId =
		process.env.CURSOR_SESSION_ID ??
		process.env.CONTEXTMIND_SESSION_ID ??
		`mcp-${process.pid}`;
	return {
		cfg,
		telemetry,
		handles,
		dedup,
		cache,
		cacheEngine,
		seen,
		sessionId,
		// Set once per connection by the MCP server from the initialize
		// handshake; "" until then, so pre-handshake writes stay unknown.
		mcpHost: "",
		gate: (args) => {
			const sid = args.sessionId ?? sessionId;
			return runOutputGate({ cfg, handles, dedup, ...args, sessionId: sid });
		},
		/**
		 * Close both databases. Do NOT call this on a hook's hot path.
		 *
		 * Measured, not guessed: on this Windows box an explicit close of two WAL
		 * connections costs ~119ms inside the hook, which is more than the rest
		 * of the hook and the module graph combined. Every write here is a single
		 * auto-committed INSERT, so the data is durable the moment `record`
		 * returns; SQLite replays a hot WAL on the next open. Closing is for
		 * long-lived callers (the CLI), not for a process that is about to exit.
		 */
		close() {
			handles.close();
			telemetry.close();
		},
	};
}
