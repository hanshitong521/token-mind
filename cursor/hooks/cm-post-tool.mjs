#!/usr/bin/env node
/**
 * Thin postToolUse → TokenMind Runtime (no cm-lib on hot path).
 */
import { invokeHook, readHookInput } from "./cm-rpc.mjs";

try {
	const input = await readHookInput();
	await invokeHook("post", input);
} catch {
	process.stdout.write("{}\n");
	process.exit(0);
}
