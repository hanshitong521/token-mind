import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureById } from "./_helpers.mjs";

const NODE = process.execPath;
const SERVER = fileURLToPath(new URL("../../prompt-lab-server.mjs", import.meta.url));
const projectDir = mkdtempSync(join(tmpdir(), "pl-server-"));

const A10 = fixtureById("A10-duplicate-rule-blocks");

function startServer(port = 0) {
	return new Promise((resolve, reject) => {
		const child = spawn(NODE, [SERVER, projectDir, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error(`server start timeout; output:\n${out}`));
			}
		}, 15000);
		child.stdout.on("data", (c) => {
			out += c.toString();
			const m = out.match(/Prompt Lab — http:\/\/127\.0\.0\.1:(\d+)\/prompt-lab/);
			if (m && !settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ child, port: Number(m[1]), out });
			}
		});
		child.on("exit", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error(`server exited early code=${code}\n${out}`));
			}
		});
	});
}

async function post(base, path, body) {
	const r = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, json: await r.json() };
}

const server = await startServer();
const base = `http://127.0.0.1:${server.port}`;
after(async () => {
	server.child.kill();
	await new Promise((r) => server.child.on("exit", r));
	rmSync(projectDir, { recursive: true, force: true });
});

test("server: serves the prompt-lab page over http", async () => {
	const r = await fetch(`${base}/prompt-lab`);
	assert.equal(r.status, 200);
	const html = await r.text();
	assert.match(html, /Prompt Lab/);
	assert.match(html, /优化器 Optimize/);
});

test("server: analyze route returns a persisted version", async () => {
	const { status, json } = await post(base, "/promptLab/analyze", {
		content: A10.content,
		sourceType: "markdown",
		title: "A10",
	});
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.ok(json.version.versionId && json.version.versionNo === 1);
	assert.ok(json.blocks.length >= 2);
	assert.equal(json.findings.some((f) => f.ruleId === "Q04-DUP-EXACT"), true);
});

test("server: optimize + history + patch apply + undo over http", async () => {
	const o = await post(base, "/promptLab/optimize", { content: A10.content, sourceType: "markdown", mode: "B" });
	assert.equal(o.json.ok, true);
	assert.ok(o.json.patchOps.length >= 1);
	assert.equal(o.json.recommendation.status, "SAFE_APPLY");

	const a = await post(base, "/promptLab/analyze", { content: A10.content, sourceType: "markdown" });
	const applied = await post(base, "/promptLab/patch/apply", { versionId: a.json.version.versionId, ops: o.json.patchOps });
	assert.equal(applied.json.ok, true, JSON.stringify(applied.json));
	assert.equal(applied.json.detail.version.kind, "patch_apply");

	const undo = await post(base, "/promptLab/patch/reverse", { versionId: applied.json.childVersionId });
	assert.equal(undo.json.ok, true);
	assert.equal(undo.json.detail.version.kind, "restore");

	const list = await post(base, "/promptLab/history/list", {});
	assert.ok(list.json.total >= 4, `analyze + optimize + patch_apply + restore expected, got ${list.json.total}`);
});

test("server: nav + provider capabilities + 404", async () => {
	const nav = await fetch(`${base}/api/nav`).then((r) => r.json());
	assert.equal(nav.prompt_lab, "/prompt-lab");
	const prov = await fetch(`${base}/promptLab/provider/capabilities`).then((r) => r.json());
	assert.ok(prov.providers.length >= 6);
	const nf = await fetch(`${base}/nope`);
	assert.equal(nf.status, 404);
});

test("server: evaluate runs the builtin evaluator and persists a run", async () => {
	const { status, json } = await post(base, "/promptLab/evaluate", { content: A10.content, sourceType: "markdown" });
	assert.equal(status, 200);
	assert.equal(json.ok, true, JSON.stringify(json).slice(0, 400));
	assert.equal(json.eval_provider, "builtin");
	assert.equal(json.status, "PASS");
	assert.ok(json.runId, "eval run row persisted");
	assert.ok(json.summary.totalCases >= 4, `builtin dataset + custom input expected, got ${json.summary.totalCases}`);
	assert.equal(json.summary.allPassed, true);
	// spec §30: negative controls in the builtin dataset must ALL be detected
	assert.ok(json.summary.negativeTotal > 0);
	assert.equal(json.summary.negativeDetected, json.summary.negativeTotal);
	// spec §29: LLM-only metrics are reported as not_measured, never fabricated
	assert.equal(json.metrics.task_success_rate, "not_measured");
	assert.equal(json.metrics.hallucination_rate, "not_measured");
	assert.equal(json.metrics.latency_ms, "not_measured");
	assert.equal(json.metrics.cost, "not_measured");
});
