/**
 * Install / uninstall / doctor (spec 28, G7).
 *
 * Runs against a throwaway project in the OS temp dir. The properties that
 * matter are the ones that are easy to get wrong and painful to discover in a
 * real project: idempotent install, uninstall that removes only what it added,
 * and hooks.json that keeps whatever the user already had.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_ENTRIES, hookEntryPresent, isOwnHook } from "../lib/install-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "cli.mjs");

let project;
let fakeHome;

/**
 * Every CLI call gets an isolated home. Without it a user-scope host whose config
 * directory exists on the developer's box (WorkBuddy ships `~/.workbuddy/connectors/`)
 * is selected by `selectInstallHosts` and the install writes the real
 * `~/.workbuddy/connectors/<uid>/mcp.json` — a test that edits the machine it runs on.
 * `CONTEXTMIND_INSTALL_HOME` is the installer's own escape hatch for exactly this; both
 * the write path (`userHome()`) and the host scan must honour it.
 */
function cli(args, env = {}) {
	const res = spawnSync(process.execPath, [CLI, ...args], {
		env: { ...process.env, CONTEXTMIND_INSTALL_HOME: fakeHome, ...env },
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
	});
	if (res.error) throw res.error;
	return { status: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

before(() => {
	project = mkdtempSync(join(tmpdir(), "cm-cli-"));
	fakeHome = mkdtempSync(join(tmpdir(), "cm-home-"));
	mkdirSync(join(project, ".cursor"), { recursive: true });
	writeFileSync(
		join(project, ".cursor", "mcp.json"),
		JSON.stringify({ mcpServers: { codegraph: { command: "node" } } }),
	);
});

describe("install", () => {
	it("installs hooks, library and assets and exits 0", () => {
		const r = cli(["install", project]);
		assert.equal(r.status, 0, r.err);
		assert.ok(existsSync(join(project, ".cursor", "contextmind", "lib", "runtime.mjs")));
		for (const file of ["cm-rpc.mjs", "cm-pre-tool.mjs", "cm-post-tool.mjs", "cm-session-start.mjs"]) {
			assert.ok(existsSync(join(project, ".cursor", "hooks", file)), `missing ${file}`);
		}
		assert.ok(existsSync(join(project, ".cursor", "contextmind-manifest.json")));
		// Rules are opt-in: an existing always rule must not be silently doubled.
		assert.ok(!existsSync(join(project, ".cursor", "rules", "contextmind.mdc")));
	});

	it("writes a hooks.json that Cursor can consume", () => {
		const hooks = readJson(join(project, ".cursor", "hooks.json"));
		assert.equal(hooks.version, 1);
		assert.ok(Array.isArray(hooks.hooks.preToolUse));
		assert.ok(hooks.hooks.preToolUse.length >= 1);
		assert.ok(hooks.hooks.sessionStart?.length === 1);
		// MCP matchers must carry the MCP: prefix or they never match.
		const mcp = hooks.hooks.postToolUse ?? [];
		assert.ok(mcp.some((h) => String(h.matcher ?? "").startsWith("MCP:")));
		// Two preToolUse entries (Shell/Task/MCP + raw CodeGraph fail-closed).
		const pre = (hooks.hooks.preToolUse ?? []).filter((h) =>
			HOOK_ENTRIES.filter((e) => e.event === "preToolUse").some((e) => hookEntryPresent(h, e.hook)),
		);
		assert.equal(pre.length, 2, `expected 2 preToolUse entries, got ${JSON.stringify(pre)}`);
		assert.ok(pre.some((h) => String(h.matcher ?? "").includes("Shell")));
		assert.ok(pre.some((h) => String(h.matcher ?? "").includes("codegraph")));
	});

	it("is idempotent — a second install does not duplicate entries", () => {
		const before = readJson(join(project, ".cursor", "hooks.json"));
		const r = cli(["install", project]);
		assert.equal(r.status, 0, r.err);
		const after = readJson(join(project, ".cursor", "hooks.json"));
		assert.deepEqual(after.hooks, before.hooks);
	});

	it("keeps the user's own hook entries", () => {
		const hooksPath = join(project, ".cursor", "hooks.json");
		const hooks = readJson(hooksPath);
		hooks.hooks.afterFileEdit = [{ command: ".cursor/hooks/mine.sh" }];
		writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
		cli(["install", project]);
		const after = readJson(hooksPath);
		assert.ok(after.hooks.afterFileEdit.some((h) => h.command === ".cursor/hooks/mine.sh"));
	});

	it("retires predecessor gate hooks instead of governing twice", () => {
		const hooksPath = join(project, ".cursor", "hooks.json");
		const hooks = readJson(hooksPath);
		hooks.hooks.postToolUse = [
			{ command: ".cursor/hooks/gate-mcp-output.cmd", matcher: "mysql_query", failClosed: false },
		];
		writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
		cli(["install", project]);
		const after = readJson(hooksPath);
		assert.ok(
			!after.hooks.postToolUse.some((h) => String(h.command).includes("gate-mcp-output")),
			"legacy hook must not survive alongside its replacement",
		);
		assert.ok(after.hooks.postToolUse.some((h) => hookEntryPresent(h, "cm-post-tool")));
	});

	it("does not copy rules unless asked, so an existing always rule is not doubled", () => {
		const r = cli(["install", project]);
		assert.equal(r.status, 0, r.err);
		assert.match(r.out, /not copied/);
		const withRules = cli(["install", project, "--rules"]);
		assert.equal(withRules.status, 0, withRules.err);
		assert.ok(existsSync(join(project, ".cursor", "rules", "contextmind.mdc")));
	});
});

describe("doctor", () => {
	it("reports PASS-majority on a freshly installed project and never crashes", () => {
		const r = cli(["doctor", project]);
		assert.equal(r.status, 0, r.err);
		assert.match(r.out, /Verdict:/);
		assert.match(r.out, /hooks installed/);
		assert.match(r.out, /handle store/);
		assert.match(r.out, /telemetry db/);
	});

	it("flags an over-budget always rule as FAIL", () => {
		const rulesDir = join(project, ".cursor", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(join(rulesDir, "bloat.mdc"), `---\nalwaysApply: true\n---\n${"x ".repeat(2000)}`);
		const r = cli(["doctor", project]);
		assert.equal(r.status, 1, `expected FAIL exit: ${r.out}`);
		assert.match(r.out, /always rules budget/);
	});
});

describe("uninstall", () => {
	it("removes what it added and leaves the user's hooks alone", () => {
		const r = cli(["uninstall", project]);
		assert.equal(r.status, 0, r.err);
		assert.ok(!existsSync(join(project, ".cursor", "contextmind")));
		assert.ok(!existsSync(join(project, ".cursor", "contextmind-manifest.json")));
		const hooks = readJson(join(project, ".cursor", "hooks.json"));
		assert.ok(hooks.hooks.afterFileEdit, "user's hook entry must survive");
		for (const list of Object.values(hooks.hooks)) {
			for (const h of list) assert.ok(!isOwnHook(h), `own hook must be removed: ${JSON.stringify(h)}`);
		}
	});

	it("is a no-op failure when nothing was installed", () => {
		const r = cli(["uninstall", project]);
		assert.equal(r.status, 1);
	});
});

describe("cli surface", () => {
	it("rejects an unknown command", () => {
		const r = cli(["nope"]);
		assert.equal(r.status, 1);
		assert.match(r.err, /unknown command/);
	});

	it("prints help without a project", () => {
		const r = cli(["help"]);
		assert.equal(r.status, 0);
		assert.match(r.out, /doctor/);
	});

	it("config --validate passes with no config files present", () => {
		const r = cli(["config", "--validate", project]);
		assert.equal(r.status, 0, r.err);
		assert.match(r.out, /OK/);
	});
});
