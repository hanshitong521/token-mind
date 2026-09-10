/**
 * Shared fixture loader for the Prompt Lab test suite.
 *
 * Fixtures live in `contextmind/fixtures/prompt-lab/`: one content file plus a
 * `<id>.meta.json` that declares what MUST be true about it. The tests are
 * data-driven off those declarations, so adding a fixture adds coverage
 * without touching a test file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/prompt-lab", import.meta.url));

export function loadFixtures() {
	const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".meta.json")).sort();
	return files.map((f) => {
		const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8"));
		return { meta, content: readFileSync(join(FIXTURE_DIR, meta.file), "utf8") };
	});
}

export function fixtureById(id) {
	const found = loadFixtures().find((f) => f.meta.id === id);
	if (!found) throw new Error(`fixture not found: ${id}`);
	return found;
}

/** Recursively freeze a plain structure so any accidental write throws. */
export function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}
