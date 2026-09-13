import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const GIT_TTL_MS = 30_000;
const gitCache = new Map();
const rulesCache = new Map();
const fpCache = new Map();

function shaText(s) {
	return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function cacheGet(map, key) {
	const hit = map.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > GIT_TTL_MS) {
		map.delete(key);
		return null;
	}
	return hit.value;
}

function cacheSet(map, key, value) {
	map.set(key, { value, at: Date.now() });
}

export function gitHead(projectRoot) {
	const key = String(projectRoot ?? "");
	if (!key || !existsSync(join(key, ".git"))) return "";
	const cached = cacheGet(gitCache, key);
	if (cached != null) return cached;
	try {
		const head = execSync("git rev-parse HEAD", {
			cwd: key,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		cacheSet(gitCache, key, head);
		return head;
	} catch {
		cacheSet(gitCache, key, "");
		return "";
	}
}

/** Hash of tracked rules + contextmind config that affect CTX. */
export function rulesFingerprint(projectRoot) {
	const key = String(projectRoot ?? "");
	if (!key) return "";
	const cached = cacheGet(rulesCache, key);
	if (cached != null) return cached;
	const parts = [];
	const candidates = [join(key, ".contextmind.json"), join(key, ".cursor", "rules")];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const st = statSync(p);
			if (st.isDirectory()) continue;
			parts.push(shaText(readFileSync(p)));
		} catch {
			/* skip */
		}
	}
	const fp = parts.length ? shaText(parts.join(":")) : "";
	cacheSet(rulesCache, key, fp);
	return fp;
}

export function buildDependencyFingerprint(projectRoot, extra = {}) {
	const extraKey = JSON.stringify({
		repo_commit: extra.repo_commit ?? "",
		rules_fp: extra.rules_fp ?? "",
		file_hashes: extra.file_hashes ?? null,
		tools_schema_hash: extra.tools_schema_hash ?? "",
		system_prompt_version: extra.system_prompt_version ?? "",
	});
	const key = `${projectRoot}\u0000${extraKey}`;
	const cached = cacheGet(fpCache, key);
	if (cached != null) return cached;
	const commit = extra.repo_commit ?? gitHead(projectRoot);
	const rules = extra.rules_fp ?? rulesFingerprint(projectRoot);
	const files = extra.file_hashes ? shaText(JSON.stringify(extra.file_hashes)) : "";
	const fp = shaText([commit, rules, files, extra.tools_schema_hash ?? "", extra.system_prompt_version ?? ""].join("\u0001"));
	cacheSet(fpCache, key, fp);
	return fp;
}
