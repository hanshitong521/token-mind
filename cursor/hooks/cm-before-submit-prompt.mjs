#!/usr/bin/env node
/** beforeSubmitPrompt — prompt cache pipeline. Thin path (no cm-lib graph). */
import { emit, findHome, loadHomeModule, readHookInput } from "./cm-rpc.mjs";

const HOOK_MS = 8_000;
const guard = setTimeout(() => {
	process.stdout.write("{}\n");
	process.exit(0);
}, HOOK_MS);

try {
	if (!findHome()) {
		clearTimeout(guard);
		process.stdout.write("{}\n");
		process.exit(0);
	}
	const input = await readHookInput();
	const prompt = input.prompt ?? input.user_message ?? "";
	if (!String(prompt).trim()) {
		clearTimeout(guard);
		emit({});
		process.exit(0);
	}

	const runtime = await loadHomeModule("runtime.mjs");
	const pipeline = await loadHomeModule("prompt-pipeline.mjs");
	if (!runtime?.openRuntime || !pipeline?.runPromptPipeline) {
		clearTimeout(guard);
		emit({});
		process.exit(0);
	}

	const projectRoot = runtime.projectRootOf(input);
	const rt = runtime.openRuntime(projectRoot);
	const sessionId = runtime.sessionIdOf(input);
	const out = await pipeline.runPromptPipeline({
		projectRoot,
		prompt,
		sessionId,
		cfg: rt.cfg,
		db: rt.handles?.db ?? null,
		seen: rt.seen,
		meta: {
			project_id: rt.cfg.brain?.project_id ?? "",
			task_mode: input.task_mode ?? "",
		},
	});
	clearTimeout(guard);
	if (out?.additional_context) emit({ additional_context: out.additional_context });
	else emit({});
	process.exit(0);
} catch {
	clearTimeout(guard);
	process.stdout.write("{}\n");
	process.exit(0);
}
