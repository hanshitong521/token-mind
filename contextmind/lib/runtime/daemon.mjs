#!/usr/bin/env node
/**
 * TokenMind Runtime — one process per machine, localhost HTTP.
 */
import { createServer } from "node:http";
import { openRuntime } from "../runtime.mjs";
import { createRuntimeCache } from "./cache.mjs";
import { HEALTH_PATH, HOOK_PATH, STOP_PATH } from "./constants.mjs";
import { clearPidFile, runtimeHost, runtimePort, writePidFile } from "./lifecycle.mjs";
import { createRuntimeTelemetry } from "./telemetry.mjs";
import { cachedOpenRuntime } from "./open-runtime-cache.mjs";
import { handlePreTool } from "./pre-handler.mjs";
import { handlePostTool } from "./post-handler.mjs";

const openForProject = (root) => cachedOpenRuntime(root, openRuntime);

const cache = createRuntimeCache();
const telem = createRuntimeTelemetry();
const host = runtimeHost();
const port = runtimePort();

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
	try {
		if (req.method === "GET" && url === HEALTH_PATH) {
			const bodyStr = JSON.stringify({ ok: true, v: 1, telem: telem.snapshot(), cache: cache.stats() });
			res.writeHead(200, {
				"content-type": "application/json",
				"Content-Length": Buffer.byteLength(bodyStr, "utf8"),
				Connection: "close",
			});
			res.end(bodyStr);
			return;
		}
		if (req.method === "POST" && url === STOP_PATH) {
			const stopBody = JSON.stringify({ ok: true });
			res.writeHead(200, {
				"content-type": "application/json",
				"Content-Length": Buffer.byteLength(stopBody, "utf8"),
				Connection: "close",
			});
			res.end(stopBody);
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
			const phase = body.phase;
			const input = body.input ?? {};
			const t0 = performance.now();
			let out = {};
			if (phase === "pre") {
				out = await handlePreTool(input, { openRuntime: openForProject });
			} else if (phase === "post") {
				out = await handlePostTool(input, { openRuntime: openForProject });
			} else {
				const errBody = JSON.stringify({ error: "unknown phase" });
				res.writeHead(400, {
					"content-type": "application/json",
					"Content-Length": Buffer.byteLength(errBody, "utf8"),
					Connection: "close",
				});
				res.end(errBody);
				return;
			}
			telem.inc("rpc_ok");
			const rpcMs = Math.round(performance.now() - t0);
			telem.record?.({ surface: "runtime", note: `hook_rpc_ms:${rpcMs}`, gateLatencyMs: rpcMs });
			const bodyStr = JSON.stringify(out);
			res.writeHead(200, {
				"content-type": "application/json",
				"Content-Length": Buffer.byteLength(bodyStr, "utf8"),
				Connection: "close",
			});
			res.end(bodyStr);
			return;
		}
		res.writeHead(404);
		res.end();
	} catch (err) {
		telem.fail({ path: url, message: err?.message ?? String(err) });
		const errBody = JSON.stringify({ error: err?.message ?? "internal" });
		res.writeHead(500, {
			"content-type": "application/json",
			"Content-Length": Buffer.byteLength(errBody, "utf8"),
			Connection: "close",
		});
		res.end(errBody);
	}
});

server.listen(port, host, () => {
	writePidFile({ startedAt: new Date().toISOString() });
});

process.on("SIGINT", () => {
	server.close(() => {
		clearPidFile();
		process.exit(0);
	});
});
