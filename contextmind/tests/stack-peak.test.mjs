/**
 * Stack router / scorecard / manifest peak-path tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeStack, loadWaiver, formatRoutePreamble } from "../lib/stack-router.mjs";
import { buildAgentManifest, writeAgentManifest } from "../lib/agent-manifest.mjs";
import { stackScorecard, formatScorecard, matchEvalCommand, writeSelfCheckToBundle } from "../lib/stack-scorecard.mjs";
import { Telemetry } from "../lib/telemetry.mjs";

function tmpProject() {
	const root = mkdtempSync(join(tmpdir(), "cm-stack-"));
	mkdirSync(join(root, ".contextmind"), { recursive: true });
	mkdirSync(join(root, ".requirementmind"), { recursive: true });
	mkdirSync(join(root, ".agent", "state"), { recursive: true });
	return root;
}

describe("stack-router", () => {
	it("routes to requirement-mind when gate absent and session exists", () => {
		const root = tmpProject();
		writeFileSync(join(root, ".requirementmind", "session.json"), JSON.stringify({ phase: 3 }));
		writeFileSync(join(root, ".requirementmind", "questions.json"), "[]");
		const r = routeStack(root, { cfg: {} });
		assert.equal(r.first, "requirement-mind");
		rmSync(root, { recursive: true, force: true });
	});

	it("routes to ai-code when task bundle present", () => {
		const root = tmpProject();
		writeFileSync(
			join(root, ".requirementmind", "gate.json"),
			JSON.stringify({ status: "READY_FOR_DEVELOPMENT" }),
		);
		writeFileSync(
			join(root, ".contextmind", "task.active.json"),
			JSON.stringify({
				version: 1,
				intent: { goal: "fix list split" },
				spec: { allow_globs: ["**/*.java"] },
				meta: { source: "handoff" },
			}),
		);
		const r = routeStack(root, { cfg: {} });
		assert.equal(r.first, "ai-code");
		assert.ok(formatRoutePreamble(r).includes("StackRoute"));
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts micro waiver", () => {
		const root = tmpProject();
		writeFileSync(
			join(root, ".contextmind", "waiver.json"),
			JSON.stringify({ reason: "typo", verify: "mvn -q", expires: "2099-01-01T00:00:00Z" }),
		);
		const w = loadWaiver(root);
		assert.equal(w.ok, true);
		const r = routeStack(root, { cfg: {} });
		assert.equal(r.first, "ai-code");
		assert.equal(r.micro, true);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("agent-manifest", () => {
	it("writes .agent/manifest.json", () => {
		const root = tmpProject();
		writeFileSync(
			join(root, ".requirementmind", "gate.json"),
			JSON.stringify({ status: "READY_FOR_DEVELOPMENT" }),
		);
		writeFileSync(
			join(root, ".requirementmind", "decisions.json"),
			JSON.stringify([{ id: "DEC-001", status: "FROZEN" }]),
		);
		const { path, manifest } = writeAgentManifest(root, { cfg: {} });
		assert.ok(path.endsWith("manifest.json"));
		assert.equal(manifest.what.gate_ready, true);
		assert.deepEqual(manifest.what.frozen_dec_ids, ["DEC-001"]);
		const disk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(disk.version, 1);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("stack-scorecard", () => {
	it("aggregates notes into health", () => {
		const root = tmpProject();
		const dbPath = join(root, ".contextmind", "telemetry.db");
		const t = new Telemetry({ dbPath });
		t.record({ surface: "mcp", toolName: "context_orient", note: "orient_ok", success: true });
		t.record({ surface: "mcp", toolName: "context_orient", note: "orient_ok", success: true });
		t.record({ surface: "mcp", toolName: "context_orient", note: "orient_dup", success: false });
		t.record({ surface: "shell", toolName: "Shell", note: "self_check_pass", success: true });
		const sc = stackScorecard(t);
		assert.equal(sc.orient_ok, 2);
		assert.equal(sc.orient_dup, 1);
		assert.ok(sc.orient_hit_rate > 0.6);
		assert.equal(sc.self_check_pass, 1);
		assert.ok(sc.health >= 70);
		assert.ok(formatScorecard(sc).includes("Health"));
		t.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("matchEvalCommand + writeSelfCheckToBundle", () => {
		const root = tmpProject();
		const taskPath = join(root, ".contextmind", "task.active.json");
		writeFileSync(
			taskPath,
			JSON.stringify({
				version: 1,
				intent: { goal: "g" },
				spec: {},
				eval: { commands: ["mvn -pl shejiu-modules/shejiu-product -am test -q"] },
			}),
		);
		const bundle = JSON.parse(readFileSync(taskPath, "utf8"));
		assert.ok(matchEvalCommand(bundle, "mvn -pl shejiu-modules/shejiu-product -am test -q"));
		const r = writeSelfCheckToBundle(root, {}, { exitCode: 0, command: "mvn -pl shejiu-modules/shejiu-product -am test -q" });
		assert.equal(r.updated, true);
		const next = JSON.parse(readFileSync(taskPath, "utf8"));
		assert.equal(next.eval.self_check.exit_code, 0);
		rmSync(root, { recursive: true, force: true });
	});
});
