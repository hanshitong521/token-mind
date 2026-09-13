/**
 * Budget may tune search depth, history, duplicate reads, and non-P0 output.
 * It must not delete P0, hide risk, skip failures, or silently drop evidence.
 */
import { BUDGET_INSUFFICIENT_MESSAGE } from "../evidence/levels.mjs";
import { budgetFor } from "../output-gate.mjs";
import { countTokens } from "../tokens.mjs";

export function assertP0Budget({ level, raw, cfg, surface, failure }) {
	const rawTokens = countTokens(raw ?? "");
	if (level !== "P0") {
		return {
			ok: true,
			budget: budgetFor(cfg, { surface, failure }),
			agentMessage: null,
			preserveAll: false,
		};
	}
	const configured = budgetFor(cfg, { surface, failure: true });
	const insufficient = configured < rawTokens;
	return {
		ok: true,
		budget: Math.max(configured, rawTokens),
		agentMessage: insufficient ? BUDGET_INSUFFICIENT_MESSAGE : null,
		preserveAll: true,
		insufficient,
	};
}
