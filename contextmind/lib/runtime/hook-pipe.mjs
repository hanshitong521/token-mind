/**
 * Windows named pipe for cmhook → Runtime (S2).
 * Framing: u32 LE length + UTF-8 JSON (request and response). No half-close needed.
 */
import { createServer } from "node:net";
import { HOOK_PIPE_PATH } from "./constants.mjs";

const MAX_FRAME = 8 * 1024 * 1024;

function readFrame(socket) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const onData = (c) => {
			chunks.push(c);
			const buf = Buffer.concat(chunks);
			if (buf.length < 4) return;
			const len = buf.readUInt32LE(0);
			if (len > MAX_FRAME) {
				cleanup();
				reject(new Error("pipe frame too large"));
				return;
			}
			if (buf.length < 4 + len) return;
			cleanup();
			resolve(buf.subarray(4, 4 + len).toString("utf8"));
		};
		const onError = (err) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
		};
		socket.on("data", onData);
		socket.on("error", onError);
	});
}

function writeFrame(socket, text) {
	const body = Buffer.from(text, "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	socket.write(Buffer.concat([head, body]));
}

export function startHookPipeServer(onRequest, { onError } = {}) {
	if (process.platform !== "win32") return null;
	const server = createServer((socket) => {
		void (async () => {
			try {
				const raw = await readFrame(socket);
				const body = JSON.parse(raw || "{}");
				const bodyStr = await onRequest(body);
				writeFrame(socket, bodyStr);
			} catch (err) {
				try {
					writeFrame(socket, JSON.stringify({ error: err?.message ?? String(err) }));
				} catch {
					/* ignore */
				}
			} finally {
				socket.end();
			}
		})();
	});
	// The pipe path is machine-global, so another runtime may already own it. That must not
	// be fatal: without this handler Node throws the 'error' event and the daemon dies
	// before binding HTTP, leaving every hook in minimal mode.
	server.on("error", (err) => {
		onError?.(err);
	});
	server.listen(HOOK_PIPE_PATH);
	return server;
}
