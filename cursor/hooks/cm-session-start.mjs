#!/usr/bin/env node
/**
 * ContextMind sessionStart hook — adapter probe (spec 5.5).
 *
 * Output: { additional_context }. Nothing here may block the session; a broken
 * probe degrades routing and must say so, not fail.
 *
 * Scope limit worth knowing: this inspects `.cursor/mcp.json`, a declaration.
 * Whether the server actually reached this session's tool catalogue is not
 * observable from a hook, so "configured" is the strongest claim made here.
 */

import { probe, ready, runtime } from "./cm-lib.mjs";

if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, noop, openRuntime, projectRootOf, readHookInput, sessionIdOf } = runtime;
const { adapterWarning, missingEvents, probeAdapters } = probe;

const input = await readHookInput();
const projectRoot = projectRootOf(input);
const rt = openRuntime(projectRoot);
const sessionId = sessionIdOf(input) ?? input.session_id ?? "unknown";

const report = probeAdapters(rt.cfg, projectRoot);
for (const ev of missingEvents(report, sessionId)) {
	try {
		rt.telemetry.record(ev);
	} catch {
		/* telemetry is never load-bearing */
	}
}

const warning = adapterWarning(report);

if (!warning) noop();
emit({ additional_context: warning });
process.exit(0);
