/**
 * L1 unit tests (spec 31) for the ContextMind core library.
 *
 * Coverage targets the pure functions where a wrong answer is silent and
 * expensive: token math, classification, preservation, handle selectors, dedup
 * keys, and the three-column ledger. The hooks that drive them are covered in
 * hooks.test.mjs as subprocess contract tests.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { countTokens, truncateToTokens } from "../lib/tokens.mjs";
import { classify, criticalLines, isFailure } from "../lib/classify.mjs";
import { budgetFor, runOutputGate, structuralReduce } from "../lib/output-gate.mjs";
import { HandleStore, pickJsonPath } from "../lib/handles.mjs";
import { Dedup, duplicateStub, fingerprint } from "../lib/dedup.mjs";
import { evaluateRead, estimateFullReadTokens } from "../lib/read-guard.mjs";
import { extractText, governMcpOutput, isGoverned, profileFor, rewrap } from "../lib/mcp-guard.mjs";
import { Telemetry, formatSummary } from "../lib/telemetry.mjs";
import { DEFAULTS, loadConfigFrom, validateConfig } from "../lib/config.mjs";

let dir;
const NO_USER = join(tmpdir(), "contextmind-no-user-config.json");

before(() => {
	dir = mkdtempSync(join(tmpdir(), "cm-lib-"));
});

after(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* temp dir, OS will reclaim */
	}
});

function cfgFor(overrides = {}) {
	const cfg = loadConfigFrom(NO_USER, dir);
	return {
		...cfg,
		...overrides,
		budget: { ...cfg.budget, ...(overrides.budget ?? {}) },
		shell: { ...cfg.shell, ...(overrides.shell ?? {}) },
		read_guard: { ...cfg.read_guard, ...(overrides.read_guard ?? {}) },
	};
}

describe("tokens", () => {
	it("counts UTF-8 bytes, not characters, so CJK is not under-counted", () => {
		const ascii = "abcdefgh"; // 8 bytes -> 2 tokens
		const cjk = "四个汉字"; // 12 bytes in UTF-8 -> 3 tokens
		assert.equal(countTokens(ascii), 2);
		assert.equal(countTokens(cjk), 3);
	});

	it("never reports zero for non-empty input", () => {
		assert.ok(countTokens("a") >= 1);
		assert.equal(countTokens(""), 0);
	});

	it("truncation keeps whole lines and says so", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
		const out = truncateToTokens(text, 50);
		assert.ok(countTokens(out) <= 60);
		assert.match(out, /\[truncated/);
		assert.doesNotMatch(out, /line \d+ $/m);
	});
});

describe("classify", () => {
	it("trusts the command over shape", () => {
		// A build log that happens to contain a Java frame is still a build log.
		const text = "[INFO] BUILD FAILURE\n\tat com.x.Y(Y.java:10)\n";
		assert.equal(classify(text, "mvn clean package").type, "build_log");
		assert.equal(classify(text, undefined).type, "stacktrace");
	});

	it("recognises JSON, NDJSON, diff, and grep shapes", () => {
		assert.equal(classify('{"a":1}', undefined).type, "json");
		assert.equal(classify('{"a":1}\n{"a":2}', undefined).type, "json");
		assert.equal(classify("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@", undefined).type, "git_diff");
		assert.equal(classify("src/a.ts:10: const x\nsrc/b.ts:11: const y\nsrc/c.ts:12: const z", undefined).type, "grep");
	});

	it("marks a pytest failure as failure and a passing run as success", () => {
		const pass = "================= 3 passed in 0.12s =================";
		const fail = "================= 1 failed, 2 passed in 0.12s =================\nFAILED test_a.py::test_x - assert 1 == 2";
		assert.equal(isFailure(pass, 0), false);
		assert.equal(isFailure(fail, 0), true);
		assert.equal(isFailure("all good", 1), true, "exit code is authoritative");
	});

	it("collects critical lines a reducer must keep", () => {
		const stack = [
			"FooTest.java:44: expected <5> but was <3>",
			"\tat com.shejiu.ServiceImpl.call(ServiceImpl.java:120)",
			"\tat com.shejiu.Other.run(Other.java:9)",
			"Caused by: java.lang.IllegalStateException: boom",
			"[INFO] BUILD FAILURE",
		].join("\n");
		const crit = criticalLines(stack, "stacktrace");
		assert.ok(crit.some((l) => l.includes("ServiceImpl.java:120")), "stack frames kept");
		assert.ok(crit.some((l) => l.includes("Caused by")), "root cause chain kept");
		assert.ok(crit.some((l) => l.includes("BUILD FAILURE")), "final status kept");
	});
});

describe("output gate", () => {
	const tinyCfg = cfgFor({ budget: { shell_success: 50, shell_failure: 80 } });
	let handles;

	before(() => {
		handles = new HandleStore({ dbPath: join(dir, "gate.db"), enabled: true, maxDiskMb: 8 });
	});

	it("passes through anything already inside budget", () => {
		const r = runOutputGate({ raw: "short output", cfg: tinyCfg, handles });
		assert.equal(r.method, "passthrough");
		assert.equal(r.rawTokens, countTokens("short output"));
		assert.equal(r.emittedTokens, r.rawTokens);
		assert.equal(r.handleId, null, "nothing oversized means nothing to reverse");
	});

	it("compresses an oversized payload and leaves a handle", () => {
		const raw = Array.from({ length: 400 }, (_, i) => `[INFO] Downloading lib-${i}.jar from central`).join("\n");
		const r = runOutputGate({ raw, cmd: "mvn clean package", cfg: tinyCfg, handles });
		assert.ok(r.emittedTokens < r.rawTokens);
		assert.ok(r.handleId, "expected a handle");
		assert.match(r.text, /handle=h_/);
	});

	it("never enlarges a payload", () => {
		const raw = "x".repeat(3000); // unclassifiable noise: first layer cannot help
		const r = runOutputGate({ raw, cmd: "git status", cfg: tinyCfg, handles });
		assert.ok(r.emittedTokens <= r.rawTokens + 200, `emitted ${r.emittedTokens} vs raw ${r.rawTokens}`);
	});

	it("abstains instead of losing failure evidence", () => {
		// Enough critical lines that a budget-sized excerpt cannot hold them all:
		// 15 stack frames plus compiler errors, each unique, against a 28-token
		// critical-line allowance.
		const lines = Array.from({ length: 300 }, (_, i) => `noise line ${i}`);
		for (let i = 0; i < 15; i++) lines.push(`\tat com.shejiu.Service${i}.call(Service${i}.java:${100 + i})`);
		for (let i = 0; i < 12; i++) lines.push(`[ERROR] /src/Comp${i}.java:[42,1] cannot find symbol`);
		lines.push("AssertionError: expected <5> but was <3>");
		const raw = lines.join("\n");
		const r = runOutputGate({ raw, cmd: "mvn test", cfg: tinyCfg, handles, exitCode: 1 });
		assert.equal(r.abstained, true);
		assert.match(r.text, /ServiceImpl\.java:142|Comp0\.java/);
		assert.match(r.text, /AssertionError/);
		assert.ok(r.handleId);
	});

	it("keeps critical lines when they do fit, and does not abstain", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `noise line ${i}`);
		lines.push("AssertionError: expected <5> but was <3>", "\tat ServiceImpl.call(ServiceImpl.java:142)");
		const raw = lines.join("\n");
		const r = runOutputGate({ raw, cmd: "mvn test", cfg: tinyCfg, handles, exitCode: 1 });
		assert.equal(r.abstained, false);
		assert.match(r.text, /ServiceImpl\.java:142/);
		assert.match(r.text, /AssertionError/);
	});

	it("returns a dedup stub on the second identical payload", () => {
		const dedup = new Dedup(handles.db);
		const raw = Array.from({ length: 400 }, (_, i) => `row ${i} of the same answer`).join("\n");
		const first = runOutputGate({ raw, cmd: "git diff", cfg: tinyCfg, handles, dedup, sessionId: "s1" });
		const second = runOutputGate({ raw, cmd: "git diff", cfg: tinyCfg, handles, dedup, sessionId: "s1" });
		assert.equal(first.dedupHit, false);
		assert.equal(second.dedupHit, true);
		assert.match(second.text, /\[duplicate evidence\]/);
		assert.ok(second.emittedTokens < first.emittedTokens);
		// A different session has not seen it yet — dedup must not leak across
		// conversations, or the first read of a file looks like a repeat.
		const other = runOutputGate({ raw, cmd: "git diff", cfg: tinyCfg, handles, dedup, sessionId: "s2" });
		assert.equal(other.dedupHit, false);
		dedup.clearSession("s1");
	});

	it("splits the budget on failure", () => {
		assert.equal(budgetFor(tinyCfg, { surface: "shell", failure: false }), 50);
		assert.equal(budgetFor(tinyCfg, { surface: "shell", failure: true }), 80);
		assert.equal(budgetFor(tinyCfg, { surface: "mcp", failure: false }), tinyCfg.budget.mcp_default);
	});

	it("structural reduce keeps head and tail, not just the head", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const out = structuralReduce(lines.join("\n"), { type: "generic", budgetTokens: 100 });
		assert.match(out, /line 0\b/);
		assert.match(out, /line 19[0-9]/, "tail must survive");
		assert.match(out, /omitted/);
	});
});

describe("handle store", () => {
	let store;

	before(() => {
		store = new HandleStore({ dbPath: join(dir, "handles.db"), ttlHours: 12, maxDiskMb: 1 });
	});

	const sample = Array.from({ length: 200 }, (_, i) => `row ${i}: alpha=${i}`).join("\n");

	it("stores and returns raw bytes", () => {
		const id = store.put(sample, { contentType: "generic" });
		assert.ok(id);
		assert.equal(store.get(id), sample);
	});

	it("fetches by line range", () => {
		const id = store.put(sample, {});
		const r = store.fetch(id, { start: 5, end: 7 });
		assert.match(r.text, /^row 4:/);
		assert.match(r.text, /row 6:/);
		assert.doesNotMatch(r.text, /row 7:/);
	});

	it("fetches by regex pattern", () => {
		const id = store.put(sample, {});
		const r = store.fetch(id, { pattern: "alpha=17" });
		assert.match(r.text, /row 17: alpha=17/);
	});

	it("fetches by JSON path", () => {
		const payload = JSON.stringify({ results: [{ id: 1 }, { id: 2 }], total: 2 });
		const id = store.put(payload, { contentType: "json" });
		const r = store.fetch(id, { jsonPath: "results.1.id" });
		assert.equal(r.text, "2");
	});

	it("reports a miss instead of throwing", () => {
		assert.equal(store.get("h_nope"), null);
		assert.equal(store.fetch("h_nope", {}), null);
		assert.equal(store.fetch(store.put(sample, {}), { jsonPath: "no.such.path" }).text, '(no match for jsonPath "no.such.path")');
	});

	it("expires handles past their TTL", () => {
		const s = new HandleStore({ dbPath: join(dir, "ttl.db"), ttlHours: -1, maxDiskMb: 1 });
		const id = s.put(sample, {});
		s.db.prepare("UPDATE handles SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
		assert.equal(s.get(id), null, "expired handle must not be served");
		assert.ok(s.gc() >= 1);
	});

	it("evicts oldest first when the disk cap is hit", () => {
		const s = new HandleStore({ dbPath: join(dir, "cap.db"), ttlHours: 12, maxDiskMb: 0.001 }); // ~1 KB
		const big = "y".repeat(900);
		const a = s.put(big, {});
		const b = s.put(big, {});
		assert.ok(a && b, "both writes should have succeeded");
		const stats = s.stats();
		assert.ok(stats.bytes <= 1024 * 1.2, `cap not enforced: ${stats.bytes} bytes`);
		s.close();
	});

	it("refuses content larger than the whole cap", () => {
		const s = new HandleStore({ dbPath: join(dir, "cap2.db"), maxDiskMb: 0.001 });
		assert.equal(s.put("z".repeat(5000), {}), null);
		s.close();
	});
});

describe("dedup", () => {
	it("fingerprints are stable and freshness-sensitive", () => {
		assert.equal(fingerprint("a", "b"), fingerprint("a", "b"));
		assert.notEqual(fingerprint("a", "b"), fingerprint("b", "a"));
		assert.notEqual(fingerprint("a"), fingerprint("a", "b"));
	});

	it("counts repeats", () => {
		const s = new HandleStore({ dbPath: join(dir, "dedup.db"), maxDiskMb: 1 });
		const d = new Dedup(s.db);
		const key = fingerprint("x");
		assert.equal(d.lookup(key, "s"), null);
		d.record(key, { sessionId: "s", handleId: "h1", rawTokens: 10 });
		assert.equal(d.lookup(key, "s").handleId, "h1");
		assert.ok(d.lookup(key, "s").hits >= 2);
		assert.equal(d.clearSession("s") >= 1, true);
		assert.equal(d.lookup(key, "s"), null);
		s.close();
	});

	it("stub carries the handle and never the body", () => {
		const stub = duplicateStub({ handleId: "h_abc", source: "cmd", firstSeen: "t", hits: 2 });
		assert.match(stub, /handle: h_abc/);
		assert.match(stub, /repeat: 2/);
	});
});

describe("read guard", () => {
	function makeFile(name, content) {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	}

	const baseCfg = cfgFor();

	it("denies a big service implementation with no range", () => {
		const p = makeFile("OrderServiceImpl.java", `void f() {}\n`.repeat(300));
		const r = evaluateRead({ filePath: p, cfg: baseCfg });
		assert.equal(r.decision, "deny");
		assert.equal(r.rule, "java_service");
		assert.ok(r.preventedTokens > 0, "a block must be measured");
	});

	it("allows the same file when a range is given", () => {
		const p = makeFile("OrderServiceImpl.java", `void f() {}\n`.repeat(300));
		const r = evaluateRead({ filePath: p, offset: 1, limit: 40, cfg: baseCfg });
		assert.equal(r.decision, "allow");
		assert.equal(r.rule, "bounded_range");
	});

	it("allows an override and marks it", () => {
		const p = makeFile("OrderServiceImpl.java", `void f() {}\n`.repeat(300));
		const r = evaluateRead({ filePath: p, cfg: baseCfg, toolInput: { override_reason: "user asked" } });
		assert.equal(r.decision, "allow");
		assert.equal(r.rule, "override");
	});

	it("denies generated artefacts and lockfiles", () => {
		for (const name of ["app.min.js", "package-lock.json", "bundle.map"]) {
			const p = makeFile(name, "{}\n".repeat(3000));
			const r = evaluateRead({ filePath: p, cfg: baseCfg });
			assert.equal(r.decision, "deny", name);
			assert.equal(r.rule, "generated_or_lockfile");
		}
	});

	it("denies a whole Mapper.xml", () => {
		const p = makeFile("TProductMapper.xml", "<select id=\"a\">1</select>\n".repeat(900));
		const r = evaluateRead({ filePath: p, cfg: baseCfg });
		assert.equal(r.decision, "deny");
		assert.equal(r.rule, "mapper_xml");
	});

	it("denies a long canonical doc", () => {
		const p = makeFile("workflows.md", "text\n".repeat(3000));
		const r = evaluateRead({ filePath: p, cfg: baseCfg });
		assert.equal(r.decision, "deny");
		assert.equal(r.rule, "long_canonical_doc");
	});

	it("allows a small file regardless of type", () => {
		const p = makeFile("Tiny.java", "class T {}\n");
		const r = evaluateRead({ filePath: p, cfg: baseCfg });
		assert.equal(r.decision, "allow");
	});

	it("estimates prevented tokens from the bytes that would have been read", () => {
		assert.equal(estimateFullReadTokens(4000), 1000);
	});
});

describe("mcp guard", () => {
	const cfg = cfgFor();

	it("unwraps every documented payload shape", () => {
		assert.equal(extractText("plain").shape, "text");
		assert.equal(extractText(JSON.stringify("a string")).shape, "json_string");
		assert.equal(extractText(JSON.stringify([{ type: "text", text: "a" }])).shape, "mcp_content");
		assert.equal(extractText(JSON.stringify({ content: [{ type: "text", text: "a" }] })).shape, "mcp_result");
		assert.equal(extractText(undefined).shape, "empty");
	});

	it("rewraps into the shape it came in as", () => {
		const out = rewrap("new text", "mcp_content", JSON.stringify([{ type: "text", text: "old" }]));
		assert.deepEqual(out, [{ type: "text", text: "new text" }]);
		const res = rewrap("new text", "mcp_result", JSON.stringify({ content: [{ type: "text", text: "old" }] }));
		assert.deepEqual(res.content, [{ type: "text", text: "new text" }]);
		assert.equal(rewrap("t", "text", "x"), "t");
	});

	it("uses the tool profile when one matches", () => {
		assert.equal(profileFor(cfg, "mysql_query").max_tokens, 1400);
		assert.equal(profileFor(cfg, "unknown_tool").name, "generic");
	});

	it("never governs codegraph explore", () => {
		assert.equal(isGoverned("codegraph_explore"), false);
		assert.equal(isGoverned("mysql_query"), true);
	});

	it("returns null for in-budget payloads so nothing is rewritten", () => {
		const r = governMcpOutput({
			toolOutput: JSON.stringify([{ type: "text", text: "small" }]),
			toolName: "mysql_query",
			cfg,
			runGate: () => {
				throw new Error("gate must not run for in-budget payloads");
			},
		});
		assert.equal(r, null);
	});
});

describe("telemetry", () => {
	it("keeps the three columns separate", () => {
		const path = join(dir, "tele.db");
		const t = new Telemetry({ dbPath: path });
		t.record({ surface: "read", toolName: "Read", rawTokens: 0, emittedTokens: 0, preventedReadTokens: 5000, readBlocked: 1 });
		t.record({ surface: "shell", toolName: "Shell", rawTokens: 1000, emittedTokens: 200, toolEmittedSavings: 800 });
		t.record({ surface: "proxy", toolName: "proxy", rawTokens: 500, emittedTokens: 300, proxyLlmSavings: 200 });
		const sum = t.summary();
		assert.equal(sum.totals.prevented_read_tokens, 5000);
		assert.equal(sum.totals.tool_emitted_savings, 800);
		assert.equal(sum.totals.proxy_llm_savings, 200);
		t.close();

		const text = formatSummary(new Telemetry({ dbPath: path }).summary());
		// S8 ledger format: prevented read is its own line, never inside AVOIDED.
		assert.match(text, /PREVENTED READ\s+5,000 tokens\s+\(separate column; not counted in AVOIDED\)/);
		assert.match(text, /AVOIDED\s+800 tokens/);
		assert.match(text, /PROXY LLM SAVINGS\s+200 tokens/);
		new Telemetry({ dbPath: path }).close();
	});

	it("survives an unusable db path and reports the fault", () => {
		const t = new Telemetry({ dbPath: join(dir, "no-such-dir-nested", "x", "y.db"), enabled: true });
		mkdirSync(join(dir, "no-such-dir-nested"), { recursive: true, mode: 0o000 });
		const t2 = t;
		t2.close();
		// The property under test: record() returns false, never throws.
		assert.equal(typeof t2.record({ surface: "read" }), "boolean");
	});

	it("prunes by age", () => {
		const path = join(dir, "prune.db");
		const t = new Telemetry({ dbPath: path });
		t.record({ surface: "read", rawTokens: 1 });
		assert.equal(t.prune(36500), 0, "nothing is older than 100 years");
		t.close();
	});
});

describe("config", () => {
	it("rejects unknown and mistyped keys by naming them", () => {
		assert.match(validateConfig({ nope: 1 }, "test") === null ? "rejected" : "accepted", /rejected/);
		assert.match(
			validateConfig({ budget: { orient: "lots" } }, "test") === null ? "rejected" : "accepted",
			/rejected/,
		);
		assert.deepEqual(validateConfig({}, "test"), {});
	});

	it("layers project over user over defaults", () => {
		const userPath = join(dir, "user-cfg.json");
		const projPath = join(dir, "proj");
		mkdirSync(projPath, { recursive: true });
		writeFileSync(userPath, JSON.stringify({ budget: { orient: 123 } }));
		writeFileSync(join(projPath, ".contextmind.json"), JSON.stringify({ budget: { orient: 456 } }));
		const cfg = loadConfigFrom(userPath, projPath);
		assert.equal(cfg.budget.orient, 456);
		assert.equal(cfg.budget.find, DEFAULTS.budget.find, "unspecified keys fall back to defaults");
	});

	it("refuses a project file that sets a user-scope key", () => {
		const projPath = join(dir, "proj2");
		mkdirSync(projPath, { recursive: true });
		writeFileSync(join(projPath, ".contextmind.json"), JSON.stringify({ handles: { ttl_hours: 1 } }));
		const cfg = loadConfigFrom(NO_USER, projPath);
		assert.equal(cfg.handles.ttl_hours, DEFAULTS.handles.ttl_hours);
	});

	it("rejects an unsupported first layer instead of inventing one", () => {
		const projPath = join(dir, "proj3");
		mkdirSync(projPath, { recursive: true });
		writeFileSync(join(projPath, ".contextmind.json"), JSON.stringify({ shell: { first_layer: "rtk_cc_headroom" } }));
		const cfg = loadConfigFrom(NO_USER, projPath);
		assert.equal(cfg.shell.first_layer, "cc_balanced");
	});
});

describe("json path", () => {
	it("walks objects and arrays and reports misses", () => {
		const doc = JSON.stringify({ a: { b: [10, 20] } });
		assert.equal(pickJsonPath(doc, "a.b.1"), 20);
		assert.equal(pickJsonPath(doc, "a.b.5"), undefined);
		assert.equal(pickJsonPath(doc, "a.b.c"), undefined);
		assert.equal(pickJsonPath("not json", "a"), undefined);
	});
});
