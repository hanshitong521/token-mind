#!/usr/bin/env node
/**
 * sessionStart — adapter probe. Thin path: no cm-lib upfront import graph.
 */
import { emit, findHome, loadHomeModule, readHookInput, sessionEnsureRuntime } from "./cm-rpc.mjs";

const HOOK_MS = 8_000;
const guard = setTimeout(() => {
	process.stdout.write("{}\n");
	process.exit(0);
}, HOOK_MS);

try {
	await sessionEnsureRuntime();
	if (!findHome()) {
		clearTimeout(guard);
		process.stdout.write("{}\n");
		process.exit(0);
	}
	const runtime = await loadHomeModule("runtime.mjs");
	const probe = await loadHomeModule("probe.mjs");
	if (!runtime?.openRuntime || !probe?.probeAdapters) {
		clearTimeout(guard);
		process.stdout.write("{}\n");
		process.exit(0);
	}

	const input = await readHookInput();
	const projectRoot = runtime.projectRootOf(input);
	const rt = runtime.openRuntime(projectRoot);
	const sessionId = runtime.sessionIdOf(input) ?? input.session_id ?? "unknown";

	const report = probe.probeAdapters(rt.cfg, projectRoot);
	// Same payload-derived host as the tool rows; an older installed runtime.mjs
	// without the export must not cost us the row.
	const host = runtime.hostOf?.(input) ?? "unknown";
	for (const ev of probe.missingEvents(report, sessionId)) {
		try {
			rt.telemetry.record({ ...ev, host });
		} catch {
			/* ok */
		}
	}
	const warning = probe.adapterWarning(report);
	clearTimeout(guard);
	if (warning) emit({ additional_context: warning });
	else emit({});
	process.exit(0);
} catch {
	clearTimeout(guard);
	process.stdout.write("{}\n");
	process.exit(0);
}
