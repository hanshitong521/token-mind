/**
 * Optional LLM / embed providers. Credentials live in ~/.contextmind/profile.json
 * (copied onto process.env by llm-profile.mjs). Nothing here runs on the
 * CodeGraph hot path unless cfg.providers.embed/chat is not "none".
 */

export function providerStatus(cfg) {
	const chat = cfg?.providers?.chat ?? "none";
	const embed = cfg?.providers?.embed ?? "none";
	const openai = Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
	const anthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL);
	const ollama = Boolean(process.env.OLLAMA_HOST);
	return {
		chat,
		embed,
		openai_env: openai,
		anthropic_env: anthropic,
		ollama_env: ollama,
		hot_path: chat === "none" && embed === "none",
	};
}

export function openaiCompatHeaders() {
	const key = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
	return key ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export function openaiCompatUrl(path = "/v1/chat/completions") {
	const base = (process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
	if (!base) return null;
	if (base.endsWith("/v1") && path.startsWith("/v1")) return `${base}${path.slice(3)}`;
	return `${base}${path}`;
}
