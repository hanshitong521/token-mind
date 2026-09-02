/**
 * S8 ledger invariants (G-S8-01..12 from the S8 freeze).
 *
 * These are not coverage tests — each one asserts an accounting rule that a
 * pretty dashboard number could silently violate: no fake savings, no double
 * counting, no rewriting history, text/JSON parity, empty ledger survives.
 * The fixtures go through the real record() path (and the real six-tool
 * handlers where a rule is about a tool), not hand-built rows.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Telemetry, formatSummary } from "../lib/telemetry.mjs";
import { openRuntime } from "../lib/runtime.mjs";
import { callTool } from "../lib/mcp-tools.mjs";
import { loadConfigFrom } from "../lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_USER = join(tmpdir(), "contextmind-no-user-config.json");
const CLI = join(HERE, "..", "cli.mjs");

let dir;
let t; // dedicated Telemetry on its own db
let rt; // runtime pointed at the same db

before(() => {
	dir = mkdtempSync(join(tmpdir(), "cm-s8-"));
	const cfg = loadConfigFrom(NO_USER, dir);
	t = new Telemetry({ dbPath: join(dir, "telemetry.db") });
	rt = openRuntime(dir);
	// Share the telemetry db with the runtime so tool events land in the same
	// ledger the invariants are asserted over.
	rt.telemetry.close();
	rt.telemetry = t;
});

after(() => {
	rt.close();
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* Windows WAL file handle timing; temp dir is reclaimed by the OS */
	}
});

function rows() {
	return t.db.prepare("SELECT * FROM events ORDER BY id").all();
}

describe("G-S8-01/02/03: arithmetic", () => {
	it("every recorded event satisfies raw >= emitted >= 0 and avoided = raw - emitted", () => {
		// A compression event, an assembly event, a fetch event, a read block.
		t.record({ surface: "shell", toolName: "context_run", rawTokens: 1000, emittedTokens: 200 });
		t.record({ surface: "read", preventedReadTokens: 5000, readBlocked: 1 });
		rt.handles.put("x".repeat(400), { sourceType: "test" });
		const h = rt.handles.list(1)[0].handle_id;
		await0(callTool("context_fetch", { handle: h }, rt));
		t.record({ surface: "mcp", toolName: "context_orient", rawTokens: 6250, emittedTokens: 482 });
		for (const r of rows()) {
			assert.ok(r.raw_tokens >= r.emitted_tokens, `raw ${r.raw_tokens} < emitted ${r.emitted_tokens}`);
			assert.ok(r.emitted_tokens >= 0);
			if (r.prevented_read_tokens === 0) {
				assert.equal(r.tool_emitted_savings, Math.max(0, r.raw_tokens - r.emitted_tokens));
			}
		}
	});

	it("G-S8-03: ledger totals equal the per-event sums", () => {
		const sum = t.summary();
		const rs = rows();
		assert.equal(sum.totals.raw_tokens, rs.reduce((a, r) => a + r.raw_tokens, 0));
		assert.equal(sum.totals.emitted_tokens, rs.reduce((a, r) => a + r.emitted_tokens, 0));
		assert.equal(sum.ledger.avoided, rs.reduce((a, r) => a + r.tool_emitted_savings, 0));
		assert.equal(sum.ledger.prevented_read, rs.reduce((a, r) => a + r.prevented_read_tokens, 0));
	});
});

describe("G-S8-04: reduction_ratio", () => {
	it("ratio = avoided / raw, and raw=0 yields null (never NaN or Infinity)", () => {
		const empty = new Telemetry({ dbPath: join(dir, "empty.db") });
		const sum = empty.summary();
		assert.equal(sum.ledger.raw, 0);
		assert.equal(sum.ledger.ratio, null);
		assert.ok(Number.isFinite(sum.ledger.avoided));
		const text = formatSummary(sum);
		assert.match(text, /REDUCTION  n\/a/);
		empty.close();

		const s2 = t.summary();
		assert.ok(Math.abs(s2.ledger.ratio - s2.ledger.avoided / s2.ledger.raw) < 1e-12);
	});
});

describe("G-S8-05: prevented_read never mixes into avoided", () => {
	it("a read-block event records savings 0 and prevented tokens in its own column", () => {
		t.record({ surface: "read", preventedReadTokens: 20000, readBlocked: 1, success: false });
		const r = rows().at(-1);
		assert.equal(r.tool_emitted_savings, 0);
		assert.equal(r.prevented_read_tokens, 20000);
		const sum = t.summary();
		// The structural form of G-S8-05: avoided never exceeds raw, because
		// prevented-read tokens never enter the savings column.
		assert.ok(sum.ledger.avoided <= sum.ledger.raw);
	});
});

describe("G-S8-06: handle fetch does not rewrite history", () => {
	it("fetch records raw = emitted = what was returned; the original event is untouched", async () => {
		const before = rows().filter((r) => r.handle_created === 1).length;
		const big = "EVIDENCE\n".repeat(500); // ~4000 tok raw
		const h = rt.handles.put(big, { sourceType: "test" });
		t.record({ surface: "mcp", toolName: "context_orient", rawTokens: 4000, emittedTokens: 480, handleId: h, handleCreated: 1 });
		const orig = rows().at(-1);
		await0(callTool("context_fetch", { handle: h, selector: { start: 1, end: 5 } }, rt));
		const fetched = rows().at(-1);
		assert.equal(fetched.tool_name, "context_fetch");
		assert.equal(fetched.raw_tokens, fetched.emitted_tokens);
		assert.equal(fetched.tool_emitted_savings, 0);
		// The original compression event is byte-identical history now.
		const origAfter = rows().find((r) => r.id === orig.id);
		assert.deepEqual({ ...origAfter }, { ...orig });
		assert.equal(rows().filter((r) => r.handle_created === 1).length, before + 1);
	});
});

describe("G-S8-07: failure events enter the ledger", () => {
	it("a governed failure is recorded with success=0 and its evidence tokens", async () => {
		await0(callTool("context_run", { command: "node -e \"process.exit(7)\"" }, rt));
		const r = rows().at(-1);
		assert.equal(r.tool_name, "context_run");
		assert.equal(r.success, 0);
		assert.ok(r.raw_tokens >= 0 && r.emitted_tokens >= 0);
		const sum = t.summary();
		const failures = sum.bySuccess.find((s) => s.key === "0");
		assert.ok(failures, "failure aggregate must exist");
	});
});

describe("G-S8-08: reporting is read-only", () => {
	it("two reports change nothing in telemetry", () => {
		const n = rows().length;
		t.summary();
		t.summary();
		assert.equal(rows().length, n);
	});
});

describe("G-S8-09/10: text/JSON parity and the empty ledger", () => {
	it("text and --json agree on every headline number (real CLI subprocess)", () => {
		const run = (args) =>
			spawnSync(process.execPath, [CLI, "report", "--dir", dir, ...args], { encoding: "utf8", timeout: 60_000 });
		const json = JSON.parse(run(["--json"]).stdout);
		const text = run([]).stdout;
		assert.match(text, new RegExp(`RAW\\s+${json.totals.raw_tokens.toLocaleString("en-US")} tokens`));
		assert.match(text, new RegExp(`EMITTED\\s+${json.totals.emitted_tokens.toLocaleString("en-US")} tokens`));
		assert.match(text, new RegExp(`AVOIDED\\s+${json.ledger.avoided.toLocaleString("en-US")} tokens`));
		const ratio =
			json.ledger.ratio === null ? "n/a" : `${(json.ledger.ratio * 100).toFixed(2)}%`;
		assert.match(text, new RegExp(`REDUCTION\\s+${ratio.replace("%", "%")}`));
		assert.match(text, new RegExp(`PREVENTED READ\\s+${json.ledger.prevented_read.toLocaleString("en-US")}`));
	});

	it("an empty db reports zeros and exits 0", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "cm-s8-empty-"));
		const res = spawnSync(process.execPath, [CLI, "report", "--dir", emptyDir], { encoding: "utf8", timeout: 60_000 });
		assert.equal(res.status, 0);
		assert.match(res.stdout, /RAW\s+0 tokens/);
		assert.match(res.stdout, /REDUCTION\s+n\/a/);
		rmSync(emptyDir, { recursive: true, force: true });
	});
});

describe("G-S8-11/12: aggregation consistency", () => {
	it("cross-session totals equal per-session sums", () => {
		const d2 = mkdtempSync(join(tmpdir(), "cm-s8-multi-"));
		const tm = new Telemetry({ dbPath: join(d2, "t.db") });
		tm.record({ surface: "shell", sessionId: "s1", rawTokens: 100, emittedTokens: 40 });
		tm.record({ surface: "shell", sessionId: "s2", rawTokens: 300, emittedTokens: 60 });
		tm.record({ surface: "mcp", sessionId: "s1", rawTokens: 50, emittedTokens: 50 });
		const all = tm.summary();
		const s1 = tm.summary({ sessionId: "s1" });
		const s2 = tm.summary({ sessionId: "s2" });
		assert.equal(all.totals.raw_tokens, s1.totals.raw_tokens + s2.totals.raw_tokens);
		assert.equal(all.ledger.avoided, s1.ledger.avoided + s2.ledger.avoided);
		tm.close();
		rmSync(d2, { recursive: true, force: true });
	});

	it("per-tool sums reconcile with the total ledger", () => {
		const sum = t.summary();
		const byToolRaw = sum.byTool.reduce((a, r) => a + r.raw_tokens, 0);
		const byToolAvoided = sum.byTool.reduce((a, r) => a + r.tool_emitted_savings, 0);
		assert.equal(byToolRaw, sum.totals.raw_tokens);
		assert.equal(byToolAvoided, sum.ledger.avoided);
		// Same check on the adapter and content_type dimensions.
		assert.equal(sum.byAdapter.reduce((a, r) => a + r.raw_tokens, 0), sum.totals.raw_tokens);
		assert.equal(sum.byContentType.reduce((a, r) => a + r.raw_tokens, 0), sum.totals.raw_tokens);
		assert.equal(sum.bySuccess.reduce((a, r) => a + r.raw_tokens, 0), sum.totals.raw_tokens);
	});
});

function await0(promise) {
	return promise.then((r) => r, (e) => assert.fail(e));
}
