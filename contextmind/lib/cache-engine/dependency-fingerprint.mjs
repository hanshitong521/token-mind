import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function shaText(s) {
	return createHash("sha256").update(String(s), "utf8").digest("hex");
}

export function gitHead(projectRoot) {
	if (!projectRoot || !existsSync(join(projectRoot, ".git"))) return "";
	try {
		return execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** Hash of tracked rules + contextmind config that affect CTX. */
export function rulesFingerprint(projectRoot) {
	if (!projectRoot) return "";
	const parts = [];
	const candidates = [
		join(projectRoot, ".contextmind.json"),
		join(projectRoot, ".cursor", "rules"),
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			parts.push(shaText(readFileSync(p)));
		} catch {
			/* skip */
		}
	}
	return parts.length ? shaText(parts.join(":")) : "";
}

export function buildDependencyFingerprint(projectRoot, extra = {}) {
	const commit = extra.repo_commit ?? gitHead(projectRoot);
	const rules = extra.rules_fp ?? rulesFingerprint(projectRoot);
	const files = extra.file_hashes ? shaText(JSON.stringify(extra.file_hashes)) : "";
	return shaText([commit, rules, files, extra.tools_schema_hash ?? "", extra.system_prompt_version ?? ""].join("\u0001"));
}
