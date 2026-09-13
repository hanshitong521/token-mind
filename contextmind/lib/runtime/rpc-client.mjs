/**
 * Thin hook → TokenMind Runtime HTTP. Retry once, then minimal mode (never hang).
 *
 * AI-NOTE:
 * - Always stamp cwd/workspace_roots from CURSOR_PROJECT_DIR / CONTEXTMIND_PROJECT_ROOT
 *   before POST (same idea as cmhook EnrichInputJson). Daemon process.cwd() is often
 *   shejiuPro; omitting root makes TaskBundle allow_globs deny temp/test paths.
 * - AFTER CHANGE: hooks.test.mjs read guard (Tiny.java allow, Mapper.xml statement deny);
 *   live agent Read of temp files must not say "path outside allow_globs" unless truly out of task.
 * - invokeHookRpc: canFastAllowHookInput → {} without HTTP (S3 lite path).
 */
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	HEALTH_PATH,
	HOOK_PATH,
	MINIMAL_CAP_BYTES,
	RPC_RETRY_TIMEOUT_MS,
	RPC_TIMEOUT_MS,
} from "./constants.mjs";
import { resolveRuntimePort, runtimeHost, startDaemon } from "./lifecycle.mjs";
import { canFastAllowHookInput } from "./fast-allow-pre.mjs";

function hostPort() {
	return { host: runtimeHost(), port: resolveRuntimePort() };
}

/** Mirror cmhook EnrichInputJson — daemon must not inherit wrong project root. */
export function enrichHookProjectRoot(input) {
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

/** Live request controllers, so the hook can cancel them before it exits. */
const inFlight = new Set();

/**
 * Cancel every request still in flight. The hook's guard timer can fire mid-request; exiting
 * with a socket mid-close aborts the process on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), which turns a good decision
 * into a failed hook. Aborting first lets undici tear the socket down.
 */
export function abortInFlight() {
	for (const ac of inFlight) {
		try {
			ac.abort();
		} catch {
			/* already gone */
		}
	}
	inFlight.clear();
}

async function postHook(body, timeoutMs) {
	const { host, port } = hostPort();
	const ac = new AbortController();
	inFlight.add(ac);
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(`http://${host}:${port}${HOOK_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", connection: "close" },
			body: JSON.stringify(body),
			signal: ac.signal,
		});
		clearTimeout(t);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} catch (err) {
		clearTimeout(t);
		throw err;
	} finally {
		inFlight.delete(ac);
	}
}

function minimalPre(input) {
	const raw = JSON.stringify(input ?? {});
	if (raw.length > MINIMAL_CAP_BYTES) {
		return {
			permission: "allow",
			agent_message: "[tokenmind] minimal mode: oversized pre payload; allow without governance",
		};
	}
	return { permission: "allow", _tokenmind_minimal: true };
}

function minimalPost() {
	return { _tokenmind_minimal: true };
}

function logMinimal(phase, err) {
	try {
		console.error(`[tokenmind] minimal mode (${phase}): ${err?.message ?? err}`);
	} catch {
		/* stderr only */
	}
}

/**
 * @param {"pre"|"post"} phase
 * @param {object} input Cursor hook stdin JSON
 */
export async function invokeHookRpc(phase, input) {
	const enriched = enrichHookProjectRoot(input);
	if (phase === "pre" && canFastAllowHookInput(enriched)) {
		return {};
	}
	const body = { phase, input: enriched, client: "cursor-thin", v: 1 };
	try {
		return sanitizeRpc(await postHook(body, RPC_TIMEOUT_MS));
	} catch (first) {
		try {
			await startDaemon({ waitMs: 2_000 });
			return sanitizeRpc(await postHook(body, RPC_RETRY_TIMEOUT_MS));
		} catch (second) {
			logMinimal(phase, second);
			const fallback = phase === "pre" ? minimalPre(enriched) : minimalPost();
			return sanitizeRpc(fallback);
		}
	}
}

function sanitizeRpc(out) {
	if (!out || typeof out !== "object") return out;
	const { _tokenmind_rpc_ms, _tokenmind_minimal, ...payload } = out;
	return payload;
}

export async function ensureRuntimeUp() {
	const { host, port } = hostPort();
	try {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 300);
		const res = await fetch(`http://${host}:${port}${HEALTH_PATH}`, {
			signal: ac.signal,
			headers: { connection: "close" },
		});
		clearTimeout(t);
		const body = await res.json().catch(() => ({}));
		if (res.ok && body.ok !== false) return { ok: true };
	} catch {
		/* down */
	}
	return startDaemon({ waitMs: 3_000 });
}
