/**
 * Stable prefix blocks (spec §15) — fixed order for provider prefix cache friendliness.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadTaskBundle, taskIdFromLoaded } from "../task-bundle.mjs";
import { countTokens, truncateToTokens } from "../tokens.mjs";
import { compressStablePrefix } from "./prefix-compress.mjs";

const STACK_CONTRACT =
	"CTX=contextmind orient1→fetch; WHY=brain 5 tools; WHAT=RequirementMind FROZEN; no raw codegraph MCP.";

export function stablePrefixHash(parts) {
	return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 12);
}

/**
 * @returns {{ text: string, tokens: number, hash: string }}
 */
export function buildStablePrefix(projectRoot, cfg, { maxTokens = 220, trimRules = false } = {}) {
	const stable = [
		"[Stable]",
		"System: ContextMind agent stack",
		`Rules: ${STACK_CONTRACT}`,
		"Tools: context_orient,context_fetch,context_find,context_get,context_impact,context_run",
	];

	const mostly = ["[MostlyStable]"];
	const loaded = loadTaskBundle(projectRoot, cfg);
	if (loaded?.bundle) {
		const id = taskIdFromLoaded(loaded) ?? "task";
		const goal = String(loaded.bundle.intent?.goal ?? "").slice(0, 160);
		mostly.push(`Task(${id}): ${goal}`);
		const seeds = loaded.bundle.spec?.impact?.fqcn_seeds ?? [];
		if (seeds.length) mostly.push(`Seeds: ${seeds.slice(0, 4).join(", ")}`);
	} else {
		mostly.push("Task: (no active TaskBundle)");
	}

	const rulesDir = join(projectRoot, ".cursor", "rules");
	if (!trimRules && existsSync(rulesDir)) {
		try {
			const l0 = join(rulesDir, "shejiu-l0.mdc");
			if (existsSync(l0)) {
				const head = readFileSync(l0, "utf8").split("\n").slice(0, 6).join(" ").slice(0, 200);
				mostly.push(`L0: ${head}`);
			}
		} catch {
			/* skip */
		}
	}

	const body = [...stable, ...mostly, "[Dynamic follows user prompt]"].join("\n");
	const compressed = compressStablePrefix(body, cfg, { maxTokens });
	const text = compressed.text;
	const hash = stablePrefixHash([...stable, ...mostly, cfg?.brain?.project_id ?? ""]);
	return {
		text,
		tokens: countTokens(text),
		hash,
		compression: compressed.method,
	};
}
