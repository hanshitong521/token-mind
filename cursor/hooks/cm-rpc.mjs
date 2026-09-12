/**
 * Minimal hook I/O + Runtime RPC. No cm-lib import graph.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Hang doc P0 — keep in sync with contextmind/lib/runtime/constants.mjs */
const HOOK_PROCESS_EXIT_MS = 500;
const SENTINEL = join("lib", "runtime.mjs");
const CANDIDATE_DIRS = ["contextmind", join("cursor", "contextmind"), join(".cursor", "contextmind")];
const MAX_DEPTH = 6;

export function findHome(startDir = dirname(fileURLToPath(import.meta.url))) {
	if (process.env.CONTEXTMIND_HOME) {
		const envPath = process.env.CONTEXTMIND_HOME;
		if (existsSync(join(envPath, SENTINEL))) return envPath;
		return null;
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

export function readStdin() {
	return new Promise((resolve) => {
		let raw = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => {
			raw += c;
		});
		process.stdin.on("end", () => resolve(raw));
		process.stdin.on("error", () => resolve(raw));
	});
}

export async function readHookInput() {
	const raw = await readStdin();
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function emit(output) {
	process.stdout.write(`${JSON.stringify(output ?? {})}\n`);
}

let rpcMod = null;

async function loadRpc() {
	if (rpcMod) return rpcMod;
	const home = findHome();
	if (!home) return null;
	rpcMod = await import(pathToFileURL(join(home, "lib", "runtime", "rpc-client.mjs")).href);
	return rpcMod;
}

function failOpen(phase) {
	emit(phase === "pre" ? { permission: "allow" } : {});
	process.exit(0);
}

export async function invokeHook(phase, input) {
	const guard = setTimeout(() => failOpen(phase), HOOK_PROCESS_EXIT_MS);
	try {
		const mod = await loadRpc();
		if (!mod) {
			clearTimeout(guard);
			failOpen(phase);
			return;
		}
		const out = await mod.invokeHookRpc(phase, input);
		clearTimeout(guard);
		const { _tokenmind_rpc_ms, _tokenmind_minimal, ...payload } = out ?? {};
		emit(payload);
		process.exit(0);
	} catch (err) {
		clearTimeout(guard);
		try {
			console.error(`[tokenmind] hook error: ${err?.message ?? err}`);
		} catch {
			/* stderr only */
		}
		failOpen(phase);
	}
}

export async function loadHomeModule(name) {
	const home = findHome();
	if (!home) return null;
	return import(pathToFileURL(join(home, "lib", name)).href);
}

export async function sessionEnsureRuntime() {
	const mod = await loadRpc();
	if (mod?.ensureRuntimeUp) await mod.ensureRuntimeUp();
}
