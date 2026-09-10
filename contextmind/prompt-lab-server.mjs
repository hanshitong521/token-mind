#!/usr/bin/env node
/**
 * Prompt Lab server (spec §31/§32/§33/§35; ADR-0009 static-HTML + ADR-0012 D4).
 *
 * Zero-dependency `node:http` server that serves one static page
 * (prompt-lab.html) and the §35 /promptLab/* JSON API against a WRITABLE
 * prompt-lab.db (unlike the read-only dashboard). Every analyze/optimize
 * persists a version (spec §56) so History is real data.
 *
 *   node contextmind/prompt-lab-server.mjs [projectRoot] [--port 8898]
 *
 * --port 0 asks the OS for a free port (used by the smoke test); the actual
 * URL is printed on startup.
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { PromptLabStore } from "./lib/prompt-lab/store.mjs";
import * as API from "./lib/prompt-lab/api.mjs";
import { PROMPT_LAB_SCHEMA_VERSION } from "./lib/db/prompt-lab-schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "prompt-lab.html"), "utf8");

// ─── args ───
function parse(argv) {
	const out = { projectRoot: null, port: 8898 };
	const rest = [...argv];
	const portIdx = rest.indexOf("--port");
	if (portIdx >= 0) {
		out.port = Number(rest[portIdx + 1] ?? out.port);
		rest.splice(portIdx, 2);
	}
	if (rest[0]) out.projectRoot = resolve(rest[0]);
	if (!out.projectRoot) out.projectRoot = process.env.CONTEXTMIND_PROJECT_DIR ?? process.cwd();
	return out;
}

const { projectRoot, port: requestedPort } = parse(process.argv.slice(2));

const dbDir = join(projectRoot, ".contextmind");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "prompt-lab.db");
const store = new PromptLabStore(new DatabaseSync(dbPath));

// ─── body / json helpers ───
function readJsonBody(req, limit = 8 * 1024 * 1024) {
	return new Promise((resolveBody, rejectBody) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				rejectBody(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			try {
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (e) {
				rejectBody(e);
			}
		});
		req.on("error", rejectBody);
	});
}

function sendJson(res, status, obj) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(obj));
}

const ROUTES = Object.freeze({
	"/promptLab/import": API.routeImport,
	"/promptLab/analyze": API.routeAnalyze,
	"/promptLab/optimize": API.routeOptimize,
	"/promptLab/diff": API.routeDiff,
	"/promptLab/fingerprint": API.routeFingerprint,
	"/promptLab/tokenize": API.routeTokenize,
	"/promptLab/layout": API.routeLayout,
	"/promptLab/evaluate": API.routeEvaluate,
	"/promptLab/export": API.routeExport,
	"/promptLab/history/list": API.routeHistoryList,
	"/promptLab/history/detail": API.routeHistoryDetail,
	"/promptLab/patch/apply": API.routePatchApply,
	"/promptLab/patch/reverse": API.routePatchReverse,
	"/promptLab/semantic/confirm": API.routeConfirmSemantic,
	"/promptLab/info": API.routeLabInfo,
});

// ─── server ───
const server = createServer(async (req, res) => {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const path = url.pathname.replace(/\/+$/, "") || "/";

	if ((path === "/" || path === "/prompt-lab") && req.method === "GET") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(HTML);
		return;
	}
	if (path === "/api/nav") {
		sendJson(res, 200, {
			token_dashboard: "/dashboard",
			mcp_lab: "/mcp-lab",
			prompt_lab: "/prompt-lab",
		});
		return;
	}
	if (path === "/promptLab/provider/capabilities" && req.method === "GET") {
		sendJson(res, 200, API.routeProviderCapabilities(store));
		return;
	}

	const handler = ROUTES[path];
	if (handler && req.method === "POST") {
		try {
			const body = await readJsonBody(req);
			const out = await handler(store, body ?? {});
			sendJson(res, out?.ok === false && out?.error ? 400 : 200, out);
		} catch (err) {
			sendJson(res, 400, { ok: false, error: String(err?.message ?? err) });
		}
		return;
	}

	sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(requestedPort, "127.0.0.1", () => {
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : requestedPort;
	console.log(`Prompt Lab — http://127.0.0.1:${port}/prompt-lab`);
	console.log(`  project: ${projectRoot}`);
	console.log(`  db:      ${dbPath} (writable, schema v${PROMPT_LAB_SCHEMA_VERSION})`);
	console.log("  Ctrl+C to stop");
});
