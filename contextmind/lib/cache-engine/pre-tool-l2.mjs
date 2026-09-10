/** Deny identical context_* MCP calls when L2 tool cache already has output. */

export function tryDenyL2ToolCache({ rt, projectRoot, sessionId, innerMcp, innerArgs, record, deny }) {
	if (!rt?.cacheEngine?.cfg?.toolCachePreDeny) return;
	const project_id = rt.cfg?.brain?.project_id ?? "";
	const hit = rt.cacheEngine.lookupTool(projectRoot, {
		project_id,
		tool_name: innerMcp,
		args: innerArgs ?? {},
	});
	if (hit.hit) {
		record?.({ sessionId, tool: innerMcp, cache_key: hit.cache_key });
		deny?.();
	}
}
