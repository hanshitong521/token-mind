#!/usr/bin/env node
/**
 * Thin preToolUse → TokenMind Runtime (no cm-lib on hot path).
 */
import { invokeHook, readHookInput, toHostOutput } from "./cm-rpc.mjs";

try {
	const input = await readHookInput();
	await invokeHook("pre", input);
} catch {
	process.stdout.write(`${JSON.stringify(toHostOutput({ permission: "allow" }, "pre"))}\n`);
	process.exit(0);
}
