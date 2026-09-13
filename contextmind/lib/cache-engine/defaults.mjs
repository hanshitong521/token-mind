/**
 * cache_engine defaults — single source of truth.
 *
 * config.mjs (the user-facing default block) and cache-engine/index.mjs (the
 * runtime fallback when a caller passes no cfg) used to carry their own copy
 * of this object. The two had already drifted: `redisPromptMirror` and
 * `semanticMode` existed only in the runtime copy, so a config-driven run and
 * a cfg-less run disagreed on two flags. One frozen object, imported by both,
 * makes that class of drift impossible.
 *
 * Deliberately a leaf module (no imports), so pulling it into config.mjs
 * cannot create a cycle — config.mjs already reaches into
 * cache-engine/peak-profile.mjs.
 */
export const CACHE_ENGINE_DEFAULTS = Object.freeze({
	promptCache: true,
	contextCache: true,
	toolCache: true,
	sessionDelta: true,
	semanticCache: false,
	compression: false,
	stablePrefix: true,
	stablePrefixMode: "always",
	stablePrefixMaxTokens: 220,
	stablePrefixTrimRules: false,
	toolCachePreDeny: false,
	orientSkipTokensEstimate: 364,
	peak: false,
	redisPromptMirror: false,
	semanticMode: "jaccard",
	kvIntegration: false,
	kvUrl: "",
});
