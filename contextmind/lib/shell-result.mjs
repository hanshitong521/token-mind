/**
 * Parse Shell tool output for process exit code (Cursor / IDE variants).
 */

export function parseShellExitCode(toolOutput) {
	if (toolOutput === undefined || toolOutput === null) return null;
	if (typeof toolOutput === "object" && !Array.isArray(toolOutput)) {
		const direct =
			toolOutput.exitCode ??
			toolOutput.exit_code ??
			toolOutput.code ??
			toolOutput.statusCode;
		if (typeof direct === "number" && Number.isFinite(direct)) return direct;
		if (typeof direct === "string" && /^\d+$/.test(direct)) return Number(direct);
	}
	const text = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
	const patterns = [
		/\bexit[_\s-]?code[:\s]+(\d+)/i,
		/"exit_code"\s*:\s*(\d+)/,
		/"exitCode"\s*:\s*(\d+)/,
		/Last exit code:\s*(\d+)/i,
		/\nexit_code:\s*(\d+)/m,
	];
	for (const p of patterns) {
		const m = text.match(p);
		if (m) return Number(m[1]);
	}
	return null;
}

export function shellSucceeded(exitCode) {
	return exitCode === 0;
}
