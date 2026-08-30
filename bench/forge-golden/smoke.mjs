#!/usr/bin/env node
/**
 * P0 vendoring smoke test — proves the forge tree (work-mind pure-logic assets)
 * is alive inside Token-Mind with zero services and zero npm deps.
 *
 *   node bench/forge-golden/smoke.mjs   # exit 0 = pass
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORGE = path.join(ROOT, "context-compress-main", "src", "forge");
const load = (rel) => import(`${new URL("file:///" + path.join(FORGE, rel).replace(/\\/g, "/"))}`);

// 1. token estimate + lexical search on a synthetic corpus (no embedding service)
const store = await load("src/lib/store.mjs");
{
	assert.equal(store.estimateTokens("abcd"), 1);
	const corpus = {
		chunks: [
			{ chunk_id: "a", path: "docs/deploy.md", heading_path: "Deploy", text: "Deploy the service with docker compose up -d and pull bge-m3 from ollama.", embedding: null },
			{ chunk_id: "b", path: "docs/gate.md", heading_path: "Gate", text: "The search gate blocks low score results and small file reads.", embedding: null },
			{ chunk_id: "c", path: "src/api/server.mjs", heading_path: "Server", text: "HTTP API server with redis queue wiring.", embedding: null },
		],
	};
	const hits = store.searchIndex(corpus, null, { query: "search gate low score", topK: 2 });
	assert.ok(hits.length >= 1, "lexical search returns hits");
	assert.equal(hits[0].chunk_id, "b", "lexical mode ranks the matching chunk first");
}

// 2. tokenAwarePack: greedy packing under budget, never empty
{
	const hits = Array.from({ length: 5 }, (_, i) => ({
		chunk_id: `h${i}`, path: `f${i}.md`, text: "x".repeat(400), score: 1 - i * 0.1,
	}));
	const packed = store.tokenAwarePack(hits, 300);
	assert.ok(packed.length >= 1, "pack always returns >=1 hit");
	assert.ok(packed.every((h) => h.estimated_tokens <= 300), "packed hits respect budget");
}

// 3. tool-result gate: JSON shrink + budget truncate + dedup + status semantics
const trg = await load("mcp-client/lib/tool-result-gate.mjs");
{
	const big = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, note: "y".repeat(500) })) });
	const out = trg.gateToolResult({ payload: big, max_tokens: 200, dedup: false, session_id: "s1" });
	assert.equal(typeof out.text, "string");
	assert.ok(out.metrics.delivered_tokens <= 200 + 128, `budget respected (body + fixed envelope): ${out.metrics.delivered_tokens}`);
	assert.ok(out.metrics.saved_ratio > 0.5, "meaningful savings on bloated JSON");

	// dedup: same payload twice → second is marked as duplicate
	const a = trg.gateToolResult({ payload: "same-body-1234567890".repeat(40), session_id: "s2" });
	const b = trg.gateToolResult({ payload: "same-body-1234567890".repeat(40), session_id: "s2" });
	assert.ok(a.status !== b.status || b.metrics.saved_ratio > a.metrics.saved_ratio, "second delivery is deduped/cheaper");
}

// 4. gate envelope: negative-savings bypass (never deliver a bigger payload)
const env = await load("mcp-client/lib/gate-envelope.mjs");
{
	// tiny body: envelope would grow it → bypass returns the bare body
	const bypassed = env.wrapIfSaves({ body: "abc", evidence_ids: ["F-0001"] }, store.estimateTokens);
	assert.ok(!bypassed.includes("[GATE]"), "bypass returns bare body when envelope would grow payload");
	// truncated body: envelope is mandatory (evidence pointer must reach the model)
	const wrapped = env.wrapIfSaves({ body: "z".repeat(2000), truncated: true, evidence_ids: ["F-0002"] }, store.estimateTokens);
	assert.ok(wrapped.includes("[GATE]") && wrapped.includes("get_evidence"), "truncated delivery carries the evidence envelope");
}

// 5. search gate: blocking rules return plain text semantics
const sg = await load("mcp-client/lib/search-gate.mjs");
{
	const abort = sg.lowScoreAbortText({ hits: [{ score: 0.1, path: "docs/x.md" }] });
	assert.ok(abort && abort.includes("LOW_SCORE_ABORT"), "low score abort text present");
	assert.equal(sg.lowScoreAbortText({ hits: [{ score: 0.8, path: "docs/x.md" }] }), null, "high score does not abort");
	const params = sg.resolveMcpSearchParams({ query: "overview" });
	assert.ok(params.top_k >= 5, "overview query widens top_k");
	assert.equal(params.format, "code", "overview query gets path+line format");
	const precise = sg.resolveMcpSearchParams({ query: "P57 bug" });
	assert.ok(precise.top_k <= 2, "precise ID lookup narrows top_k");
}

// 6. sufficiency ladder: pure rule evaluation
const suf = await load("src/retrieval/sufficiency.mjs");
{
	const noDoc = suf.evaluateSufficiency({ selectedDoc: null });
	assert.ok(noDoc.confidence === 0, "no doc → zero confidence");
	const okDoc = suf.evaluateSufficiency({
		selectedDoc: { rerank_score: 0.9, document: { answer_eligible: true } },
		confidenceBand: "HIGH",
	});
	assert.ok(okDoc.sufficient && okDoc.confidence >= 0.85, "HIGH band strong doc keeps high confidence");
	const lowJunk = suf.evaluateSufficiency({
		selectedDoc: { rerank_score: 0.2, document: { answer_eligible: true } },
		confidenceBand: "LOW",
		corpusProfile: "shejiu-docs",
	});
	assert.ok(!lowJunk.sufficient && lowJunk.reason === "SUB_HIGH_CONFIDENCE_HOLD", "LOW-band junk is abstained by default");
}

console.log("FORGE SMOKE: ALL 6 MECHANISMS PASS (store/pack/gate/envelope/search-gate/sufficiency)");
