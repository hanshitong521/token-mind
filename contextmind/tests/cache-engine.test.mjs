import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyPeakCacheEngine } from "../lib/cache-engine/peak-profile.mjs";

import { canonicalizePrompt } from "../lib/cache-engine/canonicalizer.mjs";
import { buildExactCacheKey, promptHashOnly } from "../lib/cache-engine/cache-key.mjs";
import { evaluateAdmission, Admission } from "../lib/cache-engine/admission.mjs";
import { CacheEngine, similarity, buildStablePrefix } from "../lib/cache-engine/index.mjs";
import { buildCacheKeyMeta, isCacheablePrompt } from "../lib/cache-context.mjs";
import { runStopCache } from "../lib/cache-stop.mjs";
import { deltaFromSeen } from "../lib/context/delta-context.mjs";
import { SessionSeen } from "../lib/session-seen.mjs";
import { runPromptPipeline } from "../lib/prompt-pipeline.mjs";

let dir;

describe("cache-engine", () => {
	it("canonicalizePrompt collapses whitespace", () => {
		assert.equal(canonicalizePrompt("  hello   world  \n"), "hello world");
	});

	it("exact cache key changes when project_id changes", () => {
		const a = buildExactCacheKey({ normalized_prompt: "q", project_id: "p1" });
		const b = buildExactCacheKey({ normalized_prompt: "q", project_id: "p2" });
		assert.notEqual(a, b);
	});

	it("admission rejects errors and sensitive samples", () => {
		assert.equal(evaluateAdmission({ has_error: true }), Admission.REJECT);
		assert.equal(evaluateAdmission({ text_sample: "api_key=secret", reusable: true }), Admission.REJECT);
		assert.equal(
			evaluateAdmission({ kind: "exact_answer", stable: true, reusable: true }),
			Admission.EXACT_ONLY,
		);
	});

	it("exact cache roundtrip", () => {
		dir = mkdtempSync(join(tmpdir(), "cm-cache-"));
		const db = new DatabaseSync(join(dir, "handles.db"));
		const cfg = { cache: { ttl_sec: 60 }, cache_engine: { promptCache: true } };
		const engine = new CacheEngine(db, cfg);
		assert.ok(engine.available);

		const input = {
			normalized_prompt: "where is TRedPacketTaskServiceImpl",
			project_id: "shejiuPro",
			task_mode: "",
			relevant_context_hash: "",
			system_prompt_version: "1",
			tools_schema_hash: "t1",
			model_family: "test",
		};
		const miss = engine.lookupExact(input);
		assert.equal(miss.hit, false);

		engine.storeExact(input, "h_abc123", { stable: true, reusable: true });
		const hit = engine.lookupExact(input);
		assert.equal(hit.hit, true);
		assert.equal(hit.output_ref, "h_abc123");
		db.close();
	});

	it("deltaFromSeen skips already sent resources", () => {
		const digest = { lines: ["path:Foo.java", "orient:TRedPacketTaskServiceImpl"] };
		const resources = [
			{ kind: "path", key: "Foo.java" },
			{ kind: "orient", key: "Bar.java" },
		];
		const d = deltaFromSeen(digest, resources);
		assert.equal(d.skipped.length, 1);
		assert.equal(d.fresh.length, 1);
	});

	it("semantic similarity and L4 roundtrip when enabled", async () => {
		dir = mkdtempSync(join(tmpdir(), "cm-sem-"));
		const db = new DatabaseSync(join(dir, "handles.db"));
		const cfg = { cache: { ttl_sec: 60 }, cache_engine: { semanticCache: true, semanticMode: "hybrid" } };
		const engine = new CacheEngine(db, cfg);
		const p1 = "请定位 TRedPacketTaskServiceImpl 调用链";
		const p2 = "请定位  TRedPacketTaskServiceImpl  调用链";
		assert.ok(similarity(p1, p2) >= 0.82);
		await engine.storeSemantic("shejiuPro", "ctx1", p1, "h_sem_ref", { stable: true, verified: true });
		const hit = engine.lookupSemantic("shejiuPro", "ctx1", p2);
		assert.equal(hit.hit, true);
		assert.equal(hit.output_ref, "h_sem_ref");
		db.close();
	});

	it("stable prefix is deterministic", () => {
		const cfg = { brain: { project_id: "shejiuPro" }, sdlc: { enabled: false } };
		const a = buildStablePrefix(process.cwd(), cfg, { maxTokens: 200 });
		const b = buildStablePrefix(process.cwd(), cfg, { maxTokens: 200 });
		assert.equal(a.hash, b.hash);
		assert.ok(a.text.includes("[Stable]"));
	});

	it("stop cache writes L0 for cacheable prompt with seen handle", async () => {
		dir = mkdtempSync(join(tmpdir(), "cm-stop-"));
		const db = new DatabaseSync(join(dir, "handles.db"));
		const cfg = {
			cache: { ttl_sec: 60 },
			cache_engine: { promptCache: true, contextCache: true },
			brain: { project_id: "shejiuPro" },
			sdlc: { enabled: false },
		};
		const seen = new SessionSeen(db);
		seen.touch("s-stop", "orient", "TRedPacketTaskServiceImpl", "h_stop_ref");
		const prompt = "请定位 TRedPacketTaskServiceImpl 调用链";
		assert.ok(isCacheablePrompt(prompt));
		const out = await runStopCache({
			projectRoot: dir,
			sessionId: "s-stop",
			cfg,
			db,
			seen,
			input: { prompt, status: "completed" },
		});
		assert.equal(out.l0, true);
		db.close();
	});

	it("miss_only stable prefix skipped on L0 hit", async () => {
		dir = mkdtempSync(join(tmpdir(), "cm-missonly-"));
		const db = new DatabaseSync(join(dir, "handles.db"));
		const cfg = {
			cache: { ttl_sec: 60 },
			cache_engine: {
				promptCache: true,
				stablePrefix: true,
				stablePrefixMode: "miss_only",
				stablePrefixMaxTokens: 200,
				stablePrefixTrimRules: true,
			},
			brain: { project_id: "shejiuPro" },
			sdlc: { enabled: false },
		};
		const prompt = "请定位 TRedPacketTaskServiceImpl 调用链";
		const meta = buildCacheKeyMeta(dir, cfg, {});
		const engine = new CacheEngine(db, cfg);
		engine.storeExact(
			{ normalized_prompt: prompt, ...meta },
			"h_missonly",
			{ stable: true, reusable: true, verified: true },
		);
		const hit = await runPromptPipeline({
			projectRoot: dir,
			prompt,
			sessionId: "s-mo",
			cfg,
			db,
		});
		assert.equal(hit.exact_hit, true);
		const inj = hit.additional_context ?? "";
		assert.ok(!inj.includes("[Stable]"), "stable block should be skipped on L0 hit");
		assert.ok(inj.includes("h_missonly"));
		db.close();
	});

	it("L2 pre-tool deny when tool cache hit", async () => {
		dir = mkdtempSync(join(tmpdir(), "cm-l2-"));
		const db = new DatabaseSync(join(dir, "handles.db"));
		const cfg = {
			cache: { ttl_sec: 60 },
			brain: { project_id: "shejiuPro" },
			cache_engine: { toolCache: true, toolCachePreDeny: true },
		};
		const engine = new CacheEngine(db, cfg);
		engine.storeTool(
			dir,
			{ project_id: "shejiuPro", tool_name: "context_orient", args: { query: "Foo" } },
			"h_l2_ref",
			{ verified: true, stable: true },
		);
		let denied = false;
		const { tryDenyL2ToolCache } = await import("../lib/cache-engine/pre-tool-l2.mjs");
		const rt = { cfg, cacheEngine: engine };
		tryDenyL2ToolCache({
			rt,
			projectRoot: dir,
			sessionId: "s-l2",
			innerMcp: "context_orient",
			innerArgs: { query: "Foo" },
			record: () => {},
			deny: () => {
				denied = true;
			},
		});
		assert.equal(denied, true);
		db.close();
	});

	it("peak profile enables integrations", () => {
		const p = applyPeakCacheEngine({ peak: true });
		assert.equal(p.stablePrefixMode, "miss_only");
		assert.equal(p.semanticCache, true);
		assert.equal(p.semanticMode, "hybrid");
		assert.equal(p.compression, true);
		assert.equal(p.kvIntegration, true);
		assert.equal(p.redisPromptMirror, true);
		assert.equal(p.toolCachePreDeny, true);
		assert.equal(p.brainSyncOnStop, true);
	});

	it("prompt pipeline fail-open without db", async () => {
		const out = await runPromptPipeline({
			projectRoot: process.cwd(),
			prompt: "  test prompt  ",
			sessionId: "s1",
			cfg: { cache_engine: { promptCache: true }, brain: {} },
			db: null,
		});
		assert.equal(out.ok, true);
		assert.equal(out.exact_hit, false);
	});
});

after(() => {
	if (dir) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* temp */
		}
	}
});
