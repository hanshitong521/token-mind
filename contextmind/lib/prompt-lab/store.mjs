/**
 * Prompt Lab persistence (spec §36 / §56, ADR-0012 D2).
 *
 * A thin, consumer-driven store over node:sqlite. It owns NO analysis logic —
 * the API layer hands it already-computed bundles. Responsibilities:
 *
 *   - documents keyed by source_hash (same bytes = same document)
 *   - versions (prompt://<document>/<version>) bound to
 *     engine/rule-pack/tokenizer/optimizer versions (spec §56)
 *   - blocks / findings / fingerprints / patches per version
 *   - provider capability snapshot (spec §58)
 *   - §59 telemetry counters (kept in prompt_meta, merged into the
 *     three-column ledger by a later Runtime round)
 *
 * Writes are single-process (local lab server), matching the repository's
 * node:sqlite usage everywhere else.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensurePromptLabSchema } from "../db/prompt-lab-schema.mjs";
import { sha256 } from "../prompt-engine/manifest.mjs";
import { listProviders, PROVIDERS } from "../prompt-engine/providers.mjs";
import { applyPatch, createPatch } from "../prompt-engine/patch.mjs";

const TELEMETRY_KEYS = Object.freeze([
	"analyze_count",
	"optimize_count",
	"import_count",
	"layout_count",
	"safe_patch_count",
	"semantic_patch_count",
	"patch_apply_count",
	"patch_rejected_count",
	"patch_reverse_count",
	"eval_run_count",
	"eval_regression_count",
]);

export function docIdOf(sourceHash) {
	return `doc:${sourceHash.slice(0, 16)}`;
}

export class PromptLabStore {
	constructor(db) {
		this.db = db;
		this.available = ensurePromptLabSchema(db);
		if (this.available) this.seedProviderCapabilities();
	}

	close() {
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}

	/** Open (and create) the writable prompt-lab.db at `path`. */
	static open(path) {
		return new PromptLabStore(new DatabaseSync(path));
	}

	get ready() {
		return this.available;
	}

	// ── meta / telemetry ───────────────────────────────────────────────────

	bump(key, by = 1) {
		this.db.prepare(`INSERT OR IGNORE INTO prompt_meta(key, value) VALUES(?, 0)`).run(key);
		this.db
			.prepare(`UPDATE prompt_meta SET value = CAST(COALESCE(value, '0') AS INTEGER) + ? WHERE key=?`)
			.run(by, key);
	}

	getCounters() {
		const rows = this.db.prepare(`SELECT key, value FROM prompt_meta`).all();
		const out = {};
		for (const k of TELEMETRY_KEYS) out[k] = 0;
		for (const r of rows) if (TELEMETRY_KEYS.includes(r.key)) out[r.key] = Number(r.value) || 0;
		return out;
	}

	seedProviderCapabilities() {
		const now = Date.now();
		const upsert = this.db.prepare(
			`INSERT INTO provider_capabilities
			   (provider, model_family, capabilities_json, tokenizer_id, tokenizer_mode, source, last_verified_at)
			 VALUES (?, ?, ?, ?, ?, 'static-registry', ?)
			 ON CONFLICT(provider) DO UPDATE SET
			   capabilities_json=excluded.capabilities_json,
			   tokenizer_id=excluded.tokenizer_id,
			   tokenizer_mode=excluded.tokenizer_mode,
			   source='static-registry',
			   last_verified_at=excluded.last_verified_at`,
		);
		for (const cap of listProviders()) {
			const family = PROVIDERS[cap.id] ?? cap.id;
			upsert.run(cap.id, family, JSON.stringify(cap), cap.tokenizerId ?? null, cap.tokenizerMode ?? null, now);
		}
	}

	listProviderCapabilities() {
		return this.db
			.prepare(
				`SELECT provider, model_family, capabilities_json, tokenizer_id, tokenizer_mode, source, last_verified_at
				 FROM provider_capabilities ORDER BY provider`,
			)
			.all()
			.map((r) => ({ ...r, capabilities: JSON.parse(r.capabilities_json), capabilities_json: undefined }));
	}

	// ── documents ──────────────────────────────────────────────────────────

	/**
	 * Resolve (and register when missing) the document for `content`.
	 * Identity = source bytes (source_hash), so identical content across
	 * sessions keeps one document; a later title wins (updated_at refresh).
	 */
	ensureDocument(content, { title = null, sourceType = null, provider = null, model = null } = {}) {
		const sourceHash = sha256(String(content ?? ""));
		const id = docIdOf(sourceHash);
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO prompt_documents(id, source_hash, title, source_type, provider, model, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(source_hash) DO UPDATE SET
				   title=COALESCE(?, title),
				   source_type=COALESCE(?, source_type),
				   provider=COALESCE(?, provider),
				   updated_at=?`,
			)
			.run(id, sourceHash, title, sourceType, provider, model, now, now, title, sourceType, provider, now);
		const row = this.db.prepare(`SELECT * FROM prompt_documents WHERE id=?`).get(id);
		return { documentId: row.id, sourceHash, title: row.title, created: row.created_at === now };
	}

	// ── versions ───────────────────────────────────────────────────────────

	nextVersionNo(documentId) {
		const r = this.db
			.prepare(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM prompt_versions WHERE document_id=?`)
			.get(documentId);
		return r.n;
	}

	/**
	 * Persist one analyzed/optimized/restored state.
	 * payload: { content, manifest, scores, tokensBefore, tokensAfter,
	 *            mode, kind, parentVersionId, provider, model, sourceType,
	 *            fingerprint, stablePrefixRatio, title }
	 * Returns the created version row.
	 */
	saveVersion({ content, manifest, scores = {}, tokensBefore = null, tokensAfter = null, mode = null, kind = "analyze", parentVersionId = null, provider = null, model = null, sourceType = null, fingerprint = null, stablePrefixRatio = null, title = null, rootFingerprint = null }) {
		const sourceHash = sha256(String(content ?? ""));
		const doc = this.ensureDocument(content, { title, sourceType, provider, model });
		const versionId = randomUUID();
		const versionNo = this.nextVersionNo(doc.documentId);
		const blocks = manifest?.blocks ?? [];
		const root = rootFingerprint ?? fingerprint?.root ?? null;
		const row = {
			id: versionId,
			document_id: doc.documentId,
			version_no: versionNo,
			kind,
			parent_version_id: parentVersionId,
			mode,
			source_hash: sourceHash,
			root_fingerprint: root,
			provider,
			model,
			engine_version: "1.0.0",
			rule_pack_version: "1.0.0",
			tokenizer_version: "heuristic:chars/4",
			optimizer_version: kind === "optimize" || kind === "patch_apply" ? (mode ?? "SAFE") : null,
			tokens_before: tokensBefore,
			tokens_after: tokensAfter ?? (blocks.length ? blocks.reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0) : null),
			delta_tokens: tokensBefore != null && tokensAfter != null ? tokensAfter - tokensBefore : null,
			quality_score: scores.quality ?? null,
			cache_score: scores.cacheStability ?? null,
			token_score: scores.tokenEfficiency ?? null,
			determinism_score: scores.determinism ?? null,
			risk_score: scores.risk ?? null,
			stable_prefix_ratio: stablePrefixRatio,
			content_json: JSON.stringify({ blocks }),
			created_at: Date.now(),
		};
		const cols = Object.keys(row);
		this.db
			.prepare(`INSERT INTO prompt_versions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
			.run(...cols.map((c) => row[c]));

		const insBlock = this.db.prepare(
			`INSERT INTO prompt_blocks
			   (version_id, block_index, block_id, occurrence, kind, role, lane, stability, mutability, hash, token_count, text)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
		);
		const occOf = new Map();
		blocks.forEach((b, i) => {
			const occ = occOf.get(b.id) ?? 0;
			occOf.set(b.id, occ + 1);
			insBlock.run(versionId, i, b.id, occ, b.kind ?? null, b.role ?? null, b.stability ?? null, b.mutability ?? null, b.hash ?? null, b.tokenCount?.count ?? null, b.text ?? "");
		});
		return this.versionRow(versionId);
	}

	saveFindings(versionId, findings = []) {
		const ins = this.db.prepare(
			`INSERT INTO prompt_findings
			   (id, prompt_version_id, rule_id, category, severity, block_ids_json, title, explanation, proposal_json, requires_eval, auto_applicable, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const now = Date.now();
		for (const f of findings ?? []) {
			ins.run(
				randomUUID(),
				versionId,
				f.ruleId ?? "UNKNOWN",
				f.category ?? null,
				f.severity ?? "INFO",
				JSON.stringify(f.blockIds ?? f.blockRefs?.map((r) => r.blockId) ?? []),
				f.title ?? null,
				f.explanation ?? null,
				JSON.stringify(f.proposal ?? null),
				f.requiresEval ? 1 : 0,
				f.autoApplicable ? 1 : 0,
				now,
			);
		}
	}

	saveFingerprint(versionId, fingerprint, { stablePrefixTokens = null, firstDynamicBlock = null } = {}) {
		if (!fingerprint) return null;
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO prompt_fingerprints(id, version_id, root, segments_json, stable_prefix_tokens, first_dynamic_block, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, versionId, fingerprint.root ?? String(fingerprint), JSON.stringify(fingerprint.segments ?? fingerprint.segmentMap ?? {}), stablePrefixTokens, firstDynamicBlock, Date.now());
		return id;
	}

	savePatch(versionId, patch, { childVersionId = null, applied = false, why = null } = {}) {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO prompt_patches(id, version_id, child_version_id, operations_json, base_fingerprint, patch_risk, ops_count, applied, reversed, why, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			)
			.run(
				id,
				versionId,
				childVersionId,
				JSON.stringify(patch?.operations ?? []),
				patch?.baseFingerprint ?? null,
				patch?.risk ?? "SAFE",
				(patch?.operations ?? []).length,
				applied ? 1 : 0,
				why ?? null,
				Date.now(),
			);
		return this.db.prepare(`SELECT * FROM prompt_patches WHERE id=?`).get(id);
	}

	// ── eval (spec §27–§30; Step 9) ───────────────────────────────────────

	/**
	 * Persist one normalized Eval run (provider=builtin today). Returns the
	 * run row; caller (api.mjs) then stores per-case results.
	 */
	saveEvalRun({
		id = randomUUID(),
		evalProvider = "builtin",
		kind = "content",
		promptVersionId = null,
		contentHash = "",
		dataset = "builtin-1",
		summary = {},
		metrics = {},
	}) {
		this.db
			.prepare(
				`INSERT INTO prompt_eval_runs
				   (id, eval_provider, kind, prompt_version_id, content_hash, dataset,
				    total_cases, passed_cases, assertions_total, assertions_passed,
				    negative_controls_total, negative_controls_detected, regression_count,
				    all_passed, metrics_json, summary_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				evalProvider,
				kind,
				promptVersionId,
				contentHash,
				dataset,
				summary.totalCases ?? 0,
				summary.passedCases ?? 0,
				summary.assertionsTotal ?? 0,
				summary.assertionsPassed ?? 0,
				summary.negativeTotal ?? 0,
				summary.negativeDetected ?? 0,
				summary.regressionCount ?? 0,
				summary.allPassed ? 1 : 0,
				JSON.stringify(metrics),
				JSON.stringify(summary),
				Date.now(),
			);
		this.bump("eval_run_count");
		if ((summary.regressionCount ?? 0) > 0) this.bump("eval_regression_count", summary.regressionCount);
		return this.db.prepare(`SELECT * FROM prompt_eval_runs WHERE id=?`).get(id);
	}

	saveEvalResults(runId, results = []) {
		const ins = this.db.prepare(
			`INSERT INTO prompt_eval_results
			   (id, run_id, case_id, passed, variant, assertions_json, findings_json, metrics_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const now = Date.now();
		for (const r of results ?? []) {
			ins.run(
				randomUUID(),
				runId,
				r.caseId ?? "case",
				r.passed || r.ok ? 1 : 0,
				r.variant ?? "seed",
				JSON.stringify(r.assertions ?? []),
				JSON.stringify(r.findings ?? []),
				JSON.stringify(r.metrics ?? null),
				now,
			);
		}
	}

	/** Latest Eval run bound to a content hash (evidence for the gate). */
	latestEvalEvidence(contentHash, { provider = "builtin" } = {}) {
		const row = this.db
			.prepare(
				`SELECT id, eval_provider, all_passed, passed_cases, total_cases, assertions_passed, assertions_total,
				        negative_controls_detected, negative_controls_total, regression_count, created_at
				 FROM prompt_eval_runs
				 WHERE content_hash=? AND eval_provider=?
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(contentHash, provider);
		if (!row) return null;
		return {
			runId: row.id,
			evalProvider: row.eval_provider,
			allPassed: row.all_passed === 1,
			passedCases: row.passed_cases,
			totalCases: row.total_cases,
			assertionsPassed: row.assertions_passed,
			assertionsTotal: row.assertions_total,
			negativeDetected: row.negative_controls_detected,
			negativeTotal: row.negative_controls_total,
			regressionCount: row.regression_count,
			ranAt: row.created_at,
		};
	}

	listEvalRuns({ limit = 20, offset = 0 } = {}) {
		const rows = this.db
			.prepare(
				`SELECT id, eval_provider, kind, prompt_version_id, content_hash, dataset,
				        total_cases, passed_cases, assertions_total, assertions_passed,
				        negative_controls_total, negative_controls_detected, regression_count,
				        all_passed, created_at
				 FROM prompt_eval_runs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			)
			.all(limit, offset);
		return {
			total: this.db.prepare(`SELECT COUNT(*) AS n FROM prompt_eval_runs`).get().n,
			runs: rows.map((r) => ({
				id: r.id,
				evalProvider: r.eval_provider,
				kind: r.kind,
				versionId: r.prompt_version_id,
				dataset: r.dataset,
				allPassed: r.all_passed === 1,
				passedCases: `${r.passed_cases}/${r.total_cases}`,
				assertions: `${r.assertions_passed}/${r.assertions_total}`,
				negative: `${r.negative_controls_detected}/${r.negative_controls_total}`,
				regressionCount: r.regression_count,
				ranAt: r.created_at,
			})),
		};
	}

	// ── reads ──────────────────────────────────────────────────────────────

	versionRow(versionId) {
		return this.db.prepare(`SELECT * FROM prompt_versions WHERE id=?`).get(versionId);
	}

	blocksOf(versionId) {
		return this.db
			.prepare(`SELECT * FROM prompt_blocks WHERE version_id=? ORDER BY block_index`).all(versionId)
			.map((r) => ({
				blockIndex: r.block_index,
				id: r.block_id,
				occurrence: r.occurrence,
				kind: r.kind,
				role: r.role,
				lane: r.lane,
				stability: r.stability,
				mutability: r.mutability,
				hash: r.hash,
				tokenCount: r.token_count == null ? null : { count: r.token_count, method: "heuristic:chars/4", estimated: true },
				text: r.text,
			}));
	}

	manifestOf(versionId) {
		const row = this.versionRow(versionId);
		if (!row) return null;
		return { blocks: JSON.parse(row.content_json).blocks ?? this.blocksOf(versionId) };
	}

	findingsOf(versionId) {
		return this.db
			.prepare(`SELECT * FROM prompt_findings WHERE prompt_version_id=? ORDER BY created_at, id`).all(versionId)
			.map((r) => ({
				id: r.id,
				ruleId: r.rule_id,
				category: r.category,
				severity: r.severity,
				blockIds: JSON.parse(r.block_ids_json ?? "[]"),
				title: r.title,
				explanation: r.explanation,
				proposal: JSON.parse(r.proposal_json ?? "null"),
				requiresEval: r.requires_eval === 1,
				autoApplicable: r.auto_applicable === 1,
			}));
	}

	patchesOf(versionId) {
		return this.db
			.prepare(`SELECT * FROM prompt_patches WHERE version_id=? OR child_version_id=? ORDER BY created_at`).all(versionId, versionId)
			.map((r) => ({ ...r, operations: JSON.parse(r.operations_json ?? "[]"), operations_json: undefined }));
	}

	fingerprintsOf(versionId) {
		return this.db
			.prepare(`SELECT * FROM prompt_fingerprints WHERE version_id=? ORDER BY created_at`).all(versionId)
			.map((r) => ({ ...r, segments: JSON.parse(r.segments_json ?? "{}"), segments_json: undefined }));
	}

	historyList({ docId = null, limit = 50, offset = 0 } = {}) {
		const where = docId ? "WHERE v.document_id=?" : "";
		const args = docId ? [docId] : [];
		const rows = this.db
			.prepare(
				`SELECT v.id, v.document_id, v.version_no, v.kind, v.mode, v.root_fingerprint, v.provider, v.model,
				        v.engine_version, v.rule_pack_version, v.tokens_before, v.tokens_after, v.delta_tokens,
				        v.quality_score, v.cache_score, v.token_score, v.determinism_score, v.risk_score,
				        v.stable_prefix_ratio, v.created_at, d.title, d.source_type
				 FROM prompt_versions v JOIN prompt_documents d ON d.id=v.document_id
				 ${where} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
			)
			.all(...args, limit, offset);
		return {
			total: this.db.prepare(`SELECT COUNT(*) AS n FROM prompt_versions v ${where}`).get(...args).n,
			versions: rows.map((r) => ({
				id: r.id,
				uri: `prompt://${r.document_id}/${r.version_no}`,
				documentId: r.document_id,
				versionNo: r.version_no,
				kind: r.kind,
				mode: r.mode,
				title: r.title,
				sourceType: r.source_type,
				provider: r.provider,
				model: r.model,
				rootFingerprint: r.root_fingerprint,
				tokens: { before: r.tokens_before, after: r.tokens_after, delta: r.delta_tokens },
				scores: { quality: r.quality_score, cacheStability: r.cache_score, tokenEfficiency: r.token_score, determinism: r.determinism_score, risk: r.risk_score },
				stablePrefixRatio: r.stable_prefix_ratio,
				createdAt: r.created_at,
			})),
		};
	}

	versionDetail(versionId) {
		const row = this.versionRow(versionId);
		if (!row) return null;
		return {
			version: row,
			uri: `prompt://${row.document_id}/${row.version_no}`,
			blocks: this.blocksOf(versionId),
			findings: this.findingsOf(versionId),
			patches: this.patchesOf(versionId),
			fingerprints: this.fingerprintsOf(versionId),
		};
	}

	// ── mutations ──────────────────────────────────────────────────────────

	/**
	 * Accept a single (or several) patch op(s) on top of a stored version.
	 * STALE-guarded: ops must address the stored manifest (applyPatch guard).
	 * Success writes a child version (kind=patch_apply) + an applied patch row.
	 */
	acceptPatch(versionId, operations, { why = null } = {}) {
		const base = this.versionRow(versionId);
		if (!base) return { ok: false, reason: "VERSION_NOT_FOUND" };
		const manifest = this.manifestOf(versionId);
		const ops = Array.isArray(operations) ? operations : [operations];
		if (ops.length === 0) return { ok: false, reason: "EMPTY_OPS" };

		// Risk is derived from the ops, not client-claimed: any SEMANTIC /
		// structural op (MERGE_BLOCKS, EXTRACT_*, REPLACE w/o exact-dup id)
		// marks the whole patch SEMANTIC_REWRITE — those need Eval evidence
		// and are never auto-applied by the optimizer itself.
		const semanticOps = ops.filter((o) => o.type === "MERGE_BLOCKS" || o.type === "EXTRACT_DYNAMIC_BLOCK" || o.type === "EXTRACT_TOOL_GUIDANCE");
		const patchRisk = semanticOps.length > 0 ? "SEMANTIC_REWRITE" : "SAFE";
		const patch = createPatch({ baseBlocks: manifest.blocks, operations: ops, risk: patchRisk, evidence: { via: "prompt-lab-api" } });
		const applied = applyPatch(manifest, patch, { onStale: "return" });
		if (!applied.ok) {
			this.bump("patch_rejected_count");
			return { ok: false, reason: applied.reason ?? "APPLY_FAILED", detail: applied, stale: true };
		}
		if ((applied.skipped ?? []).length > 0) {
			this.bump("patch_rejected_count");
			return { ok: false, reason: "OPS_SKIPPED", skipped: applied.skipped };
		}

		const textOf = (m) => (m?.blocks ?? []).map((b) => b.text).join("\n");
		const child = this.saveVersion({
			content: textOf(applied.manifest),
			manifest: applied.manifest,
			scores: {},
			mode: base.mode ?? "SAFE",
			kind: "patch_apply",
			parentVersionId: base.id,
			provider: base.provider,
			model: base.model,
			sourceType: null,
			title: null,
		});
		this.savePatch(base.id, patch, { childVersionId: child.id, applied: true, why });
		this.bump("patch_apply_count");
		if (patchRisk === "SEMANTIC_REWRITE") this.bump("semantic_patch_count");
		else this.bump(ops.some((o) => o.type === "MOVE_BLOCK") ? "layout_count" : "safe_patch_count");
		return { ok: true, risk: patchRisk, childVersionId: child.id, appliedOps: ops.length, skipped: applied.skipped, detail: child };
	}

	/** Undo = restore the parent snapshot (P6 keeps every state; no forged op-reversal). */
	undoToParent(childVersionId, { why = "undo patch_apply" } = {}) {
		const child = this.versionRow(childVersionId);
		if (!child) return { ok: false, reason: "VERSION_NOT_FOUND" };
		if (!child.parent_version_id) return { ok: false, reason: "NO_PARENT" };
		const parent = this.versionRow(child.parent_version_id);
		const parentManifest = this.manifestOf(parent.id);
		const textOf = (m) => (m?.blocks ?? []).map((b) => b.text).join("\n");
		const restored = this.saveVersion({
			content: textOf(parentManifest),
			manifest: parentManifest,
			scores: {},
			mode: parent.mode ?? null,
			kind: "restore",
			parentVersionId: parent.id,
			provider: parent.provider,
			model: parent.model,
			sourceType: null,
			title: null,
		});
		this.bump("patch_reverse_count");
		return { ok: true, restoredVersionId: restored.id, parentVersionId: parent.id };
	}
}
