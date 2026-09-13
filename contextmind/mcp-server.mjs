#!/usr/bin/env node
/**
 * ContextMind MCP server (S4, decision 5C / ADR-0004).
 *
 * Exposes exactly six tools (spec 9) over stdio JSON-RPC. This is a
 * hand-rolled ~120-line loop rather than the MCP SDK: the protocol surface we
 * commit to is initialize / notifications / ping / tools/list / tools/call,
 * and pulling in the SDK plus zod for five methods would be the first npm
 * dependency in a zero-dependency layer (ADR-0001/0004). Protocol drift is
 * covered by the L4 contract test that drives this file as a real subprocess.
 *
 * The process is long-lived (Cursor keeps MCP servers alive), so unlike the
 * hooks we open the runtime once and close it on exit.
 */

import { SERVER_NAME, SERVER_VERSION, callTool, toolSpecs } from "./lib/mcp-tools.mjs";
import { hostFromClientInfo } from "./lib/hosts.mjs";
import { openRuntime } from "./lib/runtime.mjs";

const projectRoot = process.env.CONTEXTMIND_PROJECT_DIR ?? process.cwd();
const rt = openRuntime(projectRoot);
process.on("exit", () => rt.close());

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(msg) {
	// stdout belongs to the protocol; diagnostics on stderr never corrupt a frame.
	process.stderr.write(`[contextmind-mcp] ${msg}\n`);
}

async function handleMessage(msg) {
	const { id, method, params } = msg ?? {};
	if (typeof method !== "string") return; // a response or garbage — nothing to answer
	if (method.startsWith("notifications/")) return;

	switch (method) {
		case "initialize": {
			// Each host spawns its own MCP server process, so one handshake per
			// process is the whole story: stamp it before any tools/call lands.
			const caller = hostFromClientInfo(params?.clientInfo?.name);
			if (caller) rt.mcpHost = caller;
			send({
				jsonrpc: "2.0",
				id,
				result: {
					// Echo the client's version when offered; that is the handshake
					// the spec asks of a server, and Cursor sends a known one.
					protocolVersion: params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				},
			});
			return;
		}
		case "ping":
			send({ jsonrpc: "2.0", id, result: {} });
			return;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: toolSpecs() } });
			return;
		case "tools/call": {
			const name = params?.name;
			if (typeof name !== "string") {
				send({ jsonrpc: "2.0", id, error: { code: -32602, message: "params.name is required" } });
				return;
			}
			const result = await callTool(name, params?.arguments ?? {}, rt);
			send({ jsonrpc: "2.0", id, result });
			return;
		}
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			log(`unparseable frame (${line.length} chars) ignored`);
			continue;
		}
		handleMessage(msg).catch((err) => {
			const { id } = msg ?? {};
			send({
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
			});
		});
	}
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
