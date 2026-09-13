/**
 * Minimal hook I/O + Runtime RPC. No cm-lib import graph.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Hang doc P0 — keep in sync with contextmind/lib/runtime/constants.mjs */
const HOOK_PROCESS_EXIT_MS = Number(process.env.CONTEXTMIND_HOOK_EXIT_MS) > 0
	? Number(process.env.CONTEXTMIND_HOOK_EXIT_MS)
	: 500;
const SENTINEL = join("lib", "runtime.mjs");
const CANDIDATE_DIRS = ["contextmind", join("cursor", "contextmind"), join(".cursor", "contextmind")];
const MAX_DEPTH = 6;

export function findHome(startDir = dirname(fileURLToPath(import.meta.url))) {
	if (process.env.CONTEXTMIND_HOME) {
		const envPath = process.env.CONTEXTMIND_HOME;
		if (existsSync(join(envPath, SENTINEL))) return envPath;
		/* invalid CONTEXTMIND_HOME — fall through to upward walk */
	}
	let dir = startDir;
	for (let i = 0; i < MAX_DEPTH; i++) {
		for (const rel of CANDIDATE_DIRS) {
			const candidate = join(dir, rel);
			if (existsSync(join(candidate, SENTINEL))) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function readStdin() {
	return new Promise((resolve) => {
		let raw = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => {
			raw += c;
		});
		process.stdin.on("end", () => resolve(raw));
		process.stdin.on("error", () => resolve(raw));
	});
}

export async function readHookInput() {
	const raw = await readStdin();
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

let emitted = false;

export function emit(output) {
	// The guard timer can fire while the RPC is still in flight. Only the FIRST decision
	// reaches stdout — a second line would make the host read the hook as unparseable.
	if (emitted) return;
	emitted = true;
	process.stdout.write(`${JSON.stringify(output ?? {})}\n`);
}

let rpcMod = null;
let rpcLoad = null;

function loadRpc() {
	if (rpcMod) return Promise.resolve(rpcMod);
	if (rpcLoad) return rpcLoad;
	const home = findHome();
	if (!home) return Promise.resolve(null);
	rpcLoad = import(pathToFileURL(join(home, "lib", "runtime", "rpc-client.mjs")).href).then((mod) => {
		rpcMod = mod;
		return mod;
	});
	return rpcLoad;
}

function failOpen(phase) {
	emit(toHostOutput(phase === "pre" ? { permission: "allow" } : {}, phase));
	finish(0);
}

/**
 * Decide, flush, and leave immediately — the host blocks on this process, so waiting for a
 * slow in-flight RPC would tax every tool call. The exit is safe as long as no keep-alive
 * socket is still closing: a bare process.exit() here used to abort with 0xC0000409
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", src\win\async.c) because the
 * RPC round-trip and /health probe left pooled undici sockets. The RPC client now sends
 * Connection: close on every request, so the decision is the only thing left to flush.
 */
function finish(code) {
	try {
		process.stdin.pause();
		process.stdin.destroy();
	} catch {
		/* already torn down */
	}
	// Never process.exit() here. Exiting while async work is unwinding aborts the process on
	// Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", src\win\async.c) —
	// the RPC module's dynamic import and undici sockets are both still settling when the
	// guard timer fires. That abort (0xC0000409) makes a correct decision look like a failed
	// hook. Cancel what is in flight and let Node leave on its own; every request sends
	// Connection: close, so nothing keeps the loop alive.
	process.exitCode = code;
	try {
		rpcMod?.abortInFlight?.();
	} catch {
		/* best effort */
	}
}

/**
 * Dual envelope: Cursor reads flat keys (`permission`, `updated_mcp_tool_output`); Qoder reads
 * Claude Code's `hookSpecificOutput` (`permissionDecision`, `updatedToolOutput`, …). Each host
 * ignores the other's fields — verified live on Qoder 2026-09-12. Emit both so one binary serves
 * either host without CONTEXTMIND_HOST branching at egress.
 */
export function toHostOutput(payload, phase) {
	const body = payload && typeof payload === "object" ? { ...payload } : {};
	const eventName = phase === "post" ? "PostToolUse" : "PreToolUse";
	if (phase === "post") {
		const updated = body.updated_mcp_tool_output ?? body.updated_tool_output;
		if (updated !== undefined) {
			body.hookSpecificOutput = {
				hookEventName: eventName,
				updatedToolOutput: updated,
				updatedMCPToolOutput: updated,
			};
		} else if (body.additional_context) {
			body.hookSpecificOutput = {
				hookEventName: eventName,
				additionalContext: body.additional_context,
			};
		}
		return body;
	}
	if (body.permission !== "deny" && body.permission !== "allow") return body;
	const hookSpecificOutput = {
		hookEventName: eventName,
		permissionDecision: body.permission,
	};
	const reason = body.agent_message ?? body.user_message;
	if (reason) hookSpecificOutput.permissionDecisionReason = reason;
	if (body.updated_input) hookSpecificOutput.updatedInput = body.updated_input;
	if (body.additional_context) hookSpecificOutput.additionalContext = body.additional_context;
	body.hookSpecificOutput = hookSpecificOutput;
	return body;
}

function stampProjectRoot(input) {
	const envRoot =
		process.env.CURSOR_PROJECT_DIR?.trim() ||
		process.env.CONTEXTMIND_PROJECT_ROOT?.trim() ||
		process.env.CLAUDE_PROJECT_DIR?.trim() ||
		"";
	const out = input && typeof input === "object" ? { ...input } : {};
	if (!envRoot) return out;
	if (!out.cwd) out.cwd = envRoot;
	if (!Array.isArray(out.workspace_roots) || out.workspace_roots.length === 0) {
		out.workspace_roots = [envRoot];
	}
	return out;
}

async function tryFastPreAllow(input) {
	const home = findHome();
	if (!home) return false;
	const mod = await import(pathToFileURL(join(home, "lib", "runtime", "fast-allow-pre.mjs")).href);
	return mod.canFastAllowHookInput(stampProjectRoot(input));
}

export async function invokeHook(phase, input) {
	if (phase === "pre" && (await tryFastPreAllow(input))) {
		emit({});
		finish(0);
	}
	const guard = setTimeout(() => failOpen(phase), HOOK_PROCESS_EXIT_MS);
	try {
		const mod = await loadRpc();
		if (!mod) {
			clearTimeout(guard);
			failOpen(phase);
			return;
		}
		const out = await mod.invokeHookRpc(phase, input);
		clearTimeout(guard);
		const { _tokenmind_rpc_ms, _tokenmind_minimal, ...payload } = out ?? {};
		emit(toHostOutput(payload, phase));
		finish(0);
	} catch (err) {
		clearTimeout(guard);
		try {
			console.error(`[tokenmind] hook error: ${err?.message ?? err}`);
		} catch {
			/* stderr only */
		}
		failOpen(phase);
	}
}

export async function loadHomeModule(name) {
	const home = findHome();
	if (!home) return null;
	return import(pathToFileURL(join(home, "lib", name)).href);
}

export async function sessionEnsureRuntime() {
	const mod = await loadRpc();
	if (mod?.ensureRuntimeUp) await mod.ensureRuntimeUp();
}
