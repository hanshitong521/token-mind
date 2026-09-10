/**
 * Prompt Lab API handlers (spec §35 routes; ADR-0012 D3).
 *
 * Pure-ish functions: each takes `(store, body)` and returns a plain object
 * for the HTTP layer to serialize. No HTTP knowledge here — the server file
 * only maps routes onto these and handles 404/JSON errors.
 *
 * Every analyze/optimize that carries a store persists a version (spec §56:
 * prompt://<document>/<version>), so History is real data, not a session
 * cache. Evaluate (Step 9, ADR-0013) runs the builtin deterministic engine
 * and persists run evidence; the publish gate only opens when an all-passing
 * run exists for the same content hash. Promptfoo remains an explicit
 * NOT_INSTALLED adapter — a state, never a silent pass (ADR-0010).
 */

import { parsePrompt, serializeToMarkdown, serializeToMessages, serializeToAnthropic } from "../prompt-engine/parser.mjs";
import { analyzeTokens } from "../prompt-engine/token-analyzer.mjs";
import { analyzeCacheStability } from "../prompt-engine/cache-analyzer.mjs";
import { layoutBundle } from "../prompt-engine/layout.mjs";
import * as E from "../prompt-engine/index.mjs";
import { sha256 } from "../prompt-engine/manifest.mjs";
import { runBuiltinEval, EVAL_PROVIDERS } from "./eval.mjs";

/**
 * Eval provider state (Step 9, ADR-0013): the builtin deterministic engine is
 * installed and offline-capable; Promptfoo stays an explicit adapter that is
 * NOT_INSTALLED until wired — never a silent pass (ADR-0010).
 */
export const EVAL_PROVIDER_STATE = "builtin";
export const PROMPTFOO_STATE = "PROMPTFOO_NOT_INSTALLED";

const sumTokens = (manifest) => (manifest?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);

/** Engine fingerprints expose `rootHash`; storage/UI use `root` + `segments`. */
function fpOf(f) {
	return f ? { root: f.root ?? f.rootHash ?? null, segments: f.segments ?? f.segmentMap ?? {} } : null;
}

function versionUri(doc, v) {
	return `prompt://${doc.documentId}/${v.version_no}`;
}

/** sha256 of the raw content — matches store.ensureDocument identity. */
function contentHashOf(content) {
	return sha256(String(content ?? ""));
}

/**
 * Eval evidence lookup for the gate: the most recent builtin run over the
 * same content hash. When present and all-passed, critical_assertions_pass
 * becomes PASS; a FAIL run keeps the gate closed (UNKNOWN stays UNKNOWN).
 * Returns { pass, runId, evalProvider, kind } or null.
 */
function evalEvidenceFor(store, content) {
	return evalEvidenceForHash(store, contentHashOf(content));
}

/** Evidence lookup by content hash (document identity is source-hash based). */
function evalEvidenceForHash(store, hash) {
	if (!store) return null;
	const ev = store.latestEvalEvidence(hash);
	if (!ev) return null;
	return {
		pass: ev.allPassed,
		runId: ev.runId,
		evalProvider: ev.evalProvider,
		kind: "builtin-run",
		summary: `${ev.assertionsPassed}/${ev.assertionsTotal} assertions, ${ev.negativeDetected}/${ev.negativeTotal} negatives, ${ev.regressionCount} regressions`,
	};
}

function persistState(store, { content, manifest, scores = {}, tokens = null, mode = null, kind = "analyze", provider = null, model = null, sourceType = null, fingerprint = null, stablePrefixRatio = null, findings = [], title = null }) {
	const v = store.saveVersion({
		content,
		manifest,
		scores,
		tokensBefore: null,
		tokensAfter: tokens ?? sumTokens(manifest),
		mode,
		kind,
		provider,
		model,
		sourceType,
		fingerprint: fpOf(fingerprint),
		stablePrefixRatio,
		title,
	});
	store.saveFindings(v.id, findings);
	if (fpOf(fingerprint)?.root) store.saveFingerprint(v.id, fpOf(fingerprint), {
		stablePrefixTokens: stablePrefixRatio != null ? Math.round(stablePrefixRatio * (tokens ?? sumTokens(manifest))) : null,
		firstDynamicBlock: null,
	});
	const doc = store.db.prepare(`SELECT id, title FROM prompt_documents WHERE id=?`).get(v.document_id);
	return { versionId: v.id, versionNo: v.version_no, documentId: v.document_id, uri: versionUri({ documentId: v.document_id }, v) };
}

// ─── routes ────────────────────────────────────────────────────────────────

export function routeImport(store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const doc = store.ensureDocument(content, {
		title: body.title ?? null,
		sourceType: body.sourceType ?? "markdown",
		provider: body.provider ?? null,
		model: body.model ?? null,
	});
	if (store) store.bump("import_count");
	return { ok: true, documentId: doc.documentId, sourceHash: doc.sourceHash, title: doc.title, created: doc.created };
}

export function routeAnalyze(store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const sourceType = body.sourceType ?? "markdown";
	const provider = body.provider ?? null;
	const model = body.model ?? null;
	const options = { ...(body.options ?? {}), redactSecrets: body.options?.redactSecrets ?? true };

	// Eval evidence (Step 9): the gate's critical_assertions_pass is driven by
	// the latest builtin Eval run over this exact content hash — never by a
	// client-declared boolean. No run yet ⇒ UNKNOWN (gate stays closed).
	const evidence = evalEvidenceFor(store, content);
	if (evidence) options.assertions = evidence;

	const a = E.analyze({ content, sourceType, provider, model, options });
	const tokens = sumTokens(a.manifest);
	const cache = a.cache;
	const persisted = store
		? persistState(store, {
				content,
				manifest: a.manifest,
				scores: a.scores,
				tokens,
				kind: "analyze",
				provider,
				model,
				sourceType,
				fingerprint: a.fingerprint,
				stablePrefixRatio: cache?.stablePrefixRatio ?? null,
				findings: a.findings,
				title: body.title ?? null,
			})
		: null;
	if (store) store.bump("analyze_count");

	return {
		ok: true,
		engineVersion: a.engineVersion,
		redacted: a.redacted,
		version: persisted,
		scores: a.scores,
		scoreDimensions: a.scoreDimensions,
		tokens: tokens,
		cache: cache
			? {
					stablePrefixTokens: cache.stablePrefixTokens,
					stablePrefixRatio: cache.stablePrefixRatio,
					firstDynamicBlock: cache.firstDynamicBlock,
					cacheBreakerCount: cache.cacheBreakerCount,
					totalTokens: cache.totalTokens,
				}
			: null,
		findings: a.findings,
		findingsSummary: a.findingsSummary,
		blocks: a.manifest.blocks.map((b, i) => ({
			index: i,
			blockId: b.id,
			kind: b.kind,
			role: b.role,
			mutability: b.mutability,
			stability: b.stability,
			tokens: b.tokenCount?.count ?? 0,
			text: b.text,
		})),
		fingerprint: { root: a.fingerprint.root },
		secrets: a.secrets,
		ruleExecution: a.ruleExecution,
		gate: a.gate,
		providerCapabilities: a.providerCapabilities,
	};
}

export function routeOptimize(store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const sourceType = body.sourceType ?? "markdown";
	const provider = body.provider ?? null;
	const model = body.model ?? null;
	const mode = body.mode ?? "B";
	const options = { ...(body.options ?? {}), mode, redactSecrets: body.options?.redactSecrets ?? true, assertions: body.assertions ?? null };

	// Step 9: reuse the last builtin Eval run over this content when the client
	// did not attach explicit assertions — same evidence chain as routeAnalyze.
	if (!options.assertions) {
		const evidence = evalEvidenceFor(store, content);
		if (evidence) options.assertions = evidence;
	}

	const r = E.optimize({ content, sourceType, provider, model, options });
	const layout = layoutBundle(r.original.manifest);
	const persisted = store
		? persistState(store, {
				content,
				manifest: r.original.manifest,
				scores: r.original.scores ?? {},
				tokens: r.summary.beforeTokens,
				mode: r.mode,
				kind: "optimize",
				provider,
				model,
				sourceType,
				fingerprint: r.original.fingerprint,
				stablePrefixRatio: null,
				findings: r.findings ?? [],
				title: body.title ?? null,
			})
		: null;
	if (store) {
		store.bump("optimize_count");
		if (r.mode === E.OPTIMIZE_MODE.CONSERVATIVE_REWRITE) store.bump("semantic_patch_count", Math.max(0, r.pendingEval?.length ?? 0));
		store.savePatch(persisted.versionId, r.patch, { applied: false, why: `optimize mode=${r.mode}` });
		// Mode C: surface each semantic candidate as its own *pending* patch
		// row (risk SEMANTIC_REWRITE) so History keeps audit trail and the
		// confirm route can resolve candidateId → ops deterministically.
		for (const cand of r.pendingEval ?? []) {
			if (!Array.isArray(cand.ops) || cand.ops.length === 0) continue;
			store.savePatch(
				persisted.versionId,
				{ operations: cand.ops, risk: "SEMANTIC_REWRITE", baseFingerprint: r.patch?.baseFingerprint ?? null },
				{ applied: false, why: `mode=C candidate ${cand.candidateId ?? cand.ruleId}` },
			);
		}
	}

	return {
		ok: true,
		mode: r.mode,
		version: persisted,
		summary: r.summary,
		before: {
			tokens: r.summary.beforeTokens,
			scores: r.original.scores ?? null,
			fingerprint: r.original.fingerprint,
			ruleExecution: r.original.ruleExecution,
		},
		after: {
			tokens: r.summary.afterTokens,
			scores: r.optimized.scores ?? null,
			fingerprint: r.optimized.fingerprint,
			ruleExecution: r.optimized.ruleExecution,
		},
		delta: {
			tokens: r.summary.deltaTokens,
			quality: (r.optimized.scores?.quality ?? null) != null && (r.original.scores?.quality ?? null) != null ? (r.optimized.scores.quality - r.original.scores.quality) : null,
			cacheStability: (r.optimized.scores?.cacheStability ?? null) != null && (r.original.scores?.cacheStability ?? null) != null ? (r.optimized.scores.cacheStability - r.original.scores.cacheStability) : null,
		},
		originalBlocks: r.original.manifest.blocks.map((b, i) => ({ index: i, blockId: b.id, kind: b.kind, mutability: b.mutability, stability: b.stability, text: b.text, tokens: b.tokenCount?.count ?? 0 })),
		optimizedBlocks: r.optimized.manifest.blocks.map((b, i) => ({ index: i, blockId: b.id, kind: b.kind, mutability: b.mutability, stability: b.stability, text: b.text, tokens: b.tokenCount?.count ?? 0 })),
		patch: { patchId: r.patch.patchId, baseFingerprint: r.patch.baseFingerprint, risk: r.patch.risk, reversible: r.patch.reversible },
		patchOps: r.patchOps.map((o, i) => ({ index: i, ...o })),
		reverse: r.reverse,
		recommendation: r.recommendation,
		verification: r.verification,
		gate: r.gate,
		layout,
		pendingEval: r.pendingEval,
	};
}

export function routeDiff(_store, body = {}) {
	const before = body.before?.content ?? body.before;
	const after = body.after?.content ?? body.after;
	if (typeof before !== "string" || typeof after !== "string") return { ok: false, error: "before/after content required" };
	return { ok: true, diff: E.diff(before, after, { provider: body.provider ?? null }) };
}

export function routeFingerprint(store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const f = E.fingerprint(content, { provider: body.provider ?? null, model: body.model ?? null });
	if (store) store.bump("analyze_count", 0); // fingerprint is read-only; no telemetry
	return { ok: true, fingerprint: { root: f.root ?? f.rootHash ?? null, segments: f.segments ?? f.segmentMap ?? {}, rootHash: f.rootHash ?? f.root ?? null } };
}

export function routeTokenize(_store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const manifest = parsePrompt(content, { sourceType: body.sourceType ?? "markdown" });
	return { ok: true, total: sumTokens(manifest), analysis: analyzeTokens(manifest) };
}

export function routeLayout(store, body = {}) {
	const content = String(body.content ?? "");
	if (!content.trim()) return { ok: false, error: "content required" };
	const manifest = parsePrompt(content, { sourceType: body.sourceType ?? "markdown" });
	const layout = layoutBundle(manifest);
	if (store) store.bump("layout_count");
	return { ok: true, layout };
}

/**
 * Step 9 Eval route — runs the builtin deterministic evaluator (offline,
 * no LLM). Persists the run + per-case results when a store is present and
 * returns the normalized report the UI renders. Promptfoo remains an explicit
 * NOT_INSTALLED adapter; semantic metrics stay not_measured (never fabricated).
 *
 * body: { content?, sourceType?, versionId?, caseId?, fixtureId?, mode? }
 *   - content given           → evaluate that content (custom assertion case)
 *   - versionId given         → evaluate the stored version's content
 *   - neither                 → run the builtin dataset + fixture regression
 */
export function routeEvaluate(store, body = {}) {
	let content = body.content != null ? String(body.content) : null;
	let versionId = body.versionId != null ? String(body.versionId) : null;

	if (!content && versionId && store) {
		const row = store.versionRow(versionId);
		if (!row) return { ok: false, error: "version not found" };
		const manifest = store.manifestOf(versionId);
		content = (manifest?.blocks ?? []).map((b) => b.text ?? "").join("\n");
	}

	const report = runBuiltinEval({
		content: content != null && content.trim() ? content : null,
		sourceType: body.sourceType ?? "markdown",
		caseId: body.caseId ?? null,
		fixtureId: body.fixtureId ?? null,
		provider: body.provider ?? "generic",
		mode: body.mode ?? "optimize",
	});

	if (store) {
		const hash = contentHashOf(content ?? "");
		const runRow = store.saveEvalRun({
			evalProvider: EVAL_PROVIDERS.BUILTIN,
			kind: versionId ? "version" : content ? "content" : "regression",
			promptVersionId: versionId,
			contentHash: hash,
			dataset: report.dataset,
			summary: report.summary,
			metrics: report.metrics,
		});
		store.saveEvalResults(runRow.id, report.results);
		report.runId = runRow.id;
	}

	return { ok: report.ok, ...report };
}

export function routeExport(_store, body = {}) {
	const format = body.format ?? "markdown";
	const target = body.target ?? null;
	let manifest = null;

	if (body.content != null) {
		manifest = parsePrompt(String(body.content), { sourceType: body.sourceType ?? "markdown", provider: body.provider ?? null });
	} else if (body.manifest) {
		manifest = body.manifest;
	} else {
		return { ok: false, error: "content or manifest required" };
	}

	switch (format) {
		case "markdown":
			return { ok: true, format, text: serializeToMarkdown(manifest) };
		case "messages":
			return { ok: true, format, json: serializeToMessages(manifest) };
		case "anthropic":
			return { ok: true, format, json: serializeToAnthropic(manifest) };
		case "patch":
			return { ok: true, format, json: body.operations ?? [] };
		// Step 11 (§50): file-target export family — same markdown serializer
		// with a per-target front-matter/header and suggested filename.
		case "file": {
			const file = fileExportFor(target ?? "AGENTS", manifest);
			if (!file) return { ok: false, error: `unknown export target "${target}"` };
			return { ok: true, format: "file", target, filename: file.filename, text: file.text };
		}
		case "openai_json":
			return { ok: true, format, filename: "openai-messages.json", json: serializeToMessages(manifest) };
		case "anthropic_json":
			return { ok: true, format, filename: "anthropic-request.json", json: serializeToAnthropic(manifest) };
		default:
			return { ok: false, error: `unknown export format "${format}"` };
	}
}

/** §50 file targets: markdown body + agent-specific header/filename. */
const FILE_TARGETS = Object.freeze({
	AGENTS: { filename: "AGENTS.md", header: "<!-- generated by Token-Mind Prompt Lab -->" },
	CLAUDE: { filename: "CLAUDE.md", header: "<!-- generated by Token-Mind Prompt Lab -->" },
	RULES: { filename: ".cursor/rules/prompt-lab.mdc", header: "---\ndescription: Generated by Token-Mind Prompt Lab\nglobs: **/*.md\n---" },
	SKILL: { filename: "SKILL.md", header: "---\nname: generated-prompt\n---" },
});

function fileExportFor(target, manifest) {
	const key = String(target ?? "").toUpperCase();
	const t = FILE_TARGETS[key];
	if (!t) return null;
	const body = serializeToMarkdown(manifest);
	return { filename: t.filename, text: `${t.header}\n\n${body}` };
}

export function routeHistoryList(store, body = {}) {
	if (!store) return { ok: false, error: "history requires a store/db" };
	const limit = Math.min(Number(body.limit) || 50, 200);
	const offset = Math.max(Number(body.offset) || 0, 0);
	return { ok: true, ...store.historyList({ docId: body.docId ?? null, limit, offset }) };
}

export function routeHistoryDetail(store, body = {}) {
	if (!store) return { ok: false, error: "history requires a store/db" };
	const detail = store.versionDetail(String(body.versionId ?? ""));
	if (!detail) return { ok: false, error: "version not found" };
	return {
		ok: true,
		uri: detail.uri,
		version: {
			id: detail.version.id,
			documentId: detail.version.document_id,
			versionNo: detail.version.version_no,
			kind: detail.version.kind,
			mode: detail.version.mode,
			parentVersionId: detail.version.parent_version_id,
			provider: detail.version.provider,
			model: detail.version.model,
			engineVersion: detail.version.engine_version,
			rulePackVersion: detail.version.rule_pack_version,
			tokens: { before: detail.version.tokens_before, after: detail.version.tokens_after, delta: detail.version.delta_tokens },
			scores: {
				quality: detail.version.quality_score,
				cacheStability: detail.version.cache_score,
				tokenEfficiency: detail.version.token_score,
				determinism: detail.version.determinism_score,
				risk: detail.version.risk_score,
			},
			stablePrefixRatio: detail.version.stable_prefix_ratio,
			createdAt: detail.version.created_at,
		},
		blocks: detail.blocks,
		findings: detail.findings,
		patches: detail.patches.map((p) => ({ id: p.id, childVersionId: p.child_version_id, risk: p.patch_risk, opsCount: p.ops_count, applied: p.applied === 1, why: p.why, createdAt: p.created_at, operations: p.operations })),
		fingerprints: detail.fingerprints,
		text: (detail.blocks ?? []).map((b) => b.text).join("\n"),
	};
}

export function routeProviderCapabilities(store) {
	if (!store) return { ok: false, error: "requires a store/db" };
	return { ok: true, providers: store.listProviderCapabilities(), state: "static-registry" };
}

/** Single-accept / Apply-Safe-subset: patch a stored version (STALE-guarded). */
export function routePatchApply(store, body = {}) {
	if (!store) return { ok: false, error: "requires a store/db" };
	const versionId = String(body.versionId ?? "");
	const ops = body.ops ?? body.operations ?? [];
	if (!versionId || !Array.isArray(ops) || ops.length === 0) return { ok: false, error: "versionId and ops required" };
	const applied = store.acceptPatch(versionId, ops, { why: body.why ?? null });
	if (!applied.ok) return { ok: false, ...applied };
	// fresh state for the UI: detail of the child version + recomputed layout
	return { ok: true, childVersionId: applied.childVersionId, detail: routeHistoryDetail(store, { versionId: applied.childVersionId }) };
}

/** Undo the last patch_apply: restore the parent snapshot as a new version. */
export function routePatchReverse(store, body = {}) {
	if (!store) return { ok: false, error: "requires a store/db" };
	const childVersionId = String(body.versionId ?? "");
	const r = store.undoToParent(childVersionId);
	if (!r.ok) return { ok: false, ...r };
	return { ok: true, ...r, detail: routeHistoryDetail(store, { versionId: r.restoredVersionId }) };
}

/**
 * Confirm & apply a Mode-C semantic candidate (Step 10, ADR-0013). The
 * optimizer only surfaces candidates (pendingEval); applying one is an
 * explicit human act that requires Eval evidence. This route persists the
 * SEMANTIC_REWRITE patch as a child version so the undo chain stays intact.
 *
 * body: { versionId, candidateId?, ops?, why? }
 *   - candidateId: the candidate was produced by this route's own optimize
 *     run, so ops are re-derivable from the stored version's pendingEval.
 *   - ops: raw semantic operations supplied directly (same STALE guard).
 */
export function routeConfirmSemantic(store, body = {}) {
	if (!store) return { ok: false, error: "requires a store/db" };
	const versionId = String(body.versionId ?? "");
	const base = store.versionRow(versionId);
	if (!base) return { ok: false, error: "version not found" };

	// P10 gate: no SEMANTIC_REWRITE may be confirmed without an all-passing
	// builtin Eval run over the same content (document identity = source_hash,
	// stored on the version row — never recomputed from serialized blocks).
	const evidence = evalEvidenceForHash(store, base.source_hash);
	if (!evidence) {
		return { ok: false, error: "P10: no builtin Eval run over this content — run /promptLab/evaluate first (critical assertions are UNKNOWN)" };
	}
	if (evidence.pass !== true) {
		return { ok: false, error: "P10: last builtin Eval run FAILED — semantic rewrite blocked until assertions pass" };
	}

	let ops = Array.isArray(body.ops) ? body.ops : null;
	if (!ops) {
		// resolve the single pending SEMANTIC_REWRITE patch stored for this
		// version (optimize mode=C persists one row per candidate)
		const pendingPatches = store.patchesOf(versionId).filter((p) => p.patch_risk === "SEMANTIC_REWRITE" && p.applied === 0);
		const matchId = (p) => String(p.why ?? "").includes(String(body.candidateId ?? ""));
		const cand = body.candidateId ? pendingPatches.find(matchId) || (pendingPatches.length === 1 ? pendingPatches[0] : null) : pendingPatches.length === 1 ? pendingPatches[0] : null;
		ops = cand?.operations ?? null;
		if (!ops) return { ok: false, error: body.candidateId ? `candidate ${body.candidateId} not found among pending semantic patches` : "exactly one pending semantic candidate required (or pass ops)" };
	}
	if (!ops || ops.length === 0) return { ok: false, error: "ops or candidateId required" };
	if (ops.some((o) => (o.risk ?? "") !== "SEMANTIC_REWRITE" && !/MERGE|EXTRACT/.test(o.type ?? ""))) {
		return { ok: false, error: "only SEMANTIC_REWRITE ops may go through this route" };
	}
	const applied = store.acceptPatch(versionId, ops, { why: body.why ?? "semantic candidate confirmed (eval-gated)" });
	if (!applied.ok) return { ok: false, ...applied };
	return { ok: true, risk: applied.risk, childVersionId: applied.childVersionId, detail: routeHistoryDetail(store, { versionId: applied.childVersionId }) };
}

/** Health/version bundle for the lab footer. */
export function routeLabInfo(store) {
	return {
		ok: true,
		engine: E.ENGINE_VERSION,
		rulePack: E.RULE_PACK_VERSION,
		evalProvider: EVAL_PROVIDER_STATE,
		promptfoo: PROMPTFOO_STATE,
		optimizeModes: ["A", "B", "C", "D"],
		...(store ? { evalRuns: store.getCounters().eval_run_count, evalRegressions: store.getCounters().eval_regression_count } : {}),
	};
}
