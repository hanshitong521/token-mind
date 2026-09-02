#!/usr/bin/env node
/**
 * ContextMind stop gate (spec 38).
 *
 * Reads `docs/reports/current_gate_state.json` when the project has one and asks
 * the agent to continue while hard gates fail. It is deliberately inert without
 * that file: ContextMind's own development is the only thing the gate describes,
 * and it must not turn into a stop-blocker for ordinary work in a project that
 * happens to have the hooks installed.
 *
 * spec 38.1: an external blocker must be able to end the loop. A gate state of
 * BLOCKED_EXTERNAL exits without a follow-up.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ready, runtime } from "./cm-lib.mjs";

if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, noop, projectRootOf, readHookInput } = runtime;

const MAX_LOOPS = 5;

const input = await readHookInput();
const projectRoot = projectRootOf(input);
const statePath = join(projectRoot, "docs", "reports", "current_gate_state.json");

let state;
try {
	state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
	noop();
}

const blocking = Array.isArray(state?.gates)
	? state.gates.filter((g) => g.status === "FAIL")
	: [];
const external = Array.isArray(state?.gates)
	? state.gates.filter((g) => g.status === "BLOCKED_EXTERNAL")
	: [];

if (external.length > 0 && blocking.length === 0) noop();
if (blocking.length === 0) noop();

const loopCount = Number(input.loop_count ?? 0);
if (loopCount >= MAX_LOOPS) noop();

const list = blocking.map((g) => `- ${g.id}: ${g.detail ?? "no detail"}`).join("\n");
emit({
	followup_message:
		`ContextMind completion gate is not satisfied.\n${list}\n` +
		`Read docs/reports/current_gate_state.json, fix the failing gates, rerun the required validation, ` +
		`and do not declare completion until every hard gate passes.`,
});
process.exit(0);
