import { evaluateRead } from "../read-guard.mjs";
import { forbiddenAgentScanPath } from "../path-guards.mjs";

export function evaluateReadAdapter(args) {
	return evaluateRead(args);
}

export function forbiddenRead(path) {
	return forbiddenAgentScanPath(path);
}
