import { handlePreTool } from "./pre-handler.mjs";
import { handlePostTool } from "./post-handler.mjs";

/** Shared HTTP + named-pipe hook handler. */
export async function dispatchHook(body, { openRuntime, telem }) {
	const phase = body.phase;
	const input = body.input ?? {};
	const t0 = performance.now();
	let out = {};
	if (phase === "pre") {
		out = await handlePreTool(input, { openRuntime });
	} else if (phase === "post") {
		out = await handlePostTool(input, { openRuntime });
	} else {
		throw new Error("unknown phase");
	}
	const rpcMs = Math.round(performance.now() - t0);
	telem.inc("rpc_ok");
	telem.record?.({ surface: "runtime", note: `hook_rpc_ms:${rpcMs}`, gateLatencyMs: rpcMs });
	return JSON.stringify(out);
}
