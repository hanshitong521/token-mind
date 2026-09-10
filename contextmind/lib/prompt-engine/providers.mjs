/**
 * Provider Capabilities Registry (spec §18, §58).
 *
 * Provider behavior must not be scattered across if/else. Each provider
 * describes what it can do for the cache/optimizer; unknown stays UNKNOWN
 * (spec §58: "不要猜").
 */

import { TOKENIZER_ID } from "../tokens.mjs";

export const PROVIDERS = Object.freeze({
	openai: "openai",
	anthropic: "anthropic",
	cursor: "cursor",
	codex: "codex",
	qwen: "qwen",
	generic: "generic",
	openai_compatible: "openai-compatible",
});

const REGISTRY = Object.freeze({
	openai: {
		exactPrefixCache: true,
		explicitCacheControl: false,
		reportedCachedTokens: true,
		promptCacheKey: false,
		toolSchemaPartOfPrefix: true,
		canRewriteAtClientBoundary: false,
		hookCapabilities: [],
		tokenizerMode: "approx",
		tokenizerId: TOKENIZER_ID,
		note: "OpenAI automatic prefix cache; dynamic user content should be last.",
	},
	anthropic: {
		exactPrefixCache: true,
		explicitCacheControl: true,
		reportedCachedTokens: true,
		promptCacheKey: false,
		toolSchemaPartOfPrefix: true,
		canRewriteAtClientBoundary: false,
		hookCapabilities: ["cache_control_breakpoints"],
		tokenizerMode: "approx",
		tokenizerId: TOKENIZER_ID,
		note: "Anthropic prompt caching with explicit cache_control; breakpoints ≤4.",
	},
	cursor: {
		exactPrefixCache: null,
		explicitCacheControl: null,
		reportedCachedTokens: null,
		promptCacheKey: null,
		toolSchemaPartOfPrefix: null,
		canRewriteAtClientBoundary: true,
		hookCapabilities: ["beforeSubmitPrompt", "sessionStart", "preCompact", "stop", "fail_open"],
		tokenizerMode: "unknown",
		note: "Hidden system prompt = UNKNOWN (spec §21). Only user-controllable assets analyzed.",
	},
	codex: {
		exactPrefixCache: true,
		explicitCacheControl: false,
		reportedCachedTokens: true,
		promptCacheKey: true,
		toolSchemaPartOfPrefix: true,
		canRewriteAtClientBoundary: false,
		hookCapabilities: [],
		tokenizerMode: "approx",
		tokenizerId: TOKENIZER_ID,
		note: "Codex-style agent loop: new round should keep old prompt as exact prefix (spec §19).",
	},
	qwen: {
		exactPrefixCache: false,
		explicitCacheControl: false,
		reportedCachedTokens: false,
		promptCacheKey: false,
		toolSchemaPartOfPrefix: true,
		canRewriteAtClientBoundary: true,
		hookCapabilities: [],
		tokenizerMode: "unknown",
		note: "Local Qwen via OpenAI-compatible API; tokenizer/template must be verified per model (spec §22).",
	},
	generic: {
		exactPrefixCache: null,
		explicitCacheControl: null,
		reportedCachedTokens: null,
		promptCacheKey: null,
		toolSchemaPartOfPrefix: null,
		canRewriteAtClientBoundary: false,
		hookCapabilities: [],
		tokenizerMode: "unknown",
		note: "Generic/unknown provider; assume UNKNOWN capabilities (spec §58).",
	},
	"openai-compatible": {
		exactPrefixCache: null,
		explicitCacheControl: null,
		reportedCachedTokens: null,
		promptCacheKey: null,
		toolSchemaPartOfPrefix: null,
		canRewriteAtClientBoundary: true,
		hookCapabilities: [],
		tokenizerMode: "unknown",
		note: "OpenAI-compatible self-hosted; capabilities must be verified per deployment.",
	},
});

/**
 * Get provider capabilities, always returning a full object (unknown fields
 * default to null). Falls back to generic.
 */
export function getProviderCapabilities(provider, { set = {} } = {}) {
	const key = String(provider ?? "generic").toLowerCase();
	const base = REGISTRY[key] ?? REGISTRY.generic;
	return { provider: key, ...base, ...set };
}

/** List registered providers with a short label. */
export function listProviders() {
	return Object.entries(REGISTRY).map(([id, cap]) => ({ id, ...cap }));
}

/** Whether a provider has exact prefix caching (true = benefit analysis). */
export function supportsPrefixCache(provider) {
	return getProviderCapabilities(provider).exactPrefixCache === true;
}