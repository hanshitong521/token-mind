import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ensureCacheSchema } from "../lib/db/schema.mjs";
import { buildLedgerSnapshot, writeLedgerSnapshot } from "../lib/cache-engine/write-ledger-snapshot.mjs";

describe("write-ledger-snapshot", () => {
	it("writes v1 snapshot under .contextmind", () => {
		const root = mkdtempSync(join(tmpdir(), "cm-ledger-"));
		const db = new DatabaseSync(":memory:");
		ensureCacheSchema(db);
		db.prepare(
			`INSERT INTO cache_events(ts, layer, event, saved_tokens) VALUES (?,?,?,?)`,
		).run(1, "L2", "hit", 50);
		db.prepare(`INSERT INTO prompt_pipeline_events(ts, project_id, session_id, stage, prompt_hash, saved_tokens, detail)
		 VALUES (1,'p','s','exact_hit','abc',10,'{}')`).run();
		const path = writeLedgerSnapshot(root, db, { source: "test" });
		assert.ok(path);
		assert.ok(existsSync(join(root, ".contextmind", "cache-ledger.json")));
		const doc = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(doc.schema, "contextmind-cache-ledger/v1");
		assert.equal(doc.source, "test");
		assert.equal(doc.hits_by_layer.L2, 1);
		assert.ok(doc.pipeline.hit_rate_pct != null);
		db.close();
	});

	it("buildLedgerSnapshot returns null without db", () => {
		assert.equal(buildLedgerSnapshot(null), null);
	});
});
