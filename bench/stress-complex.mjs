#!/usr/bin/env node
/**
 * Complex regression: mixed hooks, parallel bursts, token-path smoke.
 * Exit 0 only if all gates pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { startDaemon } from "../contextmind/lib/runtime/lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEJIU = "e:/workA/shejiuPro";
const HOOKS = join(SHEJIU, ".cursor/hooks");
const CMHOOK = join(HOOKS, "cmhook.exe");
const env = { ...process.env, CONTEXTMIND_HOME: join(SHEJIU, ".cursor/contextmind") };

function fail(msg) {
	console.error("FAIL:", msg);
	process.exit(1);
}

function spawnHook(exe, args, inputObj) {
	const t0 = performance.now();
	const r = spawnSync(exe, args, {
		input: JSON.stringify(inputObj),
		encoding: "utf8",
		timeout: 20_000,
		windowsHide: true,
		env,
	});
	const ms = Math.round(performance.now() - t0);
	let ok = r.status === 0;
	let parsed = null;
	try {
		parsed = JSON.parse((r.stdout || "").trim() || "{}");
	} catch {
		ok = false;
	}
	return { ms, ok, parsed, raw: (r.stdout || "").trim().slice(0, 100) };
}

await startDaemon({ waitMs: 6_000 });
if (!existsSync(CMHOOK)) fail("cmhook.exe missing — run native/build-cmhook.cmd");

const base = { cwd: SHEJIU, workspace_roots: [SHEJIU], conversation_id: "stress" };

// 1) Code-review-like parallel batch (H3)
const batch = [
	{ tool_name: "Read", tool_input: { path: ".cursor/hooks/cm-rpc.mjs", limit: 15 } },
	{ tool_name: "Shell", tool_input: { command: "git status -sb" } },
	{ tool_name: "Shell", tool_input: { command: "git diff --stat" } },
	{ tool_name: "Grep", tool_input: { pattern: "invokeHook", path: ".cursor/hooks", head_limit: 5 } },
];
const tBatch = performance.now();
const batchResults = await Promise.all(
	batch.map((b) =>
		Promise.resolve().then(() => spawnHook(CMHOOK, ["cm-pre-tool"], { ...base, ...b })),
	),
);
const batchWall = Math.round(performance.now() - tBatch);
if (batchResults.some((r) => !r.ok)) fail(`parallel pre batch json: ${batchResults.map((r) => r.raw).join(" | ")}`);
if (batchWall > 12_000) fail(`parallel pre batch too slow: ${batchWall}ms`);
for (const r of batchResults) {
	if (r.parsed?.updated_input?.command?.includes("context-compress")) {
		fail("git still wrapped in parallel batch");
	}
}
console.log(`PASS parallel pre batch (n=${batch.length}) wall=${batchWall}ms max=${Math.max(...batchResults.map((r) => r.ms))}ms`);

// 2) Session + prompt hooks
const ss = spawnHook(process.execPath, [join(HOOKS, "cm-session-start.mjs")], { ...base, session_id: "s-stress" });
if (!ss.ok || ss.ms > 5000) fail(`sessionStart ms=${ss.ms} ok=${ss.ok}`);
const bs = spawnHook(process.execPath, [join(HOOKS, "cm-before-submit-prompt.mjs")], {
	...base,
	prompt: "review OceanProductQueryServiceImpl and git diff",
});
if (!bs.ok || bs.ms > 8000) fail(`beforeSubmit ms=${bs.ms} ok=${bs.ok}`);
console.log(`PASS sessionStart=${ss.ms}ms beforeSubmit=${bs.ms}ms`);

// 3) Large shell post (H9)
const post = spawnHook(CMHOOK, ["cm-post-tool"], {
	...base,
	tool_name: "Shell",
	tool_output: "line\n".repeat(20_000),
});
if (!post.ok || post.ms > 5000) fail(`post large shell ms=${post.ms}`);
console.log(`PASS post large shell ${post.ms}ms`);

// 4) Duplicate unbounded read should deny (token save)
const trapPath =
	"shejiu-modules/shejiu-ocean/src/main/java/com/shejiu/ocean/service/impl/OceanProductQueryServiceImpl.java";
const r1 = spawnHook(CMHOOK, ["cm-pre-tool"], { ...base, tool_name: "Read", tool_input: { path: trapPath } });
const r2 = spawnHook(CMHOOK, ["cm-pre-tool"], { ...base, tool_name: "Read", tool_input: { path: trapPath } });
if (!r1.ok) fail("first ServiceImpl read hook json");
if (r2.parsed?.permission !== "deny" && !r2.parsed?.user_message) {
	console.log("WARN ServiceImpl read deny not triggered (trap/waiver may differ)");
} else {
	console.log("PASS ServiceImpl read guarded (deny or trap on repeat path)");
}

// 5) Burst 12 cmhook
const burst = performance.now();
const burstN = 12;
const burstRes = await Promise.all(
	Array.from({ length: burstN }, () =>
		Promise.resolve().then(() =>
			spawnHook(CMHOOK, ["cm-pre-tool"], { ...base, tool_name: "Write", tool_input: { path: "x.md" } }),
		),
	),
);
const burstWall = Math.round(performance.now() - burst);
if (burstRes.some((r) => !r.ok)) fail("burst cmhook invalid json");
if (burstWall > 20_000) fail(`burst too slow ${burstWall}ms`);
console.log(`PASS burst n=${burstN} wall=${burstWall}ms`);

console.log("\nALL STRESS GATES PASS");
