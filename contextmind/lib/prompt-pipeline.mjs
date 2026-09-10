/**

 * beforeSubmitPrompt pipeline (spec §22). Fail-open, ms-scale.

 */



import { CacheEngine, canonicalizePrompt, buildStablePrefix } from "./cache-engine/index.mjs";

import { promptHashOnly } from "./cache-engine/cache-key.mjs";

import { deltaFromSeen } from "./context/delta-context.mjs";

import { buildCacheKeyMeta, seenResourcesForDelta } from "./cache-context.mjs";

import { countTokens } from "./tokens.mjs";

import { nowSec } from "./cache-engine/ttl-policy.mjs";



function stablePrefixMode(engine) {

	const m = engine.cfg.stablePrefixMode ?? "always";

	return m === "miss_only" ? "miss_only" : "always";

}



function injectStablePrefix(projectRoot, cfg, engine, stages) {

	const maxTokens = engine.cfg.stablePrefixMaxTokens ?? 220;

	const sp = buildStablePrefix(projectRoot, cfg, {

		maxTokens,

		trimRules: engine.cfg.stablePrefixTrimRules === true,

	});

	stages.push({ stage: "stable_prefix", tokens: sp.tokens, hash: sp.hash });

	return `\n${sp.text}\n`;

}



export async function runPromptPipeline({

	projectRoot,

	prompt,

	sessionId,

	cfg,

	db,

	seen,

	meta = {},

}) {

	const body = canonicalizePrompt(prompt);

	if (!body) return { ok: true, stages: [] };



	const engine = new CacheEngine(db, cfg);

	const stages = [];

	let additional_context = "";

	let exactHit = null;

	let semanticHit = null;

	let ctxHit = null;

	let pipelineStage = "miss";



	const keyMeta = buildCacheKeyMeta(projectRoot, cfg, meta);

	const keyInput = { normalized_prompt: body, ...keyMeta };

	const prefixMode = stablePrefixMode(engine);



	if (engine.cfg.promptCache) {
		exactHit = await engine.lookupExactWithRedis(keyInput);
		stages.push({ stage: "exact_lookup", hit: exactHit.hit, from_redis: exactHit.from_redis ?? false });

		if (exactHit.hit && exactHit.output_ref) {

			pipelineStage = "exact_hit";

		}

	}



	if (!exactHit?.hit && engine.cfg.semanticCache) {

		semanticHit = engine.lookupSemantic(keyMeta.project_id, keyMeta.relevant_context_hash, body);

		stages.push({ stage: "semantic_lookup", hit: semanticHit.hit, score: semanticHit.score });

		if (semanticHit.hit && semanticHit.output_ref) {

			pipelineStage = "semantic_hit";

		}

	}



	if (engine.cfg.contextCache) {

		ctxHit = engine.lookupContext(projectRoot, keyMeta.relevant_context_hash, {

			project_id: keyMeta.project_id,

		});

		stages.push({ stage: "context_lookup", hit: ctxHit.hit, stale: ctxHit.stale ?? false });

	}



	const warmL1 = Boolean(ctxHit?.hit && ctxHit.bundle?.resources?.length);

	const cacheHit = Boolean(exactHit?.hit || semanticHit?.hit || warmL1);

	const skipStable = prefixMode === "miss_only" && cacheHit;

	if (pipelineStage === "miss") {
		let missReason = "unknown";
		if (!engine.cfg.promptCache && !engine.cfg.contextCache) missReason = "cache_disabled";
		else if (ctxHit?.stale) missReason = "context_stale";
		else if (!exactHit?.hit && !semanticHit?.hit && !warmL1) {
			if (!engine.cfg.promptCache) missReason = "prompt_cache_off";
			else if (!engine.cfg.semanticCache) missReason = "exact_miss";
			else missReason = "exact_semantic_miss";
			if (!ctxHit?.hit) missReason += "_context_cold";
		} else missReason = "no_output_reuse";
		stages.push({ stage: "miss_reason", reason: missReason });
	}



	if (engine.cfg.stablePrefix !== false && !skipStable) {

		additional_context += injectStablePrefix(projectRoot, cfg, engine, stages);

	} else if (skipStable) {

		stages.push({

			stage: "stable_prefix",

			skipped: true,

			reason: warmL1 && !exactHit?.hit && !semanticHit?.hit ? "miss_only_l1_warm" : "miss_only_cache_hit",

		});

	}



	if (exactHit?.hit && exactHit.output_ref) {

		additional_context += `\n[ContextMind cache L0] reuse handle ${exactHit.output_ref}\n`;

	} else if (semanticHit?.hit && semanticHit.output_ref) {

		additional_context += `\n[ContextMind cache L4 semantic ~${Math.round((semanticHit.score ?? 0) * 100)}%] reuse handle ${semanticHit.output_ref}\n`;

	}



	if (warmL1) {

		const brief = ctxHit.bundle.resources

			.slice(0, 6)

			.map((r) => `${r.kind}:${String(r.key).slice(0, 40)}`)

			.join("; ");

		additional_context += `\n[ContextMind cache L1] task bundle warm (${ctxHit.bundle.resources.length} refs): ${brief}\n`;

	}



	if (engine.cfg.sessionDelta) {

		const resources = seen ? seenResourcesForDelta(seen, sessionId) : [];

		if (resources.length) {

			const digest = { lines: resources.map((r) => `${r.kind}:${r.key}`) };

			const delta = deltaFromSeen(digest, resources);

			stages.push({ stage: "session_delta", reuse_rate: delta.reuse_rate, skipped: delta.skipped.length });

		}

	}



	const inputTokens = countTokens(body);

	const outTokens = countTokens(additional_context);

	const orientSave = engine.cfg.orientSkipTokensEstimate ?? 364;

	let savedTokens = 0;

	if (pipelineStage === "exact_hit" || pipelineStage === "semantic_hit") {

		savedTokens = orientSave + (skipStable ? Math.max(0, 176 - outTokens) : 0);

	} else if (warmL1 && skipStable) {

		savedTokens = Math.max(0, 120 - outTokens);

	}

	stages.push({ stage: "budget", input_tokens: inputTokens, injected_tokens: outTokens, saved_tokens_est: savedTokens });



	try {

		db?.prepare(

			`INSERT INTO prompt_pipeline_events(ts, project_id, session_id, stage, prompt_hash, saved_tokens, detail)

			 VALUES(?,?,?,?,?,?,?)`,

		).run(

			nowSec(),

			keyMeta.project_id ?? "",

			sessionId ?? "",

			pipelineStage,

			promptHashOnly(body).slice(0, 16),

			savedTokens,

			JSON.stringify(stages),

		);

	} catch {

		/* fail-open */

	}



	return {

		ok: true,

		additional_context: additional_context.trim() || undefined,

		stages,

		exact_hit: exactHit?.hit ?? false,

		semantic_hit: semanticHit?.hit ?? false,

		l1_warm: warmL1,

	};

}


