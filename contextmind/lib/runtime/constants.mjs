/** TokenMind Runtime constants. One daemon per machine. */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18787;
export const HEALTH_PATH = "/health";
export const HOOK_PATH = "/hook";
export const STOP_PATH = "/stop";
export const MINIMAL_CAP_BYTES = 32_768;
/** Hard cap per hang doc §5.1 — slow hook = fail-open allow */
export const RPC_TIMEOUT_MS = 500;
export const RPC_RETRY_TIMEOUT_MS = 400;
/** Hang doc P0: wall-clock tax ≤500ms then fail-open allow */
export const HOOK_PROCESS_EXIT_MS = 500;
export const HEALTH_TIMEOUT_MS = 250;
export const START_WAIT_MS = 4_000;
export const PID_DIR_NAME = ".tokenmind";
export const PID_FILE_NAME = "runtime.json";
