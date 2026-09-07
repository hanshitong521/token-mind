/**
 * Optional KV / prefix bridge (LMCache, vLLM) — register stable prefix + health probe.
 */

import { recordCacheEvent } from "./telemetry.mjs";

function bridgeUrl(cfg) {
	return (
		cfg?.cache_engine?.kvUrl ||
		process.env.CONTEXTMIND_KV_BRIDGE_URL ||
		process.env.LMCACHE_SERVER_URL ||
		""
	);
}

export async function probeKvBridge(cfg, { project_id, stable_prefix_hash, saved_tokens_estimate = 0 } = {}) {
	const url = bridgeUrl(cfg);
	if (!url || cfg?.cache_engine?.kvIntegration === false) {
		return { ok: false, skipped: true, reason: "disabled" };
	}
	const db = cfg?._db;
	const started = Date.now();
	try {
		const u = new URL(url.includes("://") ? url : `http://${url}`);
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 120);
		const res = await fetch(`${u.origin}/health`, { signal: controller.signal }).catch(() => null);
		clearTimeout(t);
		const ms = Date.now() - started;
		const ok = res?.ok ?? false;
		if (db) {
			recordCacheEvent(db, {
				project_id,
				layer: "L5",
				event: ok ? "kv_probe_ok" : "kv_probe_miss",
				saved_tokens: saved_tokens_estimate,
				detail: `ms=${ms} url=${u.origin}`,
			});
		}
		return { ok, ms, url: u.origin };
	} catch {
		if (db) {
			recordCacheEvent(db, {
				project_id,
				layer: "L5",
				event: "kv_probe_fail",
				detail: "timeout or network",
			});
		}
		return { ok: false, skipped: false, reason: "probe_failed" };
	}
}

/** Register stable prefix block for provider/LMCache-style KV reuse. */
export async function registerKvPrefix(cfg, { project_id, stable_prefix_hash, prefix_text, tokens = 0 } = {}) {
	const url = bridgeUrl(cfg);
	if (!url || cfg?.cache_engine?.kvIntegration === false) {
		return { ok: false, skipped: true, reason: "disabled" };
	}
	const db = cfg?._db;
	const base = url.includes("://") ? url : `http://${url}`;
	const registerPath = process.env.CONTEXTMIND_KV_REGISTER_PATH || "/v1/cache/prefix";
	const endpoint = `${base.replace(/\/$/, "")}${registerPath}`;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 200);
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				project_id,
				stable_prefix_hash,
				tokens,
				prefix_sample: String(prefix_text ?? "").slice(0, 4096),
			}),
			signal: controller.signal,
		});
		clearTimeout(t);
		const ok = res.ok;
		if (db) {
			recordCacheEvent(db, {
				project_id,
				layer: "L5",
				event: ok ? "kv_register_ok" : "kv_register_miss",
				saved_tokens: tokens,
				detail: `hash=${stable_prefix_hash}`,
			});
		}
		return { ok, status: res.status, endpoint };
	} catch (e) {
		if (db) {
			recordCacheEvent(db, {
				project_id,
				layer: "L5",
				event: "kv_register_fail",
				detail: e instanceof Error ? e.message : "network",
			});
		}
		return { ok: false, reason: "register_failed" };
	}
}
