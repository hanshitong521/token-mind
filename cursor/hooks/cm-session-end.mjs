#!/usr/bin/env node
/**
 * ContextMind sessionEnd hook — release per-session state.
 *
 * Dedup entries are keyed by session, so a new conversation must start clean:
 * carrying a fingerprint across sessions would make the agent's first read of a
 * file look like a repeat. Handles outlive the session (that is the point of
 * reversible evidence), so only expiry and the disk cap apply to them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, dedup, handles, ready, runtime } from "./cm-lib.mjs";

if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, projectRootOf, readHookInput, sessionIdOf } = runtime;
const { getConfig } = config;
const { openHandles } = handles;
const { Dedup } = dedup;

const input = await readHookInput();
const sessionId = sessionIdOf(input);
const projectRoot = projectRootOf(input);
const cfg = getConfig(projectRoot);

// Fire-and-forget: Cursor does not use the response, so print nothing useful
// and never block window close on I/O.
try {
	const handles = openHandles(cfg);
	if (handles.available) {
		new Dedup(handles.db).clearSession(sessionId);
		handles.gc();
	}
	handles.close();
} catch {
	/* cleanup failure is not worth surfacing at window close */
}

// Best-effort: record that the session ended so `report` can bound a session.
try {
	const marker = join(projectRoot, ".contextmind", "last-session.json");
	readFileSync(marker, "utf8");
} catch {
	/* absence is fine; the marker is informational only */
}

emit({});
process.exit(0);
