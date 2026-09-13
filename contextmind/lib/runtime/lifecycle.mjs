/**
 * One TokenMind Runtime per machine: pid file + health + start/stop.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	HEALTH_PATH,
	HEALTH_TIMEOUT_MS,
	PID_DIR_NAME,
	PID_FILE_NAME,
	START_WAIT_MS,
} from "./constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function pidPath() {
	const override = process.env.TOKENMIND_PID_DIR?.trim();
	return override
		? join(override, PID_FILE_NAME)
		: join(homedir(), PID_DIR_NAME, PID_FILE_NAME);
}

/** Preferred port for a NEW daemon. A bound daemon reports its real port via the pid file. */
export function runtimePort() {
	const n = Number(process.env.TOKENMIND_PORT);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** Port the resident daemon actually bound, or null when there is no pid file. */
export function daemonPortFromPidFile() {
	const rec = readPidFile();
	const n = Number(rec?.port);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Port a CLIENT should talk to. The pid file wins over the default because the daemon
 * may have fallen back off a busy port; an explicit TOKENMIND_PORT still wins over both
 * (tests and side-by-side runtimes rely on that).
 */
export function resolveRuntimePort() {
	const env = Number(process.env.TOKENMIND_PORT);
	if (Number.isFinite(env) && env > 0) return env;
	return daemonPortFromPidFile() ?? runtimePort();
}

export function runtimeHost() {
	return process.env.TOKENMIND_HOST || DEFAULT_HOST;
}

export function daemonScript() {
	return join(HERE, "daemon.mjs");
}

/**
 * Fingerprint of the code sitting on disk: newest mtime plus file count under lib/.
 *
 * The script path alone cannot answer "is the resident daemon current?" — editing a handler
 * leaves the path untouched, so `install` reported already:true against superseded code and
 * the fix only landed after someone thought to restart. One walk at startup, not per call.
 */
export function codeStamp() {
	const root = join(HERE, "..");
	let newest = 0;
	let files = 0;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.name.endsWith(".mjs")) {
				files += 1;
				try {
					newest = Math.max(newest, statSync(full).mtimeMs);
				} catch {
					/* raced with an edit; the next file still anchors the stamp */
				}
			}
		}
	}
	return `${Math.round(newest)}:${files}`;
}

export function readPidFile() {
	try {
		return JSON.parse(readFileSync(pidPath(), "utf8"));
	} catch {
		return null;
	}
}

export function writePidFile(info) {
	const p = pidPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		`${JSON.stringify({ ...info, pid: process.pid, port: info?.port ?? runtimePort(), host: runtimeHost() }, null, 2)}\n`,
	);
}

export function clearPidFile() {
	try {
		unlinkSync(pidPath());
	} catch {
		/* missing is fine */
	}
}

export function daemonLockPath() {
	return join(dirname(pidPath()), "daemon.lock");
}

function pidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * Machine-wide "I am the runtime" claim, taken before the listener binds.
 *
 * Without it a burst of hook cold-starts each spawns a daemon: one wins the preferred
 * port, the rest fall to ephemeral ports and stay alive, and only the last writer owns
 * the pid file — so hooks keep being served by processes holding superseded code.
 * Port collision catches that race only when the preferred port is free; a foreign
 * listener on it (the Brain dashboard shares 18787) hides every later daemon.
 *
 * @returns {Promise<{ok: true} | {ok: false, pid?: number, reason: string}>}
 */
export async function acquireDaemonLock() {
	const path = daemonLockPath();
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(path, `${JSON.stringify({ pid: process.pid, port: null }, null, 0)}\n`, { flag: "wx" });
			return { ok: true };
		} catch (err) {
			if (err?.code !== "EEXIST") return { ok: false, reason: err?.code ?? "lock-failed" };
			let holder = null;
			try {
				holder = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				/* unreadable is stale */
			}
			const live = await holderIsLive(holder);
			if (live) return { ok: false, pid: holder?.pid, reason: "held" };
			try {
				unlinkSync(path);
			} catch {
				/* someone else took over; the retry re-reads it */
			}
		}
	}
	return { ok: false, reason: "takeover-failed" };
}

/** A pid alone is not proof — a recycled pid would block every future start forever. */
async function holderIsLive(holder) {
	if (!holder || !pidAlive(holder.pid) || holder.pid === process.pid) return false;
	const port = Number(holder.port);
	if (!Number.isFinite(port) || port <= 0) return true;
	const h = await healthRequest({ host: holder.host || runtimeHost(), port });
	return Boolean(h.ok);
}

export function stampDaemonLock(port) {
	try {
		writeFileSync(daemonLockPath(), `${JSON.stringify({ pid: process.pid, port, host: runtimeHost() }, null, 0)}\n`);
	} catch {
		/* best effort; the pid alone already serialises starts */
	}
}

export function releaseDaemonLock() {
	try {
		const holder = JSON.parse(readFileSync(daemonLockPath(), "utf8"));
		if (holder?.pid === process.pid) unlinkSync(daemonLockPath());
	} catch {
		/* not ours or already gone */
	}
}

export function healthRequest({ host = runtimeHost(), port = resolveRuntimePort(), timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		const req = createServerRequest(host, port, HEALTH_PATH, timeoutMs);
		req.then(resolve).catch(() => resolve({ ok: false }));
	});
}

function createServerRequest(host, port, path, timeoutMs) {
	return new Promise((resolve, reject) => {
		const ac = new AbortController();
		const t = setTimeout(() => {
			ac.abort();
			reject(new Error("timeout"));
		}, timeoutMs);
		fetch(`http://${host}:${port}${path}`, { signal: ac.signal, headers: { connection: "close" } })
			.then(async (res) => {
				clearTimeout(t);
				const body = await res.json().catch(() => ({}));
				// A foreign 200 on this port (e.g. the Brain dashboard's {"status":"ok"}) must
				// NOT count as "our runtime is up": that made startDaemon report already:true,
				// skip starting, and every hook fall back to minimal mode.
				const isRuntime = res.ok && body?.ok === true && Number(body?.v) >= 1;
				resolve({ ...body, ok: isRuntime, status: res.status });
			})
			.catch((err) => {
				clearTimeout(t);
				reject(err);
			});
	});
}

export async function isListening(port = resolveRuntimePort(), host = runtimeHost()) {
	const h = await healthRequest({ host, port });
	return Boolean(h.ok);
}

/** True if something else already bound the port (not necessarily us). */
export function portInUse(port = runtimePort(), host = runtimeHost()) {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once("error", () => resolve(true));
		srv.once("listening", () => {
			srv.close(() => resolve(false));
		});
		srv.listen(port, host);
	});
}

/** A daemon that cannot name its script predates the identity field, so it runs old code. */
function isStaleDaemon(script, stamp, diskStamp) {
	if (String(script ?? "") !== daemonScript()) return true;
	return String(stamp ?? "") !== diskStamp;
}

async function waitForDown(port, host, waitMs) {
	const t0 = Date.now();
	while (Date.now() - t0 < waitMs) {
		const h = await healthRequest({ host, port });
		if (!h.ok) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

export async function startDaemon({ env = {}, waitMs = START_WAIT_MS, converge = false } = {}) {
	const host = runtimeHost();
	const preferred = runtimePort();

	// A live daemon wins regardless of which port it settled on — unless it was loaded from
	// another copy of this code. Reusing that one printed "already running" while the hooks
	// kept being served from handlers this install had already replaced. Opt-in only: a hook
	// that reached a second copy's daemon must reuse it, not fight it for the port.
	const candidates = [];
	const converged = [];
	// Only the explicit converge path pays for the lib walk; the hook cold-start never does.
	const diskStamp = converge ? codeStamp() : "";
	const bound = daemonPortFromPidFile();
	if (bound) candidates.push(bound);
	if (!candidates.includes(preferred)) candidates.push(preferred);

	for (const port of candidates) {
		const h = await healthRequest({ host, port });
		if (!h.ok) continue;
		if (!converge || !isStaleDaemon(h.script, h.stamp, diskStamp)) return { ok: true, already: true, host, port };
		converged.push({ port, script: h.script || "(pre-identity build)", stamp: h.stamp || "(none)" });
		await stopDaemon({ port });
		if (!(await waitForDown(port, host, 2_000))) {
			return { ok: false, error: `stale daemon on :${port} did not exit`, host, port };
		}
		continue;
	}

	const script = daemonScript();
	if (!existsSync(script)) return { ok: false, error: `missing daemon: ${script}`, host, port: preferred };

	// Drop a stale record so the poll below cannot read a dead daemon's port.
	clearPidFile();
	const child = spawn(process.execPath, [script], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ...env, TOKENMIND_PORT: String(preferred), TOKENMIND_HOST: host },
	});
	child.unref();

	const t0 = Date.now();
	while (Date.now() - t0 < waitMs) {
		const actual = daemonPortFromPidFile();
		if (actual && (await isListening(actual, host))) {
			return { ok: true, started: true, pid: child.pid, host, port: actual, converged };
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return { ok: false, error: "daemon start timeout", pid: child.pid, host, port: preferred };
}

export async function stopDaemon({ port = resolveRuntimePort() } = {}) {
	const host = runtimeHost();
	try {
		await fetch(`http://${host}:${port}/stop`, { method: "POST", signal: AbortSignal.timeout(1_000) });
	} catch {
		/* already down */
	}
	const rec = readPidFile();
	// The pid file names one daemon; killing it because a different port refused to close
	// would take out the runtime that is still healthy.
	if (rec?.port === port && rec.pid && rec.pid !== process.pid) {
		try {
			process.kill(rec.pid);
		} catch {
			/* gone */
		}
	}
	if (!rec || rec.port === port) clearPidFile();
	return { ok: true, port };
}
