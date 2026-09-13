import { evaluateShell, wrapDisclosure } from "../shell-guard.mjs";
import { isGitCommand } from "./git.mjs";

export function evaluateShellCommand(command, { cfg } = {}) {
	return evaluateShell(command, { cfg });
}

export { wrapDisclosure, isGitCommand };
