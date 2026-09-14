/**
 * Hook-entry generation, driven by the host registry.
 *
 * The property that matters here is that no host name is compiled into the plan: the events a
 * host answers to, which of them may run async, which carry a matcher, the entry shape and the
 * host stamp all come from hosts.json. So the centre of this file is the third-host case — a
 * profile that exists only in a temp registry and is emitted correctly anyway. The cursor/qoder
 * assertions are the byte contract the registry was extracted from; a change to one of them is a
 * change to what two real installs read, so they are asserted literally.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN = resolve(HERE, "..", "lib", "install-plan.mjs");
const HOSTS = resolve(HERE, "..", "lib", "hosts.mjs");
const REGISTRY = resolve(HERE, "..", "hosts.json");
const ROOT = "C:\\Users\\dev\\proj";

/** A nested-shape host with three events of its own, its own async set, matcher set and env. */
const TESTHOST = {
	id: "testhost",
	label: "Testhost",
	verified: true,
	capabilities: { hooks: true, mcp: false, failClosed: false, outputRewrite: false },
	hooks: {
		file: { scope: "project", path: ".testhost/settings.json", keyPath: "hooks", entryShape: "claude-nested", rootFields: {} },
		eventNames: { preToolUse: "PRE_TOOL", sessionStart: "ON_START", stop: "ON_STOP" },
		asyncEvents: ["ON_START", "ON_STOP"],
		matcherEvents: ["PRE_TOOL"],
		toolMatcher: "^(bash|run_shell)$",
		env: { CONTEXTMIND_HOST: "testhost", TESTHOST_CHANNEL: "beta" },
	},
	mcp: null,
};

/** A flat-shape host that does honour failClosed, needs no env, and puts its matcher on PascalCase tool events. */
const TESTHOST_FLAT = {
	id: "testhost-flat",
	label: "Testhost Flat",
	verified: true,
	capabilities: { hooks: true, mcp: false, failClosed: true, outputRewrite: false },
	hooks: {
		file: { scope: "project", path: ".testhostflat/hooks.json", keyPath: "hooks", entryShape: "flat", rootFields: { version: 1 } },
		eventNames: "identity",
		asyncEvents: [],
		matcherEvents: ["preToolUse"],
		toolMatcher: "^(bash)$",
		env: {},
	},
	mcp: null,
};

// hosts.json is read once, at import — the override has to be in place before the first import.
const tmp = mkdtempSync(join(tmpdir(), "cm-hosts-"));
const registryFile = join(tmp, "hosts.json");
const real = JSON.parse(readFileSync(REGISTRY, "utf8"));
writeFileSync(
	registryFile,
	JSON.stringify({ ...real, hosts: [...real.hosts, TESTHOST, TESTHOST_FLAT] }, null, 2),
);
process.env.CONTEXTMIND_HOSTS_FILE = registryFile;

const registryFns = await import(pathToFileURL(HOSTS).href);
const { hostIds, profileFor, resolveConfigFile } = registryFns;
const {
	HOOK_ENTRIES,
	HOOK_SCRIPT_DIR,
	commandFor,
	dedupeEntriesForHost,
	hookEntryFor,
	hookEntryPresent,
	isOwnHook,
	isOwnHookEntry,
} = await import(pathToFileURL(PLAN).href);

after(() => rmSync(tmp, { recursive: true, force: true }));

const rows = (id) => dedupeEntriesForHost(profileFor(id), HOOK_ENTRIES);
const entryFor = (id, row, extra = {}) =>
	hookEntryFor(profileFor(id), { ...row, projectRoot: ROOT, ...extra });
const byEvent = (id) => Object.fromEntries(rows(id).map((r) => [r.event, entryFor(id, r)]));

/** One row as a nested-shape host's file holds it. */
const NESTED = {
	async: true,
	hooks: [
		{
			type: "command",
			command: "cmd.exe",
			args: ["/d", "/c", `${ROOT}\\.cursor\\hooks\\cm-stop.cmd`],
			name: "contextmind-cm-stop",
		},
	],
};

describe("plan rows per host", () => {
	it("collapses to one row per (event, hook) for a host with no failClosed field", () => {
		// 8 planned rows → 6: the two preToolUse and two postToolUse rows differ only by matcher
		// and failClosed, which this host cannot carry. Two rows would be two hook processes per
		// tool call deciding the same thing.
		assert.deepEqual(rows("qoder"), [
			{ event: "PreToolUse", hook: "cm-pre-tool" },
			{ event: "PostToolUse", hook: "cm-post-tool" },
			{ event: "SessionStart", hook: "cm-session-start" },
			{ event: "SessionEnd", hook: "cm-session-end" },
			{ event: "UserPromptSubmit", hook: "cm-before-submit-prompt" },
			{ event: "Stop", hook: "cm-stop" },
		]);
	});

	it("keeps the fail-closed CodeGraph row apart on a host that carries failClosed", () => {
		const pre = rows("cursor").filter((r) => r.event === "preToolUse");
		assert.equal(pre.length, 2);
		assert.deepEqual(
			pre.map((r) => r.failClosed),
			[false, true],
		);
		assert.match(pre[1].matcher, /codegraph/);
	});

	it("drops the events a host has no name for instead of writing an event it will never fire", () => {
		const kept = rows("testhost").map((r) => r.event);
		assert.deepEqual(kept, ["PRE_TOOL", "ON_START", "ON_STOP"]);
	});

	it("produces nothing for a host with no hook surface, and for no profile at all", () => {
		assert.deepEqual(dedupeEntriesForHost(profileFor("codebuddy"), HOOK_ENTRIES), []);
		assert.deepEqual(dedupeEntriesForHost(null, HOOK_ENTRIES), []);
		assert.deepEqual(dedupeEntriesForHost(profileFor("qoder"), []), []);
	});
});

describe("qoder entries (verified contract)", () => {
	it("writes Claude Code's nested shape at absolute paths in the shared script dir", () => {
		assert.deepEqual(byEvent("qoder").SessionStart, {
			async: true,
			hooks: [
				{
					type: "command",
					command: "cmd.exe",
					args: ["/d", "/c", `${ROOT}\\${HOOK_SCRIPT_DIR.replace(/\//g, "\\")}\\cm-session-start.cmd`],
					name: "contextmind-cm-session-start",
					timeout: 5,
					env: { CONTEXTMIND_HOST: "qoder" },
				},
			],
		});
	});

	it("keeps PostToolUse synchronous, because async drops the output replacement", () => {
		// The registry says which events may fire-and-forget; PostToolUse is not one of them —
		// async there would silently disable governance that swaps the tool result.
		assert.equal(byEvent("qoder").PostToolUse.async, false);
		assert.equal(byEvent("qoder").PreToolUse.async, false);
		assert.equal(byEvent("qoder").UserPromptSubmit.async, false);
		assert.equal(byEvent("qoder").Stop.async, true);
	});

	it("takes the matcher from the profile, not from a constant in the plan", () => {
		const matcher = profileFor("qoder").hooks.toolMatcher;
		assert.ok(matcher.includes("mcp__.*"), "the host hands the hook the resolved mcp__<server>__<tool> name");
		assert.equal(byEvent("qoder").PreToolUse.matcher, matcher);
		assert.equal(byEvent("qoder").PostToolUse.matcher, matcher);
		assert.ok(!("matcher" in byEvent("qoder").Stop), "a non-tool event must not spawn a hook per tool");
	});

	it("accepts the hook dir override without leaving the shared directory by default", () => {
		const row = rows("qoder").find((r) => r.event === "Stop");
		const alt = hookEntryFor(profileFor("qoder"), {
			hook: row.hook,
			event: row.event,
			projectRoot: ROOT,
			hookDir: "cm-hooks",
		});
		assert.match(alt.hooks[0].args[2], /^C:\\Users\\dev\\proj\\cm-hooks\\cm-stop\.cmd$/);
	});
});

describe("cursor entries (verified contract)", () => {
	it("writes the flat row the shared launchers already speak", () => {
		const list = dedupeEntriesForHost(profileFor("cursor"), HOOK_ENTRIES).filter(
			(r) => r.event === "preToolUse",
		);
		assert.deepEqual(list.map((r) => entryFor("cursor", r)), [
			{
				command: ".cursor/hooks/cm-pre-tool.cmd",
				matcher: list[0].matcher,
				failClosed: false,
			},
			{
				command: ".cursor/hooks/cm-pre-tool.cmd",
				matcher: list[1].matcher,
				failClosed: true,
			},
		]);
	});

	it("carries the same commands as commandFor, node client and native client alike", () => {
		const row = rows("cursor").find((r) => r.event === "sessionStart");
		assert.deepEqual(entryFor("cursor", row, { platform: "win32" }), {
			command: ".cursor/hooks/cm-session-start.cmd",
			failClosed: false,
		});
		assert.deepEqual(entryFor("cursor", row, { platform: "win32", native: true }), {
			command: ".cursor/hooks/cmhook.exe",
			args: ["cm-session-start"],
			failClosed: false,
		});
		const linux = entryFor("cursor", row, { platform: "linux" });
		assert.deepEqual(
			{ command: linux.command, args: linux.args },
			commandFor(row.hook, "linux"),
			"the node fallback stays commandFor's own shape",
		);
	});

	it("stamps no env key, because a host that needs no stamp declares an empty env", () => {
		for (const row of rows("cursor")) assert.ok(!("env" in entryFor("cursor", row)));
	});
});

describe("own-entry recognition", () => {
	it("reads both shapes, so the next install replaces instead of doubling", () => {
		for (const id of ["cursor", "qoder", "testhost"]) {
			assert.equal(isOwnHookEntry(profileFor(id), NESTED), true, id);
			assert.equal(isOwnHookEntry(profileFor(id), { command: ".cursor/hooks/cm-stop.cmd" }), true, id);
			assert.equal(isOwnHookEntry(profileFor(id), { command: ".cursor/hooks/cmhook.exe", args: ["cm-stop"] }), true, id);
			assert.equal(isOwnHookEntry(profileFor(id), { hooks: [{ name: "contextmind-cm-stop" }] }), true, id);
		}
	});

	it("leaves the host's other users alone", () => {
		for (const id of ["cursor", "qoder", "testhost"]) {
			const profile = profileFor(id);
			assert.equal(isOwnHookEntry(profile, { command: ".cursor/hooks/mine.sh" }), false, id);
			assert.equal(isOwnHookEntry(profile, { hooks: [{ command: "node", args: ["hooks/user-thing.mjs"] }] }), false, id);
			assert.equal(isOwnHookEntry(profile, { command: ".cursor/hooks/cmhook.exe", args: ["other"] }), false, id);
			assert.equal(isOwnHookEntry(profile, null), false, id);
			assert.equal(isOwnHookEntry(null, NESTED), true, "a missing profile must not lose track of our own rows");
		}
	});

	it("still answers the flat-only test the installer's Cursor merge uses", () => {
		assert.equal(isOwnHook({ command: ".cursor/hooks/cm-pre-tool.cmd" }), true);
		assert.equal(isOwnHook({ command: ".cursor/hooks/mine.sh" }), false);
		assert.equal(hookEntryPresent({ command: ".cursor/hooks/cm-post-tool.cmd" }, "cm-post-tool"), true);
	});
});

describe("a third host, described only in data", () => {
	it("resolves from the registry with no code change", () => {
		assert.ok(hostIds().includes("testhost"));
		// The plan cannot know it: testhost exists solely in the temp registry this test wrote.
		assert.doesNotMatch(readFileSync(PLAN, "utf8"), /testhost/);
		assert.doesNotMatch(readFileSync(HOSTS, "utf8"), /testhost/);
	});

	it("emits its nested entries from its own profile", () => {
		const entries = byEvent("testhost");
		assert.equal(entries.PRE_TOOL.hooks[0].name, "contextmind-cm-pre-tool");
		assert.equal(entries.PRE_TOOL.matcher, "^(bash|run_shell)$");
		assert.equal(entries.PRE_TOOL.async, false);
		assert.deepEqual(entries.ON_STOP.hooks[0].env, {
			CONTEXTMIND_HOST: "testhost",
			TESTHOST_CHANNEL: "beta",
		});
		assert.ok(!("matcher" in entries.ON_START), "matcherEvents lists only PRE_TOOL");
		assert.equal(entries.ON_START.async, true);
	});

	it("emits flat entries for a flat host, per-row failClosed and a profile matcher", () => {
		const profile = profileFor("testhost-flat");
		const list = dedupeEntriesForHost(profile, HOOK_ENTRIES);
		assert.equal(list.length, HOOK_ENTRIES.length, "identity events, no collapsing");
		const pre = list.filter((r) => r.event === "preToolUse").map((r) => hookEntryFor(profile, { ...r, projectRoot: ROOT }));
		assert.deepEqual(
			pre.map((e) => e.matcher),
			["^(bash)$", "^(bash)$"],
			"a declared toolMatcher outranks the per-row matcher",
		);
		assert.deepEqual(
			pre.map((e) => e.failClosed),
			[false, true],
		);
		const session = hookEntryFor(profile, list.find((r) => r.event === "sessionStart"));
		assert.ok(!("env" in session), "hooks.env {} gets no key");
		assert.ok(!("matcher" in session));
		assert.equal(session.command, ".cursor/hooks/cm-session-start.cmd");
	});
});

describe("trae (verified contract)", () => {
	// Measured 2026-09-13 and re-checked when this branch merged: this Trae build registers
	// .trae/hooks.json as a context asset but never dispatches PreToolUse/PostToolUse to
	// external commands, so capabilities.hooks is false and NO rows are installed. The hooks
	// block stays in the profile so install/fix-hooks keep the launchers ready for a build that
	// does dispatch — hence these assertions target the declared shape, not generated rows.
	it("declares no hook capability, and therefore installs no rows", () => {
		const profile = profileFor("trae");
		assert.equal(profile.verified, true);
		assert.equal(profile.capabilities.hooks, false, "measured: this build never dispatches hook commands");
		assert.deepEqual(dedupeEntriesForHost(profile, HOOK_ENTRIES), []);
		assert.equal(hookEntryFor(profile, { hook: "cm-pre-tool", event: "PreToolUse", projectRoot: ROOT }), null);
	});

	it("keeps the hook block declared, so launchers stay ready for a build that dispatches", () => {
		const profile = profileFor("trae");
		assert.equal(profile.hooks.file.path, ".trae/hooks.json");
		assert.equal(profile.hooks.file.entryShape, "claude-nested");
		assert.equal(profile.hooks.file.leafCommandString, true, "Trae drops an args array — one command string");
		assert.ok(profile.hooks.matcherEvents.includes("PreToolUse"));
		assert.match(profile.hooks.toolMatcher, /run_mcp/, "Trae routes every MCP tool through run_mcp");
		assert.match(profile.hooks.toolMatcher, /Shell/, "Trae names its shell tool Shell, not Bash");
	});

it("mounts the Brain user-scope, without a cwd the loader may reject", () => {
		const profile = profileFor("trae");
		assert.equal(profile.mcp.mountBrain, true);
		assert.equal(profile.mcp.cwdSupported, false);
		assert.equal(profile.mcp.scope, "user");
		assert.ok(!/%APPDATA%/.test(profile.mcp.path), "resolveConfigFile joins against homedir, it does not expand env vars");
		const home = mkdtempSync(join(tmpdir(), "cm-trae-home-"));
		mkdirSync(join(home, "AppData", "Roaming", "Trae CN", "User"), { recursive: true });
		assert.equal(
			resolveConfigFile(profile.mcp, { home }),
			join(home, "AppData", "Roaming", "Trae CN", "User", "mcp.json"),
		);
		rmSync(home, { recursive: true, force: true });
	});
});

describe("workbuddy (verified contract)", () => {
	// WorkBuddy was the first host believed to be MCP-only. A probe against a real install
	// (2026-09-14) overturned that: hooks fire from the `hooks` key of the USER settings file
	// `~/.workbuddy-ai/settings.json`, hot-reloaded, and `permissionDecision: deny` blocks a
	// call. Three earlier probe placements — `.codebuddy/hooks.json`, `.workbuddy/hooks.json`
	// and a plugin's `hooks/hooks.json` — stayed silent, which is what produced the
	// "channel disabled" reading; the directory is `.workbuddy-ai`, not `.workbuddy`.
	// It is also the first host that wants the Brain mounted while being user-scope —
	// which used to key off `profile.id === "cursor"`.
	it("keeps its MCP config at the user root the host actually reads", () => {
		const profile = profileFor("workbuddy");
		assert.equal(profile.verified, true);
		assert.equal(profile.mcp.scope, "user");
		assert.equal(profile.mcp.path, ".workbuddy-ai/mcp.json");
		assert.equal(profile.mcp.mountBrain, true);
		assert.equal(profile.mcp.cwdSupported, false);
	});

	it("declares a hook surface in the user settings file, not a plugin manifest", () => {
		const profile = profileFor("workbuddy");
		assert.equal(profile.capabilities.hooks, true);
		assert.equal(profile.hooks.file.scope, "user");
		assert.equal(profile.hooks.file.path, ".workbuddy-ai/settings.json");
		assert.equal(profile.hooks.file.keyPath, "hooks");
		assert.equal(profile.hooks.file.entryShape, "claude-nested");
	});

	it("maps canonical events onto the host's PascalCase spelling", () => {
		// The host loader matches `PreToolUse`, not the registry's `preToolUse`.
		const profile = profileFor("workbuddy");
		assert.equal(registryFns.hookEventName(profile, "preToolUse"), "PreToolUse");
		assert.equal(registryFns.hookEventName(profile, "postToolUse"), "PostToolUse");
		assert.equal(registryFns.hookEventName(profile, "beforeSubmitPrompt"), "UserPromptSubmit");
	});

	it("takes hook rows now that the profile declares a hook surface", () => {
		const rows = dedupeEntriesForHost(profileFor("workbuddy"), HOOK_ENTRIES);
		assert.ok(rows.length > 0, "a hook-capable host is no longer skipped");
		assert.ok(rows.some((r) => r.event === "PreToolUse"));
		assert.ok(rows.some((r) => r.event === "PostToolUse"));
	});

	it("spells the leaf command with doubled slashes, and never as an args array", () => {
		// Hooks are spawned through Git Bash, where MSYS rewrites `/d` into a drive path and the
		// whole invocation dies — the single-slash form never fired on a real install. `args` is
		// ignored outright, so the command has to be one string.
		const row = hookEntryFor(profileFor("workbuddy"), {
			hook: "cm-pre-tool",
			event: "PreToolUse",
			projectRoot: ROOT,
		});
		assert.ok(row, "a hook-capable host gets a row");
		const leaf = row.hooks[0];
		assert.match(leaf.command, /^cmd\.exe \/\/d \/\/c "/);
		assert.match(leaf.command, /cm-pre-tool\.cmd/);
		assert.ok(!("args" in leaf), "WorkBuddy ignores an args array");
	});
});

describe("globbed config paths", () => {
	// No shipped profile uses a wildcard any more (WorkBuddy's connector path was the last
	// one, and a real install proved it wrong), but the resolver keeps the behaviour: a host
	// that namespaces config per install cannot have its uid pinned in the registry.
	it("prefers the live uuid sibling over the stale default one", () => {
		const home = mkdtempSync(join(tmpdir(), "cm-glob-live-"));
		const root = join(home, ".somehost", "connectors");
		const stale = join(root, "default");
		const liveUid = join(root, "0f0f0f0f-1111-2222-3333-444455556666");
		mkdirSync(stale, { recursive: true });
		mkdirSync(liveUid, { recursive: true });
		writeFileSync(join(stale, "mcp.json"), "{}");
		writeFileSync(join(liveUid, "mcp.json"), "{}");
		writeFileSync(join(liveUid, "connector-states.v3.json"), "{}");
		const target = { scope: "user", path: ".somehost/connectors/*/mcp.json" };
		assert.equal(
			registryFns.resolveConfigFile(target, { home }),
			join(liveUid, "mcp.json"),
			"the state-marker sibling is the live profile",
		);
	});

	it("falls back to the only sibling when there is no marker to rank", () => {
		const home = mkdtempSync(join(tmpdir(), "cm-glob-only-"));
		const dir = join(home, ".somehost", "connectors", "default");
		mkdirSync(dir, { recursive: true });
		const target = { scope: "user", path: ".somehost/connectors/*/mcp.json" };
		assert.equal(registryFns.resolveConfigFile(target, { home }), join(dir, "mcp.json"));
	});
});

describe("absent governance data", () => {
	// hosts.mjs falls back to the registry shipped beside it, so an empty registry has to be
	// simulated with a copy of the modules whose own directory carries no hosts.json — which is
	// exactly the shape of a deploy that shipped the code and not the data.
	it("writes nothing rather than throwing when hosts.json cannot be read", () => {
		const orphan = join(tmp, "orphan", "lib");
		mkdirSync(orphan, { recursive: true });
		copyFileSync(HOSTS, join(orphan, "hosts.mjs"));
		copyFileSync(PLAN, join(orphan, "install-plan.mjs"));
		const broken = join(tmp, "broken.json");
		writeFileSync(broken, "{ this is not json");
		const probe = `
			const hosts = await import(process.env.CM_HOSTS_URL);
			const plan = await import(process.env.CM_PLAN_URL);
			const profile = hosts.profileFor("qoder");
			globalThis.OUT = {
				ids: hosts.hostIds(),
				dedupe: plan.dedupeEntriesForHost(profile, plan.HOOK_ENTRIES),
				dedupeNull: plan.dedupeEntriesForHost(null, plan.HOOK_ENTRIES),
				entry: plan.hookEntryFor(profile, { hook: "cm-stop", event: "Stop", projectRoot: "C:\\\\x" }),
				own: plan.isOwnHookEntry(profile, { hooks: [{ name: "contextmind-cm-stop" }] }),
			};
		`;
		const r = spawnSync(
			process.execPath,
			["--input-type=module", "-e", `${probe}\nconsole.log(JSON.stringify(globalThis.OUT));`],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CONTEXTMIND_HOSTS_FILE: broken,
					CM_HOSTS_URL: pathToFileURL(join(orphan, "hosts.mjs")).href,
					CM_PLAN_URL: pathToFileURL(join(orphan, "install-plan.mjs")).href,
				},
				timeout: 60_000,
				windowsHide: true,
			},
		);
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
		assert.match(r.stderr, /hosts\.json unreadable/);
		assert.deepEqual(out.ids, [], "empty registry, and the layer says so on stderr instead of crashing");
		assert.deepEqual(out.dedupe, []);
		assert.deepEqual(out.dedupeNull, []);
		assert.equal(out.entry, null);
		assert.equal(out.own, true, "an entry we wrote is still ours to remove with no registry to read");
	});

	it("degrades to identity events and a flat row when a profile carries no shape", () => {
		const profile = { id: "ghost", capabilities: { hooks: true, failClosed: true }, hooks: {} };
		const list = dedupeEntriesForHost(profile, HOOK_ENTRIES);
		assert.equal(list.length, HOOK_ENTRIES.length, "no event map means the host answers to our names");
		const row = list.find((r) => r.event === "stop");
		const entry = hookEntryFor(profile, { ...row, projectRoot: ROOT });
		assert.equal(entry.command, ".cursor/hooks/cm-stop.cmd", "unknown entryShape is the flat row");
		assert.ok(!Array.isArray(entry.hooks));
		assert.ok(!("env" in entry), "no env in the profile, so no env key");
	});
});
