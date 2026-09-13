#!/usr/bin/env node
/** sessionEnd — dedup gc. Thin path (no cm-lib graph). */
import { emit, findHome, loadHomeModule, readHookInput } from "./cm-rpc.mjs";

const HOOK_MS = 8_000;
const guard = setTimeout(() => {
	process.stdout.write("{}\n");
	process.exit(0);
}, HOOK_MS);

try {
	if (!findHome()) {
		clearTimeout(guard);
		emit({});
		process.exit(0);
	}
	const input = await readHookInput();
	const runtime = await loadHomeModule("runtime.mjs");
	const config = await loadHomeModule("config.mjs");
	const handlesMod = await loadHomeModule("handles.mjs");
	const dedupMod = await loadHomeModule("dedup.mjs");
	if (!runtime?.projectRootOf || !config?.loadConfig || !handlesMod?.openHandles) {
		clearTimeout(guard);
		emit({});
		process.exit(0);
	}

	const sessionId = runtime.sessionIdOf(input);
	const projectRoot = runtime.projectRootOf(input);
	const cfg = config.loadConfig(projectRoot);

	try {
		const handles = handlesMod.openHandles(cfg);
		if (handles.available && dedupMod?.Dedup) {
			new dedupMod.Dedup(handles.db).clearSession(sessionId);
			handles.gc();
		}
		handles.close();
	} catch {
		/* ok */
	}
	clearTimeout(guard);
	emit({});
	process.exit(0);
} catch {
	clearTimeout(guard);
	process.stdout.write("{}\n");
	process.exit(0);
}
