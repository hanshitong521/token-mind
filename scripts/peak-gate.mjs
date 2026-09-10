#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gateEnvelope, printGateReport } from "../../shared/scripts/peak-gate-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "contextmind/cli.mjs");

function gitCommit() {
	const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	return r.status === 0 ? (r.stdout || "").trim() : "unknown";
}

const commit = gitCommit();
const gates = [];

gates.push(
	gateEnvelope({
		gate_id: "G0",
		component: "token_mind",
		status: existsSync(join(ROOT, "contextmind/lib/task-bundle.mjs")) ? "PASS" : "FAIL",
		summary: "task-bundle module present",
		commit,
	}),
);

const CONSUMER =
	process.env.SHEJIU_CONSUMER_ROOT ??
	join(ROOT, "..", "..", "shejiuPro");

if (existsSync(CLI) && existsSync(CONSUMER)) {
	const r = spawnSync(process.execPath, [CLI, "doctor", CONSUMER], { cwd: CONSUMER, encoding: "utf8" });
	const pass = /Verdict:\s*PASS/i.test((r.stdout || "") + (r.stderr || ""));
	const warn = /Verdict:\s*WARN/i.test((r.stdout || "") + (r.stderr || ""));
	gates.push(
		gateEnvelope({
			gate_id: "G1",
			component: "token_mind",
			status: pass ? "PASS" : warn ? "PASS_WITH_WAIVER" : "FAIL",
			summary: pass ? "doctor PASS (shejiu consumer)" : warn ? "doctor WARN on consumer (档 A)" : "doctor FAIL on consumer",
			commit,
		}),
	);
} else {
	gates.push(
		gateEnvelope({
			gate_id: "G1",
			component: "token_mind",
			status: "FAIL",
			summary: existsSync(CLI) ? "shejiuPro consumer not found for doctor" : "cli.mjs missing",
			commit,
		}),
	);
}

const consumerCli = existsSync(CONSUMER)
	? join(CONSUMER, ".cursor/contextmind/cli.mjs")
	: null;

function runCli(args) {
	if (!consumerCli) return { status: 1, stdout: "" };
	return spawnSync(process.execPath, [consumerCli, "--dir", CONSUMER, ...args], {
		encoding: "utf8",
		cwd: CONSUMER,
	});
}

if (consumerCli) {
	const tv = runCli(["task", "validate"]);
	gates.push(
		gateEnvelope({
			gate_id: "G2",
			component: "token_mind",
			status: tv.status === 0 ? "PASS" : "FAIL",
			summary: "task validate (TaskBundle v2)",
			commit,
			blocking: true,
		}),
	);
	const sc = runCli(["scorecard", "--json"]);
	gates.push(
		gateEnvelope({
			gate_id: "G3",
			component: "token_mind",
			status: sc.status === 0 ? "PASS" : "FAIL",
			summary: "scorecard --json",
			commit,
			blocking: true,
		}),
	);
	const rep = runCli(["report", "--json"]);
	gates.push(
		gateEnvelope({
			gate_id: "G4",
			component: "token_mind",
			status: rep.status === 0 ? "PASS" : "FAIL",
			summary: "report --json (三列账)",
			commit,
			blocking: true,
		}),
	);
	gates.push(
		gateEnvelope({
			gate_id: "G5",
			component: "token_mind",
			status: existsSync(join(ROOT, "contextmind/sdlc/task-bundle.schema.v2.json")) ? "PASS" : "FAIL",
			summary: "TaskBundle v2 schema shipped",
			commit,
			blocking: true,
		}),
	);
	gates.push(
		gateEnvelope({
			gate_id: "G6",
			component: "token_mind",
			status: existsSync(join(CONSUMER, ".contextmind/cache-ledger.json")) ? "PASS" : "PASS_WITH_WAIVER",
			summary: "cache-ledger snapshot",
			commit,
			blocking: true,
		}),
	);
	gates.push(
		gateEnvelope({
			gate_id: "G7",
			component: "token_mind",
			status: existsSync(join(CONSUMER, ".agent/state/project_state.json")) ? "PASS" : "FAIL",
			summary: "agent state present",
			commit,
			blocking: true,
		}),
	);
	gates.push(
		gateEnvelope({
			gate_id: "G8",
			component: "token_mind",
			status: existsSync(join(CONSUMER, ".contextmind/peak-benchmark.json")) ? "PASS" : "PASS_WITH_WAIVER",
			summary: "peak-benchmark evidence",
			commit,
			blocking: true,
		}),
	);
} else {
	for (let i = 2; i <= 8; i++) {
		gates.push(
			gateEnvelope({
				gate_id: `G${i}`,
				component: "token_mind",
				status: "NOT_REQUIRED",
				summary: `set SHEJIU_CONSUMER_ROOT for G${i}`,
				commit,
				blocking: false,
			}),
		);
	}
}

const report = printGateReport("token_mind", gates);
process.exit(report.rollup === "PASS" ? 0 : 1);
