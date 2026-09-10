import { CacheEngine } from "./cache-engine/index.mjs";
import { buildCacheKeyMeta, isCacheablePrompt, pickBestHandleFromSeen } from "./cache-context.mjs";

/** stop hook / completion: persist L0 pointer when prompt is cacheable and session has handle. */
export async function runStopCache({ projectRoot, sessionId, cfg, db, seen, input }) {
	const out = { l0: false, l1: false };
	const prompt = String(input?.prompt ?? "").trim();
	if (!db || !prompt || !isCacheablePrompt(prompt)) return out;
	const handle = pickBestHandleFromSeen(seen, sessionId);
	if (!handle?.handle_id) return out;
	const engine = new CacheEngine(db, cfg ?? {});
	const keyMeta = buildCacheKeyMeta(projectRoot, cfg ?? {}, {});
	out.l0 = engine.storeExact(
		{ normalized_prompt: prompt, ...keyMeta },
		handle.handle_id,
		{ stable: true, reusable: true, verified: true },
	);
	return out;
}
