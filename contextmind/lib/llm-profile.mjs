import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	join(homedir(), ".contextmind", "profile.json"),
	join(homedir(), ".contextmind.json"),
];

/** Parse 3-line API markdown (base URL, key, model). */
export function parseApiMarkdown(text) {
	const lines = String(text ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
	const env = {};
	if (lines[0]) env.ANTHROPIC_BASE_URL = lines[0];
	if (lines[1]) env.ANTHROPIC_API_KEY = lines[1];
	if (lines[2]) env.ANTHROPIC_MODEL = lines[2];
	return { env };
}

for (const path of CANDIDATES) {
	if (!existsSync(path)) continue;
	try {
		const doc = JSON.parse(readFileSync(path, "utf8"));
		const env = doc?.env && typeof doc.env === "object" ? doc.env : doc;
		if (!env || typeof env !== "object") continue;
		for (const [key, value] of Object.entries(env)) {
			if (value == null || value === "") continue;
			if (process.env[key] === undefined) process.env[key] = String(value);
		}
	} catch {
		/* optional profile */
	}
}
