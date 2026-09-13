/**
 * Evidence Layer in front of the existing Output Gate.
 * P0 never compressed. ABSTAIN/preservation in output-gate.mjs stays the belt.
 */
import { classify } from "../classify.mjs";
import { runOutputGate } from "../output-gate.mjs";
import { countTokens } from "../tokens.mjs";
import { assertP0Budget } from "../policy/budget.mjs";
import { evidenceLevel } from "./levels.mjs";

export function runEvidenceGate(args) {
	const raw = args.raw ?? "";
	const cls = classify(raw, args.cmd);
	const level = evidenceLevel(cls, args);
	const failure =
		typeof args.exitCode === "number" && Number.isFinite(args.exitCode)
			? args.exitCode !== 0
			: cls.failure;
	const budget = assertP0Budget({
		level,
		raw,
		cfg: args.cfg,
		surface: args.surface,
		failure,
	});

	if (level === "P0") {
		const rawTokens = countTokens(raw);
		return {
			text: raw,
			rawTokens,
			emittedTokens: rawTokens,
			contentType: cls.type,
			failure,
			budget: budget.budget,
			abstained: false,
			dedupHit: false,
			handleId: null,
			method: "P0_preserve",
			latencyMs: 0,
			engineLatencyMs: 0,
			note: budget.insufficient ? "p0_budget_insufficient" : "p0_never_compress",
			evidenceLevel: level,
			agent_message: budget.agentMessage,
		};
	}

	const gated = runOutputGate(args);
	return { ...gated, evidenceLevel: level, agent_message: null };
}
