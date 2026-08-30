// Vendored stub — replaces work-mind's pino logger (src/observability/logger.mjs)
// so the forge tree stays dependency-free. Same call surface: logger.debug/info/
// warn/error(obj|msg, [msg]).
const noop = () => {};
function emit(level, args) {
	if (process.env.FORGE_LOG === "1" || level === "error") {
		console.error(`[forge:${level}]`, ...args);
	}
}
export const logger = {
	debug: (...a) => emit("debug", a),
	info: (...a) => emit("info", a),
	warn: (...a) => emit("warn", a),
	error: (...a) => emit("error", a),
	child: () => logger,
	level: "silent",
};
