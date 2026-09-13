#!/usr/bin/env node
/**
 * G0 session snapshot — upstream SHA, always rules, declared + probed MCP.
 *   node scripts/run-g0-session-snapshot.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");
const OUT = join(AGENT, "g0-session-snapshot-last.json");
const TM = process.env.TOKEN_MIND_ROOT || join(ROOT, "../A-skill/A-github-skill-mcp/token-mind");
const CLI = join(ROOT, ".cursor/contextmind/cli.mjs");

function gitShort(repo) {
	if (!existsSync(repo)) return "unknown";
	const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" });
	return r.status === 0 ? (r.stdout || "").trim() : "unknown";
}

function parseDoctor(out) {
	const always = /PASS\s+always rules budget\s+(\d+)\/(\d+)/i.exec(out);
	return {
		always_pass: /PASS\s+always rules budget/i.test(out),
		always_tokens: always ? Number(always[1]) : null,
		always_budget: always ? Number(always[2]) : 400,
		verdict: (out.match(/Verdict:\s*(\w+)/i) || [])[1] || "UNKNOWN",
		hooks_pass: /PASS\s+hooks installed/i.test(out),
		contextmind_tools: Number((out.match(/mcp server[^|]*\|\s*(\d+) tools/i) || [])[1]) || null,
	};
}

const docR = spawnSync(process.execPath, [CLI, "doctor", ROOT], {
	cwd: ROOT,
	encoding: "utf8",
	timeout: 90_000,
	windowsHide: true,
});
const doctor = parseDoctor(`${docR.stdout || ""}${docR.stderr || ""}`);

let installArtifact = null;
const artifactPath = join(ROOT, ".contextmind/install-artifact.json");
if (existsSync(artifactPath)) {
	try {
		installArtifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	} catch {
		/* ignore */
	}
}

let mcpDeclared = [];
try {
	const mcp = JSON.parse(readFileSync(join(ROOT, ".cursor/mcp.json"), "utf8"));
	mcpDeclared = Object.keys(mcp.mcpServers || {});
} catch {
	/* ignore */
}

let sessionTools = null;
const probeR = spawnSync(process.execPath, [join(ROOT, "scripts/mcp-stdio-probe.mjs")], {
	cwd: ROOT,
	encoding: "utf8",
	timeout: 60_000,
	windowsHide: true,
});
if (probeR.status === 0) {
	try {
		sessionTools = JSON.parse((probeR.stdout || "").trim());
	} catch {
		sessionTools = { parse_error: true };
	}
}

const rec = {
	at: new Date().toISOString(),
	gate_id: "G0",
	consumer_commit: gitShort(ROOT),
	token_mind_commit: gitShort(TM),
	install_artifact: installArtifact
		? {
				source_commit: installArtifact.source_commit,
				contract_hash: installArtifact.contract_hash,
				drift: installArtifact.drift,
			}
		: null,
	doctor,
	mcp_declared: mcpDeclared,
	session_tools_stdio: sessionTools,
	ok:
		doctor.always_pass &&
		Boolean(installArtifact?.source_commit) &&
		sessionTools?.contextmind?.ok === true,
};

mkdirSync(AGENT, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
console.log(`g0 session snapshot: ${rec.ok ? "PASS" : "FAIL"}`);
if (!rec.ok) console.log(JSON.stringify(rec, null, 2));
process.exit(rec.ok ? 0 : 1);
