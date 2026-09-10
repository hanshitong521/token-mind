#!/usr/bin/env node
/**
 * beforeSubmitPrompt — L0 exact lookup + session delta (Ultimate Cache Engine §22).
 * Fail-open: never blocks the agent.
 */
import { ready, runtime, lib } from "./cm-lib.mjs";

if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, noop, openRuntime, projectRootOf, readHookInput, sessionIdOf } = runtime;

const input = await readHookInput();
const prompt = input.prompt ?? input.user_message ?? "";
if (!String(prompt).trim()) {
	noop();
	process.exit(0);
}

const projectRoot = projectRootOf(input);
const rt = openRuntime(projectRoot);
const sessionId = sessionIdOf(input);

try {
	const { runPromptPipeline } = await lib("prompt-pipeline.mjs");
	const out = await runPromptPipeline({
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
	if (out.additional_context) {
		emit({ additional_context: out.additional_context });
	} else {
		noop();
	}
} catch {
	noop();
}
