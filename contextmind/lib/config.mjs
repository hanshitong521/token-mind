/**
 * Single configuration source.
 *
 * spec 26 shows YAML, but YAML is an *example* format there and spec 29.6
 * forbids duplicate config sources. The engine this layer drives
 * (context-compress) already reads `~/.context-compress.json` +
 * `<project>/.context-compress.json`, and adding a YAML parser would mean a new
 * runtime dependency plus a second file a reader has to reconcile. One JSON
 * file, same two-scope layering as the engine. Deviation recorded in
 * docs/decisions/ADR-0002-config-format-json.md.
 *
 * Layering: env > project file > user file > defaults.
 * A project file travels with the repo, so keys that decide where data is
 * written or how long it is kept are user-scope-only, exactly as the engine
 * does it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./llm-profile.mjs";
import { applyPeakCacheEngine } from "./cache-engine/peak-profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const CONTEXTMIND_ROOT = resolve(HERE, "..");

/** Repo / package anchor (`.cursor` in a project, or `cursor` in Token-Mind). */
export const REPO_ROOT = resolve(HERE, "..", "..");

export function resolveHooksDir(cmRoot = CONTEXTMIND_ROOT) {
	const tries = [
		join(cmRoot, "..", "hooks"),
		join(cmRoot, "hooks"),
		join(resolve(cmRoot, ".."), "cursor", "hooks"),
		join(resolve(cmRoot, "..", ".."), "cursor", "hooks"),
	];
	for (const d of tries) {
		if (existsSync(join(d, "cm-lib.mjs"))) return resolve(d);
	}
	return resolve(cmRoot, "..", "hooks");
}

export function resolveAssetsDir(cmRoot = CONTEXTMIND_ROOT) {
	const hooks = resolveHooksDir(cmRoot);
	const parent = resolve(hooks, "..");
	if (existsSync(join(parent, "rules", "contextmind.mdc"))) return parent;
	const cursorUnderRepo = join(REPO_ROOT, "cursor");
	if (existsSync(join(cursorUnderRepo, "rules", "contextmind.mdc"))) return cursorUnderRepo;
	return parent;
}

function engineCliPathUnder(root) {
	return join(root, "dist", "cli", "index.js");
}

function readInstallSourceRepo() {
	try {
		const manifestPath = join(REPO_ROOT, "contextmind-manifest.json");
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		return typeof parsed.source_repo === "string" ? resolve(parsed.source_repo) : null;
	} catch {
		return null;
	}
}

function resolveEngineRoot() {
	const candidates = [];
	if (process.env.CONTEXTMIND_ENGINE_ROOT) {
		candidates.push(resolve(process.env.CONTEXTMIND_ENGINE_ROOT));
	}
	candidates.push(join(REPO_ROOT, "context-compress-main"));
	const src =
		(process.env.CONTEXTMIND_SOURCE_REPO ? resolve(process.env.CONTEXTMIND_SOURCE_REPO) : null) ??
		readInstallSourceRepo();
	if (src) candidates.push(join(src, "context-compress-main"));
	for (const root of candidates) {
		if (existsSync(engineCliPathUnder(root))) return root;
	}
	return join(REPO_ROOT, "context-compress-main");
}

/** Where the vendored context-compress engine lives. */
export const ENGINE_ROOT = resolveEngineRoot();

const HOME_CONFIG = join(homedir(), ".contextmind.json");
const PROJECT_CONFIG_NAME = ".contextmind.json";

export const DEFAULTS = {
	project_root: null,
	mode: "balanced",

	engine: {
		mode: "balanced",
	},

	budget: {
		orient: 800,
		find: 1000,
		get: 1600,
		impact: 1200,
		shell_success: 800,
		shell_failure: 1600,
		mcp_default: 1200,
		mcp_error: 1800,
		always_rules: 400,
		mcp_schema_total: 2500,
	},

	shell: {
		// Locked by bench/shell_owner_retest.md + docs/evidence/SHELL_FIRST_LAYER_AB.md.
		// "cc_balanced" and "rtk" are the only accepted values; anything else is a
		// config error, not a silent fallthrough to something else.
		first_layer: "cc_balanced",
		enabled: true,
	},

	read_guard: {
		enabled: true,
		max_unbounded_lines: 400,
		max_unbounded_bytes: 65536,
		java_service_unbounded_lines: 80,
		mapper_xml: "statement_slice",
		denylist: ["*.min.js", "*.min.css", "*.map", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
	},

	mcp_guard: {
		enabled: true,
		/** When true, large codegraph_explore payloads are handleized instead of passed raw. */
		govern_codegraph: false,
		profiles: {
			mysql_query: { max_tokens: 1400, preserve: ["columns", "row_count", "errors"], body: "handle" },
			semantic_search: { max_tokens: 1400, preserve: ["paths", "scores"], body: "handle" },
			get_evidence: { max_tokens: 1400, preserve: ["paths"], body: "handle" },
			codegraph_explore: { max_tokens: 1600, preserve: ["paths", "symbols"], body: "count_as_read" },
		},
	},

	handles: {
		enabled: true,
		ttl_hours: 12,
		max_disk_mb: 1024,
	},

	telemetry: {
		enabled: true,
		local_only: true,
		db: null,
	},

	adapters: {
		codegraph: { enabled: true, probe_tools: true, servers: ["codegraph"], bin: "codegraph" },
		mysql: { enabled: true, servers: ["ads-mysql"] },
	},

	/** Bounded fetch unless the caller opts into raw. Selector cannot exceed these. */
	fetch: {
		default_lines: 80,
		max_tokens: 1200,
		allow_full: false,
	},

	/** TaskBundle v1 — optional task scope + session preamble (SDLC context layer). */
	sdlc: {
		enabled: true,
		task_file: ".contextmind/task.active.json",
		enforce_allow: true,
		/** When true, Write/StrReplace on *.java without TaskBundle/waiver is denied. */
		enforce_write_bundle: false,
		execution_log: ".contextmind/execution.jsonl",
		preamble_max_tokens: null,
		sync_agent_state: true,
		/** Inject StackRoute + AgentManifest into sessionStart. */
		inject_route: true,
		inject_manifest: true,
	},
	memory: {
		episodic_enabled: true,
		episodic_file: ".contextmind/memory/episodic.jsonl",
		vector_backend: "episodic",
	},
	/** Project Brain — optional session-end memory (fixtures + JSONL). */
	brain: {
		project_id: "",
		auto_record_on_session_end: false,
		python: "",
	},
	cache: {
		enabled: true,
		backend: "auto",
		ttl_sec: 600,
		mem_max: 256,
		redis_url: "",
	},
	cache_engine: {
		promptCache: true,
		contextCache: true,
		toolCache: true,
		sessionDelta: true,
		semanticCache: false,
		compression: false,
		brainSync: false,
		brainSyncOnStop: false,
		stablePrefix: true,
		stablePrefixMode: "always",
		stablePrefixMaxTokens: 220,
		stablePrefixTrimRules: false,
		toolCachePreDeny: false,
		orientSkipTokensEstimate: 364,
		peak: false,
		kvIntegration: false,
		kvUrl: "",
	},

	/**
	 * Optional APIs. "none" keeps CodeGraph/gate off the network (default).
	 * Keys come from ~/.contextmind/profile.json env, not this file.
	 */
	providers: {
		chat: "none",
		embed: "none",
	},
};

/**
 * Keys a project-local .contextmind.json may not set. A project file arrives
 * with untrusted code, and these decide where raw tool output is written and
 * how long it is retained.
 */
export const USER_SCOPE_ONLY_KEYS = ["handles", "telemetry", "cache"];

function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge; plain objects recurse, everything else replaces. */
function merge(base, override) {
	const out = { ...base };
	for (const [k, v] of Object.entries(override)) {
		out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
	}
	return out;
}

/**
 * Validate against DEFAULTS: unknown keys are rejected, wrong types are
 * rejected, and every rejection names the file. Dropping a typo silently is
 * what makes a config file that looks right and does nothing.
 */
export function validateConfig(raw, source) {
	const problems = [];
	const check = (value, defaults, path) => {
		if (!isPlainObject(value)) {
			problems.push(`${path || "(root)"}: expected an object`);
			return;
		}
		for (const [k, v] of Object.entries(value)) {
			const dflt = defaults[k];
			const p = path ? `${path}.${k}` : k;
			if (dflt === undefined) {
				problems.push(`${p}: unknown key`);
				continue;
			}
			if (isPlainObject(dflt) && !Array.isArray(dflt)) {
				if (isPlainObject(v)) check(v, dflt, p);
				else problems.push(`${p}: expected an object`);
				continue;
			}
			const expected = Array.isArray(dflt) ? "array" : typeof dflt;
			const actual = Array.isArray(v) ? "array" : typeof v;
			if (actual !== expected) problems.push(`${p}: expected ${expected}, got ${actual}`);
		}
	};
	check(raw, DEFAULTS, "");
	if (problems.length > 0) {
		console.error(
			`[contextmind] Config: ignoring ${source} — ${problems.join("; ")}`,
		);
		return null;
	}
	return raw;
}

function readConfigFile(path, scope) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {}; // Absent is the normal case.
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.error(
			`[contextmind] Config: ignoring ${path} — invalid JSON (${err instanceof Error ? err.message : String(err)})`,
		);
		return {};
	}
	const valid = validateConfig(parsed, path);
	if (!valid) return {};
	if (scope === "project") {
		for (const key of USER_SCOPE_ONLY_KEYS) {
			if (valid[key] === undefined) continue;
			delete valid[key];
			console.error(
				`[contextmind] Config: ignoring "${key}" from ${path} — only honored from ${HOME_CONFIG} or the environment.`,
			);
		}
	}
	return valid;
}

const ENV_OVERRIDES = {
	CONTEXTMIND_MODE: (c, v) => {
		c.mode = v;
	},
	CONTEXTMIND_SHELL_FIRST_LAYER: (c, v) => {
		c.shell = { ...c.shell, first_layer: v };
	},
	CONTEXTMIND_PROJECT_ROOT: (c, v) => {
		c.project_root = v;
	},
	CONTEXTMIND_TELEMETRY_DB: (c, v) => {
		c.telemetry = { ...c.telemetry, db: v };
	},
	CONTEXTMIND_REDIS_URL: (c, v) => {
		c.cache = { ...c.cache, redis_url: v };
	},
	REDIS_URL: (c, v) => {
		if (!c.cache.redis_url) c.cache = { ...c.cache, redis_url: v };
	},
	CONTEXTMIND_KV_BRIDGE_URL: (c, v) => {
		if (!c.cache_engine) c.cache_engine = {};
		if (!c.cache_engine.kvUrl) c.cache_engine = { ...c.cache_engine, kvUrl: v };
	},
};

function applyEnv(cfg) {
	for (const [key, apply] of Object.entries(ENV_OVERRIDES)) {
		const v = process.env[key];
		if (v !== undefined && v !== "") apply(cfg, v);
	}
	if (process.env.CONTEXTMIND_TELEMETRY === "0") {
		cfg.telemetry = { ...cfg.telemetry, enabled: false };
	}
	if (process.env.CONTEXTMIND_HANDLES === "0") {
		cfg.handles = { ...cfg.handles, enabled: false };
	}
	if (process.env.CONTEXTMIND_CACHE === "0") {
		cfg.cache = { ...cfg.cache, enabled: false };
	}
	if (process.env.CONTEXTMIND_CACHE_TTL_SEC) {
		const n = Number(process.env.CONTEXTMIND_CACHE_TTL_SEC);
		if (Number.isFinite(n) && n > 0) cfg.cache = { ...cfg.cache, ttl_sec: n };
	}
	if (process.env.CONTEXTMIND_CHAT_PROVIDER) {
		cfg.providers = { ...cfg.providers, chat: process.env.CONTEXTMIND_CHAT_PROVIDER };
	}
	if (process.env.CONTEXTMIND_EMBED_PROVIDER) {
		cfg.providers = { ...cfg.providers, embed: process.env.CONTEXTMIND_EMBED_PROVIDER };
	}
	return cfg;
}

const SUPPORTED_FIRST_LAYERS = new Set(["cc_balanced", "rtk", "none"]);

/**
 * Load config. `projectDir` defaults to the process cwd, which is what a
 * Cursor hook inherits.
 *
 * `userPath` is a seam for tests: the real `~/.contextmind.json` belongs to the
 * developer, so a test that needs to assert layering must be able to say "there
 * is no user config" without touching it.
 */
export function loadConfigFrom(userPath, projectDir) {
	const user = readConfigFile(userPath, "user");
	const project = readConfigFile(join(projectDir, PROJECT_CONFIG_NAME), "project");
	let cfg = merge(merge(structuredClone(DEFAULTS), user), project);
	cfg = applyEnv(cfg);

	if (!SUPPORTED_FIRST_LAYERS.has(cfg.shell.first_layer)) {
		console.error(
			`[contextmind] Config: shell.first_layer="${cfg.shell.first_layer}" is not supported ` +
				`(expected one of ${[...SUPPORTED_FIRST_LAYERS].join(", ")}); using cc_balanced.`,
		);
		cfg.shell.first_layer = "cc_balanced";
	}
	if (process.env.CONTEXTMIND_CACHE_PEAK === "1") {
		cfg.cache_engine = { ...cfg.cache_engine, peak: true };
	}
	if (cfg.cache_engine?.peak || cfg.cache_engine?.peakMode === true) {
		cfg.cache_engine = applyPeakCacheEngine(cfg.cache_engine);
	}
	if (!cfg.project_root) cfg.project_root = projectDir;
	return cfg;
}

export function loadConfig(projectDir = process.cwd()) {
	return loadConfigFrom(HOME_CONFIG, projectDir);
}

let cached = null;
let cachedKey = null;

/** Process-wide cached config. Hooks run per tool call; re-reading files each time is waste. */
export function getConfig(projectDir = process.cwd()) {
	if (cached && cachedKey === projectDir) return cached;
	cached = loadConfig(projectDir);
	cachedKey = projectDir;
	return cached;
}

export function resetConfig() {
	cached = null;
	cachedKey = null;
}

/** Paths the CLI and doctor report on, so "where is my config" is answerable. */
export function configPaths(projectDir = process.cwd()) {
	return {
		user: HOME_CONFIG,
		project: join(projectDir, PROJECT_CONFIG_NAME),
	};
}
