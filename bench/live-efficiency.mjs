/**
 * Live efficiency: shejiuPro ContextMind after adapter-cache + host gates.
 * Measures what the model would have paid (emitted chars/4) and wall time.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "E:/workA/shejiuPro";
const SERVER = join(PROJECT, ".cursor/contextmind/mcp-server.mjs");
const PRE = join(PROJECT, ".cursor/hooks/cm-pre-tool.mjs");

function tokens(s) {
	const n = Buffer.byteLength(String(s ?? ""), "utf8");
	return n === 0 ? 0 : Math.max(1, Math.floor(n / 4));
}

function rpcServer() {
	const p = spawn(process.execPath, [SERVER], {
		env: { ...process.env, CONTEXTMIND_PROJECT_DIR: PROJECT },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buf = "";
	const pending = new Map();
	let nextId = 1;
	p.stdout.on("data", (d) => {
		buf += d.toString();
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let f;
			try {
				f = JSON.parse(line);
			} catch {
				continue;
			}
			if (f.id && pending.has(f.id)) {
				pending.get(f.id)(f);
				pending.delete(f.id);
			}
		}
	});
	const call = (name, args) =>
		new Promise((res, rej) => {
			const id = nextId++;
			const t = setTimeout(() => rej(new Error(`timeout ${name}`)), 120_000);
			pending.set(id, (f) => {
				clearTimeout(t);
				res(f);
			});
			p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
		});
	return { p, call };
}

function hook(payload) {
	const r = spawnSync(process.execPath, [PRE], {
		input: JSON.stringify(payload),
		env: { ...process.env, CURSOR_PROJECT_DIR: PROJECT, CONTEXTMIND_PROJECT_DIR: PROJECT },
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	let json = {};
	try {
		json = JSON.parse((r.stdout || "").trim() || "{}");
	} catch {
		json = { parseError: r.stdout };
	}
	return { status: r.status, json, ms: r.runtime };
}

function textOf(frame) {
	return frame?.result?.content?.[0]?.text ?? frame?.error?.message ?? "";
}

const { p, call } = rpcServer();
await new Promise((r) => setTimeout(r, 400));

const rows = [];
async function timed(label, fn) {
	const t0 = performance.now();
	const out = await fn();
	const ms = Math.round(performance.now() - t0);
	const text = typeof out === "string" ? out : textOf(out);
	const tok = tokens(text);
	const stub = /duplicate evidence|adapter_cache|skipped CodeGraph/i.test(text);
	const handle = (text.match(/handle[=:]?\s*(h_[a-z0-9]+)/i) || [])[1] || "";
	rows.push({ label, ms, tok, stub, handle, head: text.replace(/\s+/g, " ").slice(0, 120) });
	return { text, ms, tok, handle, frame: out };
}

const q = "TBuyinOrderServiceImpl";
const first = await timed("orient#1 (cold CodeGraph)", () => call("context_orient", { query: q }));
const second = await timed("orient#2 (adapter cache)", () => call("context_orient", { query: q }));
const third = await timed("orient#3 (adapter cache)", () => call("context_orient", { query: q }));

const h = first.handle || second.handle;
if (h) {
	await timed("fetch default (80-line cap)", () => call("context_fetch", { handle: h }));
	await timed("fetch pattern (narrow)", () => call("context_fetch", { handle: h, selector: { pattern: "class TBuyin", flags: "" } }));
	const fullTry = await timed("fetch full=true (should deny)", () => call("context_fetch", { handle: h, full: true }));
	if (fullTry.text && /DENIED|blocked/i.test(fullTry.text)) {
		rows[rows.length - 1].stub = true;
		rows[rows.length - 1].note = "denied as expected";
	}
}

const tinyDir = join(tmpdir(), "cm-live-read");
mkdirSync(tinyDir, { recursive: true });
const tiny = join(PROJECT, ".contextmind", "_live_once.java");
writeFileSync(tiny, "class LiveOnce { int x; }\n");
const readPayload = (n) => ({
	tool_name: "Read",
	tool_input: { path: tiny },
	conversation_id: "live-eff-1",
	cwd: PROJECT,
	workspace_roots: [PROJECT],
});
const r1 = hook(readPayload(1));
rows.push({
	label: "Read#1 small file",
	ms: 0,
	tok: 0,
	stub: r1.json.permission === "deny",
	handle: r1.json.permission,
	head: (r1.json.agent_message || r1.json.permission || "").slice(0, 80),
});
const r2 = hook(readPayload(2));
rows.push({
	label: "Read#2 same path (should deny)",
	ms: 0,
	tok: 0,
	stub: r2.json.permission === "deny",
	handle: r2.json.permission,
	head: (r2.json.agent_message || r2.json.permission || "").slice(0, 80),
});

const cg = hook({
	tool_name: "codegraph_explore",
	tool_input: { query: q },
	conversation_id: "live-eff-1",
	cwd: PROJECT,
	workspace_roots: [PROJECT],
});
rows.push({
	label: "raw codegraph_explore (should deny)",
	ms: 0,
	tok: 0,
	stub: cg.json.permission === "deny",
	handle: cg.json.permission,
	head: (cg.json.agent_message || cg.json.permission || "").slice(0, 80),
});

p.kill();

console.log("\n=== live efficiency (shejiuPro) ===\n");
console.log(
	["label".padEnd(34), "ms".padStart(6), "tok".padStart(6), "cache/deny", "note"].join("  "),
);
for (const r of rows) {
	console.log(
		[r.label.padEnd(34), String(r.ms).padStart(6), String(r.tok).padStart(6), String(r.stub).padStart(10), r.handle || r.head].join("  "),
	);
}

const cold = rows.find((r) => r.label.startsWith("orient#1"));
const hot = rows.find((r) => r.label.startsWith("orient#2"));
const full = rows.find((r) => r.label.includes("full=true"));
const cap = rows.find((r) => r.label.includes("80-line"));
if (cold && hot && cold.tok > 0) {
	const tokSave = Math.max(0, cold.tok - hot.tok);
	const msSave = Math.max(0, cold.ms - hot.ms);
	console.log("\n--- maximize ---");
	console.log(`repeat orient: ${cold.tok} → ${hot.tok} tok  (${Math.round((tokSave / cold.tok) * 100)}% less in the window)`);
	console.log(`repeat orient: ${cold.ms} → ${hot.ms} ms`);
	if (full && cap) {
		if (full.stub || full.tok < 50) {
			console.log(`fetch full=true: blocked (${full.tok} tok in window); use line selector instead of full dump.`);
		} else if (full.tok > 0) {
			console.log(`fetch cap vs full: ${cap.tok} vs ${full.tok} tok  (${Math.round((1 - cap.tok / full.tok) * 100)}% less if you do NOT pass full=true)`);
		}
	}
	console.log("max effect: 1× orient + fetch selector/pattern; never raw codegraph; never full=true; never second unbounded Read.");
}
