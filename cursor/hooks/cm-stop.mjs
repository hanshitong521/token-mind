#!/usr/bin/env node
/** stop gate — no cm-lib; only reads gate json when present. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, readHookInput } from "./cm-rpc.mjs";

function projectRootOf(input) {
	return (
		input?.workspace_roots?.[0] ??
		input?.cwd ??
		process.env.CURSOR_PROJECT_DIR ??
		process.cwd()
	);
}

const input = await readHookInput();
const projectRoot = projectRootOf(input);
const statePath = join(projectRoot, "docs", "reports", "current_gate_state.json");

let state;
try {
	state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
	emit({});
	process.exit(0);
}

const blocking = Array.isArray(state?.gates) ? state.gates.filter((g) => g.status === "FAIL") : [];
const external = Array.isArray(state?.gates) ? state.gates.filter((g) => g.status === "BLOCKED_EXTERNAL") : [];
if (external.length > 0 && blocking.length === 0) {
	emit({});
	process.exit(0);
}
if (blocking.length === 0) {
	emit({});
	process.exit(0);
}

const loopCount = Number(input.loop_count ?? 0);
if (loopCount >= 5) {
	emit({});
	process.exit(0);
}

const list = blocking.map((g) => `- ${g.id}: ${g.detail ?? "no detail"}`).join("\n");
emit({
	followup_message:
		`ContextMind completion gate is not satisfied.\n${list}\n` +
		`Read docs/reports/current_gate_state.json, fix the failing gates, rerun the required validation, ` +
		`and do not declare completion until every hard gate passes.`,
});
process.exit(0);
