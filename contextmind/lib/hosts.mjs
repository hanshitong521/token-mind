/**
 * Host registry loader — the only module allowed to know what hosts exist.
 *
 * WHY a data file (hosts.json) instead of a per-host branch in code: every host
 * added so far (Cursor → Qoder) was paid for in six places — installer targets,
 * event-name maps, envelope shapes, detection heuristics, telemetry defaults and
 * dashboard tabs — and each one is a place a third host gets silently mislabelled
 * or dropped. The registry collapses that into: add a profile, set verified:true.
 *
 * `verified` is load-bearing, not decorative. An unverified profile keeps showing
 * up in `doctor` and in the ledger's host list, but install refuses to write its
 * config paths, because a guessed path installs governance that never runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Registry locations, first hit wins: override → beside this module → deployed copy. */
const CANDIDATES = [
	process.env.CONTEXTMIND_HOSTS_FILE,
	join(HERE, "..", "hosts.json"),
	join(HERE, "hosts.json"),
].filter(Boolean);

/** @type {{version:number, hosts:any[]}|null} */
let doc = null;
let loadedFrom = "";

function readRegistry() {
	if (doc) return doc;
	for (const path of CANDIDATES) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (Array.isArray(parsed?.hosts)) {
				doc = parsed;
				loadedFrom = resolve(path);
				return doc;
			}
			process.stderr.write(`[contextmind] hosts.json has no hosts[]: ${path}\n`);
		} catch (err) {
			// A broken override must not blind the layer, but it must not be silent
			// either: with an empty registry every row lands in `unknown` and the
			// per-host dashboards read as dead while nothing is reporting wrong.
			process.stderr.write(`[contextmind] hosts.json unreadable (${path}): ${err.message}\n`);
		}
	}
	doc = { version: 0, hosts: [] };
	loadedFrom = "";
	return doc;
}

/** Every profile, including unverified ones (the dashboards must still be able to say their name). */
export function hostProfiles() {
	return readRegistry().hosts;
}

export function registryPath() {
	readRegistry();
	return loadedFrom;
}

/** @returns {any|null} */
export function profileFor(hostId) {
	const id = String(hostId ?? "").toLowerCase();
	return hostProfiles().find((h) => h.id === id) ?? null;
}

/** Host ids this layer can recognise in telemetry — the ids the ledger's `host` column may hold. */
export function hostIds() {
	return hostProfiles().map((h) => h.id);
}

/** Profiles whose install targets have been checked against a real install. */
export function verifiedProfiles() {
	return hostProfiles().filter((h) => h.verified === true);
}

export function supports(profile, capability) {
	return Boolean(profile?.capabilities?.[capability]);
}

/** Hosts with a working hook path — used by doctor and by the latency panels. */
export function hookCapableHosts() {
	return hostProfiles().filter((h) => supports(h, "hooks"));
}

/** Hosts where only the MCP surface can be governed; their hook-side metrics are absent, not zero. */
export function mcpOnlyHosts() {
	return hostProfiles().filter((h) => !supports(h, "hooks") && supports(h, "mcp"));
}

/**
 * Resolve where a host keeps a piece of config.
 *
 * `scope: "project"` is relative to the repo being governed; `"user"` is relative
 * to the home directory — that is the whole difference between Cursor (a project
 * `.cursor/mcp.json`) and Qoder (MCP only in the machine-wide
 * `~/.qoder-cn/settings.json`), which is why the installer used to be Cursor-only.
 */
export function resolveConfigFile(target, { projectRoot, home = homedir() } = {}) {
	if (!target?.path) return null;
	const rel = target.path.replace(/^[~/]/, "").replace(/^\/+/, "");
	return target.scope === "user" ? resolve(join(home, rel)) : resolve(join(projectRoot ?? ".", rel));
}

export function mcpConfigFile(hostId, opts) {
	return resolveConfigFile(profileFor(hostId)?.mcp, opts);
}

export function hooksConfigFile(hostId, opts) {
	return resolveConfigFile(profileFor(hostId)?.hooks?.file, opts);
}

/** Canonical (host-neutral) event name → the name this host's config expects. */
export function hookEventName(profile, event) {
	const map = profile?.hooks?.eventNames;
	if (!map || map === "identity") return event;
	return map[event] ?? null;
}

/** All host-neutral events this host can be given a hook for. */
export function hookEventNames(profile) {
	const map = profile?.hooks?.eventNames;
	return map && map !== "identity" ? Object.values(map) : null;
}

export function isAsyncEvent(profile, hostEventName) {
	return Boolean(profile?.hooks?.asyncEvents?.includes(hostEventName));
}

/** null means "the host has no matcher concept" — the caller then omits the key. */
export function toolMatcherFor(profile, hostEventName) {
	const list = profile?.hooks?.matcherEvents;
	if (!Array.isArray(list) || !list.includes(hostEventName)) return null;
	return profile?.hooks?.toolMatcher ?? null;
}

/**
 * Which host sent this hook payload — telemetry's `host` column.
 *
 * Signals come from the profile so a new host contributes its own without a new
 * branch: the tool-result key it uses (strong), the case of its event names and
 * the directory its transcript lives in (weak). Each profile accumulates a score;
 * the strict winner takes the row. A tie or no signal returns "unknown" — a wrong
 * label is worse than none, because it splits one session across two hosts.
 */
export function detectHost(input) {
	if (!input || typeof input !== "object") return "unknown";
	const event = String(input.hook_event_name ?? input.hookEventName ?? "");
	const transcript = String(input.transcript_path ?? input.transcriptPath ?? "");
	const profiles = hostProfiles().filter((h) => h.detect);
	const keys = profiles.map((h) => h.detect.toolPayloadKey).filter(Boolean);
	const present = keys.filter((k) => input[k] !== undefined);
	let best = 0;
	let winner = "unknown";
	for (const h of profiles) {
		let score = 0;
		const key = h.detect.toolPayloadKey;
		if (key && present.includes(key) && present.length === 1) score += 2;
		if (h.detect.eventCase === "upper" && /^[A-Z]/.test(event)) score += 1;
		else if (h.detect.eventCase === "lower" && /^[a-z]/.test(event)) score += 1;
		if ((h.detect.transcriptPaths ?? []).some((re) => new RegExp(re, "i").test(transcript))) score += 1;
		if (score > best) {
			best = score;
			winner = h.id;
		}
	}
	return winner;
}

/**
 * Which agent inside the host sent this payload — telemetry's `agent` column.
 *
 * Only some hosts state it, so both signals are optional and checked in
 * confidence order: an explicit payload field, then the transcript path (a
 * subagent's transcript lives in a `subagents/` directory named after it).
 *
 * Two sources are deliberately rejected. Env, because hooks are served by one
 * resident daemon whose env belongs to whoever started it, not to the call being
 * recorded — the same trap that makes env useless for `host` below. And
 * `tool_input`, because a top-level agent launching a subagent names that
 * subagent in its own tool input, which would misfile the parent's row.
 *
 * A host that says nothing yields "main", not "unknown": the top-level session
 * is the common case, and labelling it unknown would split one conversation
 * across two buckets.
 */
const AGENT_FIELDS = ["agent_id", "agentId", "agent_type", "agentType", "subagent_type", "agent"];
const AGENT_TRANSCRIPT_RE = /[/\\]subagents[/\\](?:agent-)?(.+?)(?:-[0-9a-f]{6,})?\.jsonl$/i;
/** Per-invocation id, e.g. the tail of Qoder's `aExplore-2754952640b74ae5`. */
const AGENT_RUN_ID_RE = /-[0-9a-f]{8,}$/;

function agentLabel(raw) {
	const s = String(raw ?? "")
		.trim()
		.replace(AGENT_RUN_ID_RE, "")
		.replace(/[^A-Za-z0-9_.:-]+/g, "_")
		.slice(0, 48);
	return s || "subagent";
}

export function detectAgent(input) {
	if (!input || typeof input !== "object") return "unknown";
	for (const key of AGENT_FIELDS) {
		const v = input[key];
		if (typeof v === "string" && v.trim()) return agentLabel(v);
	}
	const transcript = String(input.transcript_path ?? input.transcriptPath ?? "");
	const m = transcript.match(AGENT_TRANSCRIPT_RE);
	if (m) return agentLabel(m[1]);
	return /[/\\]subagents[/\\]/i.test(transcript) ? "subagent" : "main";
}

/**
 * Host behind an MCP connection, from the name it asserts in `initialize`.
 *
 * An MCP server sees no hook payload, and its env cannot answer this: two hosts
 * launching the same command line share an env. clientInfo.name is the one field
 * the client itself states. "" means unidentified — callers keep it as unknown
 * rather than guessing.
 */
export function hostFromClientInfo(clientInfoName) {
	const n = String(clientInfoName ?? "").toLowerCase();
	if (!n) return "";
	for (const h of hostProfiles()) {
		if ((h.mcpClientInfo ?? []).some((token) => n.includes(String(token).toLowerCase()))) return h.id;
	}
	return "";
}

/** Labels for the UI: `{id, label, capabilities}` in registry order. */
export function hostDirectory() {
	return hostProfiles().map((h) => ({
		id: h.id,
		label: h.label ?? h.id,
		hooks: supports(h, "hooks"),
		mcp: supports(h, "mcp"),
		verified: h.verified === true,
		unverified_reason: h.verified ? undefined : h.unverifiedReason,
	}));
}
