import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeCacheLedger } from "./cache-ledger.mjs";

export function buildLedgerSnapshot(db, meta = {}) {
	if (!db) return null;
	const summary = summarizeCacheLedger(db);
	if (!summary) return null;
	return {
		schema: "contextmind-cache-ledger/v1",
		generated_at: new Date().toISOString(),
		source: meta.source ?? "unknown",
		...summary,
	};
}

export function writeLedgerSnapshot(projectRoot, db, meta = {}) {
	const doc = buildLedgerSnapshot(db, meta);
	if (!doc) return null;
	const dir = join(projectRoot, ".contextmind");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "cache-ledger.json");
	writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	return path;
}
