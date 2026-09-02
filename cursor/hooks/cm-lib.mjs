/**
 * Locate the ContextMind library from an installed hook.
 *
 * Why this exists: a hook runs from `<project>/.cursor/hooks/`, but the library
 * it needs is not at a fixed depth relative to that — in this repo it sits at
 * `<repo>/contextmind/`, and after install it sits at
 * `<project>/.cursor/contextmind/`. Hard-coding either relative path means the
 * hook works in exactly one of the two places, which is the kind of bug that
 * only shows up after "install succeeded".
 *
 * Resolution order: CONTEXTMIND_HOME, then an upward walk looking for a
 * directory that actually contains `lib/runtime.mjs`. The walk checks the
 * presence of a real file rather than trusting a name, so an unrelated
 * `contextmind` folder cannot claim to be the library.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const T_PROCESS_START = performance.now();
const SENTINEL = join("lib", "runtime.mjs");
const CANDIDATE_DIRS = ["contextmind", join("cursor", "contextmind"), join(".cursor", "contextmind")];
const MAX_DEPTH = 6;

export function findHome(startDir = dirname(fileURLToPath(import.meta.url))) {
	if (process.env.CONTEXTMIND_HOME) {
		const envPath = process.env.CONTEXTMIND_HOME;
		if (existsSync(join(envPath, SENTINEL))) return envPath;
		console.error(`[contextmind] CONTEXTMIND_HOME=${envPath} does not contain ${SENTINEL}`);
	}
	let dir = startDir;
	for (let i = 0; i < MAX_DEPTH; i++) {
		for (const rel of CANDIDATE_DIRS) {
			const candidate = join(dir, rel);
			if (existsSync(join(candidate, SENTINEL))) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export const HOME = findHome();

/** Import one library module by file name. */
export function lib(name) {
	if (!HOME) throw new Error("ContextMind library not found");
	return import(pathToFileURL(join(HOME, "lib", name)).href);
}

const T_LIB_START = performance.now();

const [runtime, readGuard, shellGuard, mcpGuard, probe, traps, handles, telemetry, dedup, config, outputGate, tokens, classify] =
	HOME
		? await Promise.all([
				lib("runtime.mjs"),
				lib("read-guard.mjs"),
				lib("shell-guard.mjs"),
				lib("mcp-guard.mjs"),
				lib("probe.mjs"),
				lib("traps.mjs"),
				lib("handles.mjs"),
				lib("telemetry.mjs"),
				lib("dedup.mjs"),
				lib("config.mjs"),
				lib("output-gate.mjs"),
				lib("tokens.mjs"),
				lib("classify.mjs"),
			])
		: [];

/**
 * Where the hook's milliseconds went. G4 requires latency to be reported and
 * requires compression time to be kept apart from hook time, so the stages are
 * measured rather than inferred. Printed only when CONTEXTMIND_TIMING=1 — this
 * object is also how a doctor run can answer "why is my hook slow" without a
 * profiler attached.
 */
export const stages = {
	locateMs: 0,
	libMs: 0,
	runtimeMs: 0,
	workMs: 0,
	totalMs: 0,
};

export const ready = Boolean(HOME);

stages.locateMs = T_LIB_START - T_PROCESS_START;
stages.libMs = performance.now() - T_LIB_START;

/** Print the stage breakdown to stderr. Never stdout: stdout is the hook result. */
export function dumpStages(label) {
	if (process.env.CONTEXTMIND_TIMING !== "1") return;
	stages.totalMs = performance.now() - T_PROCESS_START;
	console.error(`[contextmind timing] ${label} ${JSON.stringify({ ...stages, totalMs: Math.round(stages.totalMs) })}`);
}
export {
	runtime,
	readGuard,
	shellGuard,
	mcpGuard,
	probe,
	traps,
	handles,
	telemetry,
	dedup,
	config,
	outputGate,
	tokens,
	classify,
};
