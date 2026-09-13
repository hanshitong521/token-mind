import { governMcpOutput } from "../mcp-guard.mjs";
import { runEvidenceGate } from "../evidence/gate.mjs";

export function governMcp({ toolOutput, toolName, cfg, rt, sessionId }) {
	return governMcpOutput({
		toolOutput,
		toolName,
		cfg,
		runGate: (args) =>
			runEvidenceGate({
				...args,
				sessionId,
				source: toolName,
				cfg: rt.cfg,
				handles: rt.handles,
				dedup: rt.dedup,
			}),
	});
}
