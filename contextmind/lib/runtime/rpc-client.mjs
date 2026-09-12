/**
 * Thin hook → TokenMind Runtime HTTP. Retry once, then minimal mode (never hang).
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
import { runtimeHost, runtimePort, startDaemon } from "./lifecycle.mjs";

function hostPort() {
	return { host: runtimeHost(), port: runtimePort() };
}

async function postHook(body, timeoutMs) {
	const { host, port } = hostPort();
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(`http://${host}:${port}${HOOK_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: ac.signal,
		});
		clearTimeout(t);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} catch (err) {
		clearTimeout(t);
		throw err;
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
	const body = { phase, input, client: "cursor-thin", v: 1 };
	try {
		return sanitizeRpc(await postHook(body, RPC_TIMEOUT_MS));
	} catch (first) {
		try {
			await startDaemon({ waitMs: 2_000 });
			return sanitizeRpc(await postHook(body, RPC_RETRY_TIMEOUT_MS));
		} catch (second) {
			logMinimal(phase, second);
			const fallback = phase === "pre" ? minimalPre(input) : minimalPost();
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
		const res = await fetch(`http://${host}:${port}${HEALTH_PATH}`, { signal: ac.signal });
		clearTimeout(t);
		const body = await res.json().catch(() => ({}));
		if (res.ok && body.ok !== false) return { ok: true };
	} catch {
		/* down */
	}
	return startDaemon({ waitMs: 3_000 });
}
