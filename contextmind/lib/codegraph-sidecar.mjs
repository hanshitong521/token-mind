/**
 * CodeGraph sidecar (named pipe / Unix socket) — Peak Speed S1.
 *
 * AI-NOTE — touch this file carefully:
 * - WHY: warm orient is ms via daemon; CLI spawn is ~0.5–20s. Prefer pipe; CLI only fallback.
 * - DO NOT: hash only one Windows drive-letter case (`E:` vs `e:` → different pipes).
 *   Always try pidfile `socketPath` + both letter cases (daemonSocketCandidates).
 * - DO NOT: leave sessions open in doctor/CLI probes (Node won't exit). closeSidecarSession
 *   must destroy+unref; probeSidecar already closes in `finally`.
 * - DO NOT: expose raw codegraph_* to Cursor (schema tax + Output Gate bypass).
 * - AFTER CHANGE TEST:
 *   1) `node .cursor/contextmind/cli.mjs doctor <project>` → codegraph line says `sidecar`
 *   2) `node scripts/bench-codegraph-sidecar.mjs` → warm ≤50ms and process EXIT 0
 *   3) Kill daemon, one cold orient (auto-spawn), then warm again
 * Evidence: docs/agent-stack/AGENT-SESSION-HANG-2026-09-11.md
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

import { resolveBundledLaunch } from "./codegraph-direct.mjs";
import { codegraphCwd } from "./codegraph-spawn.mjs";

/** @typedef {{ socket: import('node:net').Socket, call: Function, notify: Function, root: string }} SidecarSession */

/** @type {Map<string, Promise<SidecarSession>>} */
const sessions = new Map();

function projectHash(root) {
	return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

/** Prefer uppercase drive letter on Windows so pipe names match CodeGraph daemons. */
export function normalizeProjectRoot(projectRoot) {
	let root = resolve(projectRoot);
	if (process.platform === "win32" && /^[a-z]:/.test(root)) {
		root = root[0].toUpperCase() + root.slice(1);
	}
	return root;
}

/** Windows named pipe or POSIX sock candidates matching CodeGraph daemon-paths. */
export function daemonSocketCandidates(projectRoot) {
	const root = resolve(projectRoot);
	if (process.platform === "win32") {
		const variants = new Set([root]);
		if (/^[a-zA-Z]:/.test(root)) {
			variants.add(root[0].toUpperCase() + root.slice(1));
			variants.add(root[0].toLowerCase() + root.slice(1));
		}
		return [...variants].map((r) => `\\\\.\\pipe\\codegraph-${projectHash(r)}`);
	}
	const n = normalizeProjectRoot(projectRoot);
	return [join(n, ".codegraph", "daemon.sock")];
}

function readPidInfo(root) {
	const pidPath = join(root, ".codegraph", "daemon.pid");
	if (!existsSync(pidPath)) return null;
	try {
		return JSON.parse(readFileSync(pidPath, "utf8"));
	} catch {
		return null;
	}
}

function processAlive(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function connectPath(path, timeoutMs = 1500) {
	return new Promise((res, rej) => {
		const s = createConnection(path);
		s.setEncoding("utf8");
		const t = setTimeout(() => {
			try {
				s.destroy();
			} catch {
				/* ok */
			}
			rej(new Error(`connect timeout ${path}`));
		}, timeoutMs);
		s.once("connect", () => {
			clearTimeout(t);
			res(s);
		});
		s.once("error", (e) => {
			clearTimeout(t);
			try {
				s.destroy();
			} catch {
				/* ok */
			}
			rej(e);
		});
	});
}

async function connectAny(root) {
	const info = readPidInfo(root);
	const paths = [];
	// Prefer lockfile socket even if pid check is flaky on Windows — connect is the truth.
	if (info?.socketPath) paths.push(info.socketPath);
	for (const p of daemonSocketCandidates(root)) {
		if (!paths.includes(p)) paths.push(p);
	}
	let lastErr;
	for (const p of paths) {
		try {
			return await connectPath(p);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error("no daemon socket");
}

function makeRpc(socket, initialBuf = "") {
	let buf = initialBuf;
	let nextId = 1;
	/** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
	const waiters = new Map();
	const onData = (chunk) => {
		buf += chunk;
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!line.trim()) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			if (obj.id != null && waiters.has(obj.id)) {
				const w = waiters.get(obj.id);
				waiters.delete(obj.id);
				clearTimeout(w.timer);
				w.resolve(obj);
			}
		}
	};
	socket.on("data", onData);
	return {
		call(method, params, timeoutMs = 30_000) {
			const id = nextId++;
			socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			return new Promise((res, rej) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					rej(new Error(`rpc timeout ${method}`));
				}, timeoutMs);
				waiters.set(id, { resolve: res, reject: rej, timer });
			});
		},
		notify(method, params) {
			socket.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
		},
		destroy() {
			for (const [, w] of waiters) {
				clearTimeout(w.timer);
				try {
					w.reject(new Error("sidecar closed"));
				} catch {
					/* ok */
				}
			}
			waiters.clear();
			socket.off("data", onData);
			try {
				socket.end();
			} catch {
				/* ok */
			}
			try {
				socket.destroy();
			} catch {
				/* ok */
			}
			// Allow CLI scripts to exit while the OS finishes tearing down the pipe.
			try {
				socket.unref();
			} catch {
				/* ok */
			}
		},
	};
}

async function readHello(socket, timeoutMs = 5000) {
	return new Promise((res, rej) => {
		let buf = "";
		const t = setTimeout(() => {
			socket.off("data", onData);
			rej(new Error("daemon hello timeout"));
		}, timeoutMs);
		const onData = (c) => {
			buf += c;
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(t);
				socket.off("data", onData);
				res({ line: buf.slice(0, i), rest: buf.slice(i + 1) });
			}
		};
		socket.on("data", onData);
		socket.once("error", (e) => {
			clearTimeout(t);
			rej(e);
		});
	});
}

function spawnDetachedDaemon(cfg, root) {
	const bundled = resolveBundledLaunch(cfg);
	if (!bundled) throw new Error("no bundled codegraph launch for daemon spawn");
	const normalized = normalizeProjectRoot(root);
	const info = readPidInfo(normalized);
	if (info && !processAlive(info.pid)) {
		try {
			unlinkSync(join(normalized, ".codegraph", "daemon.pid"));
		} catch {
			/* ok */
		}
	}
	const child = spawn(bundled.node, [bundled.entry, "serve", "--mcp", "--path", normalized], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, CODEGRAPH_DAEMON_INTERNAL: "1" },
		cwd: normalized,
		windowsHide: true,
	});
	child.unref();
}

async function openSession(cfg, root) {
	let socket;
	try {
		socket = await connectAny(root);
	} catch {
		spawnDetachedDaemon(cfg, root);
		let last;
		for (let i = 0; i < 80; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				socket = await connectAny(root);
				last = null;
				break;
			} catch (e) {
				last = e;
			}
		}
		if (!socket) throw last ?? new Error("daemon did not bind");
	}
	const { rest } = await readHello(socket);
	const rpc = makeRpc(socket, rest);
	await rpc.call("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "contextmind-sidecar", version: "1.0.0" },
	});
	rpc.notify("notifications/initialized");
	socket.on("close", () => {
		sessions.delete(root);
	});
	socket.on("error", () => {
		sessions.delete(root);
		try {
			rpc.destroy();
		} catch {
			/* ok */
		}
	});
	return { socket, ...rpc, root };
}

export function sidecarEnabled(cfg) {
	const m = String(cfg?.adapters?.codegraph?.mode ?? "auto").toLowerCase();
	return m === "sidecar" || m === "auto";
}

/** Reuse one MCP session per project root inside this Node process. */
export async function getSidecarSession(cfg) {
	const root = normalizeProjectRoot(codegraphCwd(cfg));
	let p = sessions.get(root);
	if (!p) {
		p = openSession(cfg, root).catch((err) => {
			sessions.delete(root);
			throw err;
		});
		sessions.set(root, p);
	}
	return p;
}

export async function closeSidecarSession(cfg) {
	const root = normalizeProjectRoot(codegraphCwd(cfg));
	const p = sessions.get(root);
	sessions.delete(root);
	if (!p) return;
	try {
		const session = await p;
		await new Promise((res) => {
			const sock = session.socket;
			const done = () => {
				clearTimeout(t);
				res();
			};
			const t = setTimeout(done, 500);
			if (!sock || sock.destroyed) {
				done();
				return;
			}
			sock.once("close", done);
			try {
				session.destroy?.();
			} catch {
				done();
			}
		});
	} catch {
		/* ok */
	}
}

export async function sidecarToolCall(cfg, name, args, { timeoutMs = 30_000 } = {}) {
	const session = await getSidecarSession(cfg);
	const res = await session.call("tools/call", { name, arguments: args }, timeoutMs);
	if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
	const text = res.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
	const isError = !!res.result?.isError;
	return { ok: !isError && text.length > 40, text, isError };
}

/**
 * Orient via daemon: codegraph_node (+ optional callers/callees).
 * @returns {{ ok: boolean, raw: string, sym: string, via: "sidecar" }}
 */
export async function sidecarOrient(cfg, sym, { callsMode = "auto", callLimit = 8 } = {}) {
	const root = normalizeProjectRoot(codegraphCwd(cfg));
	const node = await sidecarToolCall(
		cfg,
		"codegraph_node",
		{ symbol: sym, includeCode: true, projectPath: root },
		{ timeoutMs: 25_000 },
	);
	const chunks = [`### codegraph node ${sym}\nexit_code=${node.ok ? 0 : 1}\n${node.text}`];
	if (!node.ok) return { ok: false, raw: chunks.join("\n\n"), sym, via: "sidecar" };

	const rich = node.text.length >= 3_500;
	if (callsMode === "node_only" || (callsMode === "auto" && rich)) {
		return { ok: true, raw: chunks.join("\n\n"), sym, via: "sidecar" };
	}

	const limit = Number(callLimit) || 8;
	const [callers, callees] = await Promise.all([
		sidecarToolCall(cfg, "codegraph_callers", { symbol: sym, limit, projectPath: root }, { timeoutMs: 18_000 }),
		sidecarToolCall(cfg, "codegraph_callees", { symbol: sym, limit, projectPath: root }, { timeoutMs: 18_000 }),
	]);
	if (callers.text) chunks.push(`### codegraph callers ${sym}\nexit_code=${callers.ok ? 0 : 1}\n${callers.text}`);
	if (callees.text) chunks.push(`### codegraph callees ${sym}\nexit_code=${callees.ok ? 0 : 1}\n${callees.text}`);
	return { ok: true, raw: chunks.join("\n\n"), sym, via: "sidecar" };
}

/** Doctor / bench: ping existing daemon; always closes the probe session. */
export async function probeSidecar(cfg, { symbol = "OceanMikuController", spawnIfNeeded = false } = {}) {
	const root = normalizeProjectRoot(codegraphCwd(cfg));
	const t0 = Date.now();
	try {
		if (!spawnIfNeeded) {
			const s = await connectAny(root);
			s.destroy();
		}
		const r = await sidecarToolCall(
			cfg,
			"codegraph_node",
			{ symbol, includeCode: true, projectPath: root },
			{ timeoutMs: 20_000 },
		);
		const ms = Date.now() - t0;
		return {
			ok: r.ok,
			ms,
			launcher: "sidecar",
			exitCode: r.ok ? 0 : 1,
			stdoutBytes: Buffer.byteLength(r.text, "utf8"),
			detail: r.ok ? `${ms}ms sidecar` : `sidecar fail ${ms}ms`,
		};
	} catch (e) {
		return {
			ok: false,
			ms: Date.now() - t0,
			launcher: "sidecar",
			exitCode: null,
			stdoutBytes: 0,
			detail: e?.message ?? String(e),
		};
	} finally {
		await closeSidecarSession(cfg);
	}
}

export const _test = { projectHash, daemonSocketCandidates, processAlive, normalizeProjectRoot };
