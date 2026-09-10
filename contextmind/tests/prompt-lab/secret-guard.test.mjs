/**
 * Secret Guard (spec §38) — round-1 gate #4.
 *
 * The concrete regression: `analyze()` computed a redacted manifest and then
 * returned the ORIGINAL one, so every public result carried the credential in
 * the clear. Anything reachable from `analyze()` must be redacted by default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../lib/prompt-engine/index.mjs";
import { detectSecrets, scanSecrets, redactText, redactManifestBlocks, redactDeep, assertNoSecrets } from "../../lib/prompt-engine/secrets.mjs";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { loadFixtures } from "./_helpers.mjs";

// Credential shapes that must be caught (all values are fake).
const SHAPES = [
	["sk-", "OPENAI_KEY=sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8"],
	["sk-proj-", "OPENAI_KEY=sk-proj-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8e9F0g1H2"],
	["Bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
	["api_key", 'api_key: "AbCdEf0123456789"'],
	["access_token", "access_token: ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
	["refresh_token", "refresh_token: 9Xk2Lm4Qp7Rs8Tu1Vw2X"],
	["cookie", "Cookie: sessionid=8f14e45fceea167a5a36dedd4bea2543"],
	["authorization", 'authorization: Basic YWRtaW46ZXhhbXBsZXBhc3M='],
	["password", "password: Sup3rS3cretValue"],
	["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7xKp2mQ9vL1n\n-----END RSA PRIVATE KEY-----"],
	["database_url", "DATABASE_URL=postgres://admin:ExamplePass123@db.internal.example.com:5432/orders"],
	["aws_access", "AWS_KEY=AKIAIOSFODNN7EXAMPLE"],
	["client_secret", "client_secret: 8f14e45fceea167a5a36dedd4bea2543"],
];

test("every credential shape is detected", () => {
	for (const [label, sample] of SHAPES) {
		const hits = detectSecrets(sample);
		assert.ok(hits.length >= 1, `${label} not detected: ${sample.slice(0, 40)}`);
	}
});

test("no plaintext secret escapes analyze() for any security fixture", () => {
	const security = loadFixtures().filter((f) => f.meta.category === "security");
	assert.ok(security.length >= 4, "not enough security fixtures");
	for (const { meta, content } of security) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const publicResult = JSON.stringify(r);
		for (const secret of meta.secretValues ?? []) {
			assert.ok(!publicResult.includes(secret), `${meta.id}: SECRET LEAKED into the public analyze() result`);
		}
		assert.ok(r.secrets.count >= 1, `${meta.id}: secrets present but not counted`);
		assert.equal(r.redacted, true, `${meta.id}: redaction not applied by default`);
	}
});

test("redaction is ON by default and can be explicitly disabled for a local view", () => {
	const { meta, content } = loadFixtures().find((f) => f.meta.id === "F01-api-keys");
	const secret = meta.secretValues[0];
	const redacted = analyze({ content, sourceType: meta.sourceType, provider: meta.provider });
	assert.ok(!JSON.stringify(redacted).includes(secret), "default result leaked the secret");
	const raw = analyze({ content, sourceType: meta.sourceType, provider: meta.provider, options: { redactSecrets: false } });
	assert.ok(JSON.stringify(raw.manifest).includes(secret), "opt-out did not return the live input");
	assert.equal(raw.redacted, false);
});

test("secret findings never carry the credential itself", () => {
	for (const { meta, content } of loadFixtures().filter((f) => f.meta.category === "security")) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const f of r.findings) {
			const asJson = JSON.stringify(f);
			for (const secret of meta.secretValues ?? []) {
				assert.ok(!asJson.includes(secret), `${meta.id}: finding ${f.ruleId} carries the credential`);
			}
		}
	}
});

test("scanSecrets returns counts and names but never the raw match", () => {
	const summary = scanSecrets("OPENAI_KEY=sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8");
	assert.equal(summary.count, 1);
	assert.ok(Object.keys(summary.byName).length >= 1);
	assert.ok(!JSON.stringify(summary).includes("sk-9Xt2"), "safe summary leaked the value");
});

test("redactText replaces every occurrence, not just the first", () => {
	const src = "a=sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8\nb=sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8";
	const { text } = redactText(src);
	assert.ok(!text.includes("sk-9Xt2"), "second occurrence survived");
	assert.equal((text.match(/\[REDACTED:/g) ?? []).length, 2);
});

test("redactManifestBlocks preserves block ids so findings still resolve", () => {
	const m = parsePrompt("# Rules\n\napi_key: AbCdEf0123456789\n", { sourceType: "markdown" });
	const before = m.blocks.map((b) => b.id);
	const { manifest, hitCount } = redactManifestBlocks(m);
	assert.equal(hitCount, 1);
	assert.deepEqual(manifest.blocks.map((b) => b.id), before, "block ids changed during redaction");
	assert.ok(!JSON.stringify(manifest).includes("AbCdEf0123456789"));
	assert.ok(JSON.stringify(m).includes("AbCdEf0123456789"), "redactManifestBlocks mutated its input");
});

test("redactDeep scrubs secrets out of nested evidence structures", () => {
	const dirty = { title: "x", evidence: [{ text: "key sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8 here" }], nested: { a: ["sk-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8"] } };
	const clean = redactDeep(dirty);
	assert.ok(!JSON.stringify(clean).includes("sk-9Xt2"));
});

test("assertNoSecrets refuses to forward in strict mode", () => {
	const payload = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
	const strict = assertNoSecrets(payload, { strict: true });
	assert.equal(strict.ok, false);
	assert.ok(!JSON.stringify(strict).includes("eyJhbGci"), "refusal message leaked the token");
	assert.equal(assertNoSecrets("nothing sensitive here", { strict: true }).ok, true);
});

test("non-secret prompts are not flagged", () => {
	const clean = [
		"Use constructor injection and run the mapper tests.",
		"包结构按领域划分。",
		"session_id: 7f1c2e90-4a4b-4c8d-9e2f-1a2b3c4d5e6f",
		"request_id: req_9Xk2Lm4Qp7Rs",
	];
	for (const t of clean) {
		assert.equal(scanSecrets(t).count, 0, `false positive secret detection: ${t}`);
	}
});
