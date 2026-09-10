/**
 * Prompt IR — the unified intermediate representation Prompt Lab works on.
 *
 * Prompt Lab spec §7 mandates a PromptManifest with PromptBlock[] instead of
 * raw-string hacking, so every analyzer, optimizer, and provider serializer
 * can share one deterministic structure. Block IDs are content hashes, not
 * random UUIDs (spec §9.3), so the same content always resolves to the same
 * identity and prompt versions can be diffed.
 *
 * The tokenizer is deliberately the same heuristic chooser the rest of
 * ContextMind uses (lib/tokens.mjs, "heuristic:chars/4"); every count is
 * tagged `estimated:true` and `method` so nothing masquerades as exact
 * (spec §13, §37).
 */

import { createHash } from "node:crypto";
import { countTokens } from "../tokens.mjs";

export const SCHEMA_VERSION = "1.0";

export const BLOCK_ROLES = Object.freeze([
	"system",
	"developer",
	"user",
	"assistant",
	"tool",
	"context",
]);

export const BLOCK_KINDS = Object.freeze([
	"instruction",
	"rule",
	"example",
	"project_contract",
	"repo_map",
	"wiki",
	"brain_memory",
	"rag",
	"code",
	"diff",
	"tool_schema",
	"tool_result",
	"history",
	"runtime_metadata",
	"user_request",
]);

export const STABILITIES = Object.freeze([
	"STATIC",
	"MOSTLY_STATIC",
	"DYNAMIC",
	"EPHEMERAL",
]);

export const MUTABILITIES = Object.freeze([
	"DO_NOT_TOUCH",
	"SAFE_REORDER",
	"SAFE_COMPACT",
	"SEMANTIC_REWRITE",
	"LOSSY_EXPERIMENTAL",
]);

export const PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

export const TOKENIZER_METHOD = "heuristic:chars/4";

/** sha256 hex (first `len` chars, default full 64). */
export function sha256(text, len) {
	const hex = createHash("sha256").update(String(text ?? "")).digest("hex");
	return len ? hex.slice(0, len) : hex;
}

/**
 * Deterministic block identity: hash of kind + canonical text + provenance
 * path. Same content, same identity, across sessions and providers.
 */
export function blockIdOf({ kind, text, provenance }) {
	const path = provenance?.path ?? provenance?.source ?? "";
	return sha256(`${kind}\u0000${String(text)}\u0000${path}`, 16);
}

/**
 * Create a PromptBlock with derived identity / token count filled in.
 * `hash` is the full sha256 of the raw text (used for exact-duplicate
 * detection and fingerprints).
 */
export function createBlock(input) {
	const kind = BLOCK_KINDS.includes(input.kind) ? input.kind : "instruction";
	const role = BLOCK_ROLES.includes(input.role) ? input.role : "system";
	const text = String(input.text ?? "");
	const block = {
		id: input.id ?? blockIdOf({ kind, text, provenance: input.provenance }),
		role,
		kind,
		text,
		stability: STABILITIES.includes(input.stability) ? input.stability : "STATIC",
		mutability: MUTABILITIES.includes(input.mutability) ? input.mutability : "DO_NOT_TOUCH",
		priority: PRIORITIES.includes(input.priority) ? input.priority : "P1",
		tokenCount: {
			count: countTokens(text),
			method: TOKENIZER_METHOD,
			estimated: true,
		},
		hash: sha256(text),
	};
	if (input.provenance) block.provenance = { ...input.provenance };
	return block;
}

/**
 * Create a PromptManifest. `blocks` are passed through createBlock so every
 * block entering the system is normalized and hash-carrying.
 */
export function createManifest(input = {}) {
	return {
		schemaVersion: SCHEMA_VERSION,
		promptId: input.promptId ?? sha256(String(input.content ?? ""), 12),
		sourceType: input.sourceType ?? "markdown",
		provider: input.provider ?? null,
		model: input.model ?? null,
		projectId: input.projectId ?? null,
		createdAt: input.createdAt ?? Date.now(),
		blocks: (input.blocks ?? []).map((b) => createBlock(b)),
		tools: input.tools ?? [],
		metadata: input.metadata ?? {},
	};
}

/** Sum of block token counts (estimated). */
export function manifestTokenTotal(manifest) {
	return (manifest?.blocks ?? []).reduce((acc, b) => acc + (b.tokenCount?.count ?? 0), 0);
}

/** Full textual representation of a manifest (all blocks joined in order). */
export function manifestToText(manifest) {
	return (manifest?.blocks ?? []).map((b) => b.text).join("\n");
}

/** Deep-clone a manifest (structuredClone on the plain JSON shape). */
export function cloneManifest(manifest) {
	return structuredClone(manifest);
}