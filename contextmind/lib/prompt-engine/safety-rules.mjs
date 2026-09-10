/**
 * Safety Rules — the guard rails that keep optimization reversible & honest
 * (spec §15, §17.6, §38).
 *
 * SAFE-001  DO_NOT_TOUCH content flagged (user request / acceptance / sql /
 *          code / diff / secrets must not be auto-compressed)
 * SAFE-002  secret material detected in prompt (redact before persistence)
 *
 * These findings are mostly informational; they exist so the optimizer can
 * prove it left P0 content alone and the UI can warn the user.
 */

import { createFinding } from "./rule-engine.mjs";

/**
 * SAFE-001 — inspect every block and report which §15 DO_NOT_TOUCH classes it
 * contains, so the optimizer can prove it left P0 content alone.
 *
 * SAFE-002 (secret material) is NOT produced here. It is produced once, by
 * index.secretFindingsFor(), which runs the real Secret Guard before
 * redaction. Emitting it from two places double-counted the risk score.
 */
const DO_NOT_TOUCH_PATTERNS = [
	{ re: /(accept(?:ance)? criteria|验收标准|验收|done when|definition of done)/i, label: "acceptance criteria" },
	{ re: /\bSQL\b[\s\S]{0,240}?(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)/i, label: "sql" },
	{ re: /(current user request|user request|user prompt)\s*:/i, label: "user request block" },
	{ re: /(?:^|\n)@@[ \-\d,+]+@@|^[-+]{3}\s+\S+\s/m, label: "code diff" },
];

/**
 * Inspect every block and report the §15 DO_NOT_TOUCH classes it contains
 * (SAFE-001). Secret material (SAFE-002) is reported by index.secretFindingsFor.
 */
export function inspectSafety(manifest) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		const text = block.text;
		if (!text) continue;

		const touchLabels = [];
		for (const { re, label } of DO_NOT_TOUCH_PATTERNS) {
			if (re.test(text)) touchLabels.push(label);
		}
		if (touchLabels.length === 0) continue;

		findings.push(
			createFinding({
				ruleId: "SAFE-001",
				title: "DO_NOT_TOUCH content present",
				severity: "INFO",
				category: "RISK",
				blockIds: [block.id],
				explanation:
					`This block contains ${touchLabels.join(", ")}; the safe optimizer must ` +
					`never rewrite or compress it (spec §15).`,
				evidence: touchLabels.map((label) => ({ label })),
				requiresEval: false,
				autoApplicable: false,
			}),
		);
	}
	return findings;
}

export const safetyRules = [
	{
		id: "SAFE-CHECK",
		title: "Safety inspection",
		category: "RISK",
		severity: "INFO",
		run: inspectSafety,
	},
];