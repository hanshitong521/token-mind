/**
 * Peak cache profile — safe-by-default semantic + miss-only stable prefix.
 */

export const PEAK_CACHE_ENGINE = {
	peak: true,
	promptCache: true,
	contextCache: true,
	toolCache: true,
	sessionDelta: true,
	semanticCache: true,
	semanticMode: "hybrid",
	stablePrefix: true,
	stablePrefixMode: "miss_only",
	stablePrefixMaxTokens: 200,
	stablePrefixTrimRules: true,
	compression: true,
	orientSkipTokensEstimate: 364,
	toolCachePreDeny: true,
	kvIntegration: true,
	redisPromptMirror: true,
};

export function applyPeakCacheEngine(cacheEngine = {}) {
	if (!cacheEngine.peak && cacheEngine.peakMode !== true) return cacheEngine;
	return { ...cacheEngine, ...PEAK_CACHE_ENGINE, peak: true };
}
