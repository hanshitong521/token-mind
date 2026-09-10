import { ensureCacheSchema, CACHE_SCHEMA_VERSION } from "../db/schema.mjs";
import { buildExactCacheKey, buildContextCacheKey, buildToolCacheKey, promptHashOnly } from "./cache-key.mjs";
import { canonicalizePrompt, normalizeToolArgs } from "./canonicalizer.mjs";
import { buildDependencyFingerprint } from "./dependency-fingerprint.mjs";
import { evaluateAdmission, Admission } from "./admission.mjs";
import { ExactCache } from "./exact-cache.mjs";
import { ContextCache } from "./context-cache.mjs";
import { ToolCache } from "./tool-cache.mjs";
import { invalidateByDependency, purgeExpired, isFingerprintStale } from "./invalidation.mjs";
import { recordCacheEvent, cacheStats } from "./telemetry.mjs";
import { SemanticCache, similarity } from "./semantic-cache.mjs";
import { buildStablePrefix } from "./stable-prefix.mjs";
import { probeKvBridge, registerKvPrefix } from "./kv-bridge.mjs";
import { redisGet, redisSet } from "./redis-io.mjs";
import { summarizeCacheLedger } from "./cache-ledger.mjs";
import { normalizeAdapterQuery } from "../result-cache.mjs";
import { createHash } from "node:crypto";

function toolArgsForCache(tool_name, args) {
	const a = args && typeof args === "object" ? { ...args } : args;
	if (!a || typeof a !== "object") return a;
	if (tool_name === "context_orient" && a.query != null) a.query = normalizeAdapterQuery(a.query);
	if (tool_name === "context_find" && a.symbol != null) a.symbol = normalizeAdapterQuery(a.symbol);
	return a;
}

const DEFAULT_FLAGS = {
	promptCache: true,
	contextCache: true,
	toolCache: true,
	sessionDelta: true,
	semanticCache: false,
	compression: false,
	brainSync: false,
	brainSyncOnStop: false,
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
};

export class CacheEngine {
	constructor(db, cfg = {}) {
		this.db = db;
		this.cfg = { ...DEFAULT_FLAGS, ...(cfg.cache_engine ?? {}) };
		const ttl = cfg.cache?.ttl_sec ?? 600;
		this.redisUrl =
			cfg.cache?.redis_url || process.env.CONTEXTMIND_REDIS_URL || process.env.REDIS_URL || "";
		this.fullCfg = cfg;
		this.available = ensureCacheSchema(db);
		this.exact = new ExactCache(db, { ttl_sec: ttl });
		this.context = new ContextCache(db, { ttl_sec: ttl });
		this.tool = new ToolCache(db, { ttl_sec: ttl });
		this.semantic = new SemanticCache(db, {
			ttl_sec: ttl,
			semantic_mode: this.cfg.semanticMode ?? "hybrid",
			cfg,
		});
	}

	dependencyFp(projectRoot, extra) {
		return buildDependencyFingerprint(projectRoot, extra);
	}

	lookupExact(input) {
		if (!this.available || !this.cfg.promptCache) return { hit: false };
		const key = buildExactCacheKey(input);
		const row = this.exact.get(key);
		if (!row) return { hit: false, cache_key: key };
		recordCacheEvent(this.db, {
			project_id: input.project_id,
			layer: "L0",
			event: "hit",
			cache_key: key,
			saved_tokens: this.cfg.orientSkipTokensEstimate ?? 364,
		});
		return { hit: true, cache_key: key, output_ref: row.output_ref };
	}

	storeExact(input, output_ref, meta = {}) {
		if (!this.available || !this.cfg.promptCache) return false;
		const admission = evaluateAdmission({ ...meta, kind: "exact_answer" });
		if (admission === Admission.REJECT) return false;
		const cache_key = buildExactCacheKey(input);
		const ok = this.exact.put({
			cache_key,
			project_id: input.project_id,
			prompt_hash: promptHashOnly(input.normalized_prompt),
			context_hash: input.relevant_context_hash,
			model_family: input.model_family,
			output_ref,
			admission,
		});
		if (ok) {
			recordCacheEvent(this.db, {
				project_id: input.project_id,
				layer: "L0",
				event: "store",
				cache_key,
			});
			if (this.redisUrl && this.cfg.redisPromptMirror) {
				const ttl = this.fullCfg.cache?.ttl_sec ?? 600;
				redisSet(this.redisUrl, `cm:l0:${cache_key}`, output_ref, ttl).catch(() => {});
			}
		}
		return ok;
	}

	async lookupExactWithRedis(input) {
		const sync = this.lookupExact(input);
		if (sync.hit || !this.redisUrl || !this.cfg.redisPromptMirror) return sync;
		const cache_key = buildExactCacheKey(input);
		const ref = await redisGet(this.redisUrl, `cm:l0:${cache_key}`);
		if (!ref) return sync;
		this.exact.put({
			cache_key,
			project_id: input.project_id,
			prompt_hash: promptHashOnly(input.normalized_prompt),
			context_hash: input.relevant_context_hash,
			model_family: input.model_family,
			output_ref: ref,
			admission: Admission.EXACT_ONLY,
		});
		recordCacheEvent(this.db, {
			project_id: input.project_id,
			layer: "L0",
			event: "hit",
			cache_key,
			saved_tokens: this.cfg.orientSkipTokensEstimate ?? 364,
			detail: "redis_mirror",
		});
		return { hit: true, cache_key, output_ref: ref, from_redis: true };
	}

	lookupContext(projectRoot, taskFingerprint, extra = {}) {
		if (!this.available || !this.cfg.contextCache) return { hit: false };
		const fp = this.dependencyFp(projectRoot, extra);
		const cache_key = buildContextCacheKey({
			project_id: extra.project_id ?? "",
			task_fingerprint: taskFingerprint,
			dependency_fp: fp,
		});
		const row = this.context.get(cache_key, fp);
		if (!row) return { hit: false, cache_key };
		if (row.stale) {
			recordCacheEvent(this.db, {
				project_id: extra.project_id,
				layer: "L1",
				event: "stale_prevented",
				cache_key,
			});
			return { hit: false, stale: true, cache_key };
		}
		recordCacheEvent(this.db, { project_id: extra.project_id, layer: "L1", event: "hit", cache_key });
		return { hit: true, cache_key, bundle: row.bundle };
	}

	storeContext({ cache_key, project_id, bundle, repo_commit, dependency_fp, admission }) {
		if (!this.available || !this.cfg.contextCache) return false;
		const decision = admission ?? evaluateAdmission({ kind: "context_bundle", stable: true, reusable: true, verified: true });
		if (decision === Admission.REJECT) return false;
		const ok = this.context.put({
			cache_key,
			project_id,
			bundle,
			repo_commit,
			dependency_fp,
			admission: decision,
		});
		if (ok) {
			recordCacheEvent(this.db, { project_id, layer: "L1", event: "store", cache_key });
		}
		return ok;
	}

	storeTool(projectRoot, { project_id, tool_name, args }, output_ref, meta = {}) {
		if (!this.available || !this.cfg.toolCache || !output_ref) return false;
		const normArgs = toolArgsForCache(tool_name, args);
		const args_hash = createHash("sha256").update(normalizeToolArgs(normArgs), "utf8").digest("hex").slice(0, 32);
		const fp = this.dependencyFp(projectRoot, meta);
		const cache_key = buildToolCacheKey({ project_id, tool_name, args_hash, dependency_fp: fp });
		const admission = evaluateAdmission({ ...meta, kind: "tool_result", stable: true, verified: meta.verified !== false });
		if (admission === Admission.REJECT) return false;
		const ok = this.tool.put({
			cache_key,
			project_id,
			tool_name,
			args_hash,
			output_ref,
			dependency_fp: fp,
			admission,
		});
		if (ok) {
			recordCacheEvent(this.db, { project_id, layer: "L2", event: "store", cache_key });
		}
		return ok;
	}

	lookupTool(projectRoot, { project_id, tool_name, args }, extra = {}) {
		if (!this.available || !this.cfg.toolCache) return { hit: false };
		const normArgs = toolArgsForCache(tool_name, args);
		const args_hash = createHash("sha256").update(normalizeToolArgs(normArgs), "utf8").digest("hex").slice(0, 32);
		const fp = this.dependencyFp(projectRoot, extra);
		const cache_key = buildToolCacheKey({ project_id, tool_name, args_hash, dependency_fp: fp });
		const row = this.tool.get(cache_key, fp);
		if (!row) return { hit: false, cache_key, args_hash };
		if (row.stale) {
			recordCacheEvent(this.db, {
				project_id,
				layer: "L2",
				event: "stale_prevented",
				cache_key,
			});
			return { hit: false, stale: true, cache_key };
		}
		recordCacheEvent(this.db, { project_id, layer: "L2", event: "hit", cache_key });
		return { hit: true, cache_key, output_ref: row.output_ref };
	}

	lookupSemantic(project_id, context_hash, prompt) {
		if (!this.available || !this.cfg.semanticCache) return { hit: false };
		const row = this.semantic.lookup({ project_id, context_hash, prompt });
		if (row.hit) {
			recordCacheEvent(this.db, {
				project_id,
				layer: "L4",
				event: "hit",
				cache_key: row.cache_key,
				saved_tokens: this.cfg.orientSkipTokensEstimate ?? 364,
			});
		} else if (row.reason === "prompt_not_cacheable") {
			recordCacheEvent(this.db, {
				project_id,
				layer: "L4",
				event: "unsafe_prevented",
				detail: row.reason,
			});
		}
		return row;
	}

	async storeSemantic(project_id, context_hash, prompt, output_ref, meta = {}) {
		if (!this.available || !this.cfg.semanticCache) return false;
		const admission = evaluateAdmission({ ...meta, kind: "semantic", stable: true, verified: true });
		const ok = await this.semantic.put({
			project_id,
			context_hash,
			prompt,
			output_ref,
			admission,
		});
		if (ok) {
			recordCacheEvent(this.db, { project_id, layer: "L4", event: "store" });
		}
		return ok;
	}

	async registerKvPrefix(meta = {}) {
		if (!this.cfg.kvIntegration) return { skipped: true };
		return registerKvPrefix(
			{ cache_engine: this.cfg, _db: this.db, brain: { project_id: meta.project_id } },
			meta,
		);
	}

	async probeKvBridge(projectRoot, meta = {}) {
		if (!this.cfg.kvIntegration) return { skipped: true };
		return probeKvBridge(
			{ cache_engine: this.cfg, _db: this.db, brain: { project_id: meta.project_id } },
			meta,
		);
	}

	ledgerSummary() {
		return summarizeCacheLedger(this.db);
	}

	invalidateProject(projectRoot, extra) {
		const fp = this.dependencyFp(projectRoot, extra);
		return invalidateByDependency(this.db, fp);
	}

	gc() {
		return purgeExpired(this.db);
	}

	stats() {
		return cacheStats(this.db);
	}

	doctorRows() {
		const st = this.stats();
		return [
			{ label: "cache schema", status: this.available ? "PASS" : "FAIL", detail: `v${CACHE_SCHEMA_VERSION}` },
			{
				label: "prompt cache",
				status: this.cfg.promptCache ? "PASS" : "WARN",
				detail: this.cfg.promptCache ? "enabled" : "disabled",
			},
			{
				label: "context cache",
				status: this.cfg.contextCache ? "PASS" : "WARN",
				detail: this.cfg.contextCache ? "enabled" : "disabled",
			},
			{
				label: "tool cache",
				status: this.cfg.toolCache ? "PASS" : "WARN",
				detail: this.cfg.toolCache ? "enabled" : "disabled",
			},
			{
				label: "semantic cache",
				status: this.cfg.semanticCache ? "WARN" : "PASS",
				detail: this.cfg.semanticCache ? "enabled (review safety)" : "disabled (default)",
			},
			{
				label: "stable prefix",
				status: this.cfg.stablePrefix ? "PASS" : "WARN",
				detail: this.cfg.stablePrefix
					? `mode=${this.cfg.stablePrefixMode ?? "always"} maxTok=${this.cfg.stablePrefixMaxTokens ?? 220}`
					: "disabled",
			},
			{
				label: "tool cache pre-deny",
				status: this.cfg.toolCachePreDeny ? "PASS" : "WARN",
				detail: this.cfg.toolCachePreDeny ? "L2 blocks identical context_* MCP" : "off (enable via peak)",
			},
			{
				label: "brain stop sync",
				status: this.cfg.brainSyncOnStop ? "WARN" : "PASS",
				detail: this.cfg.brainSyncOnStop ? "enabled (queue on stop)" : "disabled (default)",
			},
			{
				label: "redis L0 mirror",
				status: this.cfg.redisPromptMirror && this.redisUrl ? "PASS" : this.cfg.redisPromptMirror ? "WARN" : "PASS",
				detail: this.cfg.redisPromptMirror
					? this.redisUrl
						? `enabled ${this.redisUrl.replace(/:[^:@]+@/, ":***@")}`
						: "enabled but REDIS_URL unset"
					: "disabled",
			},
			{
				label: "prompt compression",
				status: this.cfg.compression ? "WARN" : "PASS",
				detail: this.cfg.compression ? "stable prefix via context-compress" : "off",
			},
			{
				label: "KV bridge",
				status: this.cfg.kvIntegration ? "WARN" : "PASS",
				detail: this.cfg.kvIntegration
					? `register+probe (${this.cfg.kvUrl || process.env.CONTEXTMIND_KV_BRIDGE_URL || "env URL"})`
					: "disabled",
			},
			{
				label: "semantic mode",
				status: "PASS",
				detail: this.cfg.semanticCache
					? String(this.cfg.semanticMode ?? "jaccard")
					: "semantic off",
			},
			{
				label: "cache entries",
				status: "PASS",
				detail: st
					? `prompt=${st.prompt_entries} context=${st.context_entries} tool=${st.tool_entries} semantic=${st.semantic_entries ?? 0} hot=${st.hot_prompt_entries}`
					: "n/a",
			},
		];
	}
}

export { canonicalizePrompt, buildExactCacheKey, evaluateAdmission, isFingerprintStale, buildStablePrefix, similarity, summarizeCacheLedger };
export { writeLedgerSnapshot, buildLedgerSnapshot } from "./write-ledger-snapshot.mjs";
