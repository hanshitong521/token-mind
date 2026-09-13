#!/usr/bin/env node
/**
 * TokenMind Runtime — one localhost HTTP process (hooks + health).
 *
 * AI-NOTE:
 * - WHY: cmhook.exe posts /hook here; cold Node per-tool is worse without this daemon.
 * - DO NOT: send `Connection: keep-alive` on /hook responses. cmhook's HttpWebRequest
 *   then stalls ~800ms, times out, and fail-opens to bare `{"permission":"allow"}`
 *   (governance silently skipped). Health may keep-alive; /hook must Connection: close.
 * - DO NOT: remove server.keepAliveTimeout — still helps Node-side clients.
 * - AFTER CHANGE: POST /stop + restart daemon.mjs; then
 *   `node scripts/hook-latency-peak.mjs 8` → cmhook p50 should stay ~≤80ms (not ~800ms);
 *   sample cmhook stdout must be real allow/deny JSON from Runtime, not only minimal allow.
 * - S2: `\\.\pipe\tokenmind-hook` for cmhook (Rust); HTTP /hook remains fallback.
 * Evidence: docs/agent-stack/AGENT-SESSION-HANG-2026-09-11.md
 */
import { createServer } from "node:http";
import { openRuntime } from "../runtime.mjs";
import { createRuntimeCache } from "./cache.mjs";
import { HEALTH_PATH, HOOK_PATH, STOP_PATH } from "./constants.mjs";
import {
	acquireDaemonLock,
	clearPidFile,
	codeStamp,
	daemonScript,
	healthRequest,
	releaseDaemonLock,
	runtimeHost,
	runtimePort,
	stampDaemonLock,
	writePidFile,
} from "./lifecycle.mjs";
import { createRuntimeTelemetry } from "./telemetry.mjs";
import { cachedOpenRuntime } from "./open-runtime-cache.mjs";
import { dispatchHook } from "./hook-dispatch.mjs";
import { startHookPipeServer } from "./hook-pipe.mjs";

const openForProject = (root) => cachedOpenRuntime(root, openRuntime);

const cache = createRuntimeCache();
const telem = createRuntimeTelemetry();
const host = runtimeHost();
const port = runtimePort();
/** Port we actually hold — differs from `port` when a foreign listener forced the fallback. */
let boundPort = port;

// Bound nothing until the machine lock is ours: a second runtime is a liability, not a
// redundancy. Port collision cannot decide this alone — when a foreign listener holds the
// preferred port, late daemons all settle on ephemeral ones and keep serving old handlers.
const lock = await acquireDaemonLock();
if (!lock.ok) {
	telem.fail({ path: "startup", message: `daemon lock held by pid ${lock.pid ?? "?"} (${lock.reason})` });
	process.exit(0);
}
process.on("exit", releaseDaemonLock);
/** Fingerprint of lib/ as it was when this process loaded — lets a restart detect superseded code. */
const CODE_STAMP = codeStamp();

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	const url = req.url?.split("?")[0] ?? "";
	const jsonHead = (status, bodyStr, keepAlive = true) => {
		const headers = {
			"content-type": "application/json",
			"Content-Length": Buffer.byteLength(bodyStr, "utf8"),
		};
		if (keepAlive) headers.Connection = "keep-alive";
		res.writeHead(status, headers);
		res.end(bodyStr);
	};
	try {
		if (req.method === "GET" && url === HEALTH_PATH) {
			// `script` is the daemon's identity: an install that loaded different code must not
			// be served by a process that still has the old handlers in memory.
			const bodyStr = JSON.stringify({
				ok: true,
				v: 1,
				port: boundPort,
				script: daemonScript(),
				stamp: CODE_STAMP,
				telem: telem.snapshot(),
				cache: cache.stats(),
			});
			jsonHead(200, bodyStr);
			return;
		}
		if (req.method === "POST" && url === STOP_PATH) {
			const stopBody = JSON.stringify({ ok: true });
			jsonHead(200, stopBody, false);
			setImmediate(() => {
				server.close(() => {
					clearPidFile();
					process.exit(0);
				});
			});
			return;
		}
		if (req.method === "POST" && url === HOOK_PATH) {
			const raw = await readBody(req);
			const body = JSON.parse(raw || "{}");
			try {
				const bodyStr = await dispatchHook(body, { openRuntime: openForProject, telem });
				jsonHead(200, bodyStr, false);
			} catch {
				const errBody = JSON.stringify({ error: "unknown phase" });
				jsonHead(400, errBody, false);
			}
			return;
		}
		res.writeHead(404);
		res.end();
	} catch (err) {
		telem.fail({ path: url, message: err?.message ?? String(err) });
		const errBody = JSON.stringify({ error: err?.message ?? "internal" });
		jsonHead(500, errBody, false);
	}
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const pipeServer = startHookPipeServer(
	(body) => dispatchHook(body, { openRuntime: openForProject, telem }),
	{
		onError: (err) => {
			// Another runtime owns the machine-global pipe. Degrade to HTTP-only rather than dying.
			telem.fail({ path: "pipe", message: err?.message ?? String(err) });
		},
	},
);

/**
 * Bind the preferred port, falling back to an OS-assigned one when it is taken.
 * A foreign listener on the preferred port (the Brain dashboard also uses 18787) must
 * not be fatal — the pid file records the real port and clients resolve it from there.
 */
function listenAndReport(portToTry) {
	const onError = (err) => {
		if (err?.code === "EADDRINUSE" && portToTry !== 0) {
			server.off("error", onError);
			// Two shapes collide on a bound port. A foreign listener (the Brain dashboard also
			// uses 18787) must not be fatal, so we move to an ephemeral port. A live TokenMind
			// runtime does: staying up here is how one machine quietly accumulates daemons,
			// each serving hooks from its own copy of the code while the pid file names only
			// the last writer, so an upgrade never reaches the processes that matter.
			healthRequest({ host, port: portToTry }).then((h) => {
				if (h?.ok) process.exit(0);
				listenAndReport(0);
			});
			return;
		}
		telem.fail({ path: "listen", message: err?.message ?? String(err) });
		process.exit(1);
	};
	server.once("error", onError);
	server.listen(portToTry, host, () => {
		server.off("error", onError);
		boundPort = server.address()?.port ?? portToTry;
		stampDaemonLock(boundPort);
		writePidFile({
			startedAt: new Date().toISOString(),
			hookPipe: process.platform === "win32",
			port: boundPort,
			script: daemonScript(),
			stamp: CODE_STAMP,
		});
	});
}

listenAndReport(port);

process.on("SIGINT", () => {
	pipeServer?.close();

	server.close(() => {
		clearPidFile();
		process.exit(0);
	});
});
