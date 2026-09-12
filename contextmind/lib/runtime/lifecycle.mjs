/**
 * One TokenMind Runtime per machine: pid file + health + start/stop.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
	return join(homedir(), PID_DIR_NAME, PID_FILE_NAME);
}

export function runtimePort() {
	const n = Number(process.env.TOKENMIND_PORT);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

export function runtimeHost() {
	return process.env.TOKENMIND_HOST || DEFAULT_HOST;
}

export function daemonScript() {
	return join(HERE, "daemon.mjs");
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
	writeFileSync(p, `${JSON.stringify({ ...info, pid: process.pid, port: runtimePort(), host: runtimeHost() }, null, 2)}\n`);
}

export function clearPidFile() {
	try {
		unlinkSync(pidPath());
	} catch {
		/* missing is fine */
	}
}

export function healthRequest({ host = runtimeHost(), port = runtimePort(), timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
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
		fetch(`http://${host}:${port}${path}`, { signal: ac.signal })
			.then(async (res) => {
				clearTimeout(t);
				const body = await res.json().catch(() => ({}));
				resolve({ ok: res.ok && body.ok !== false, ...body, status: res.status });
			})
			.catch((err) => {
				clearTimeout(t);
				reject(err);
			});
	});
}

export async function isListening(port = runtimePort(), host = runtimeHost()) {
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

export async function startDaemon({ env = {}, waitMs = START_WAIT_MS } = {}) {
	const port = runtimePort();
	const host = runtimeHost();
	if (await isListening(port, host)) {
		return { ok: true, already: true, host, port };
	}
	const script = daemonScript();
	if (!existsSync(script)) return { ok: false, error: `missing daemon: ${script}` };
	const child = spawn(process.execPath, [script], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ...env, TOKENMIND_PORT: String(port), TOKENMIND_HOST: host },
	});
	child.unref();
	const t0 = Date.now();
	while (Date.now() - t0 < waitMs) {
		if (await isListening(port, host)) return { ok: true, started: true, pid: child.pid, host, port };
		await new Promise((r) => setTimeout(r, 50));
	}
	return { ok: false, error: "daemon start timeout", pid: child.pid, host, port };
}

export async function stopDaemon() {
	const host = runtimeHost();
	const port = runtimePort();
	try {
		await fetch(`http://${host}:${port}/stop`, { method: "POST", signal: AbortSignal.timeout(1_000) });
	} catch {
		/* already down */
	}
	const rec = readPidFile();
	if (rec?.pid && rec.pid !== process.pid) {
		try {
			process.kill(rec.pid);
		} catch {
			/* gone */
		}
	}
	clearPidFile();
	return { ok: true };
}
