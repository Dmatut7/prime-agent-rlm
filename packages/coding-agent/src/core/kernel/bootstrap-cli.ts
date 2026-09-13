import path from "node:path";
import { getBundledSkillsDir } from "../../config.js";
import { getPythonSkillRuntimeInfo, loadSkillsFromDir } from "../skills.js";
import { ensureKernelPython } from "./bootstrap.js";
import { BOOT_CLAIM_PREFIX, releaseKernelVenvInUseSync, VENV_IN_USE_DIR_NAME } from "./venv-in-use.js";

/** Seeds the bundled Python skills too, so the venv can serve the kernel-heavy suite as-is. */
const WITH_BUNDLED_SKILLS = "--with-bundled-skills";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The bundled Python skills, discovered through the same loader a session uses.
 *
 * Seeding them matters because a pinned `PRIME_AGENT_KERNEL_PYTHON` skips the per-boot skill sync:
 * a venv without them only warns, and the kernel-heavy tests that drive a skill (`goal`,
 * `agent_message`) then fail on a missing import instead of running.
 */
function bundledPythonSkills() {
	const { skills, diagnostics } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "bundled" });
	for (const diagnostic of diagnostics) {
		console.error(`skill discovery: ${diagnostic.message} (${diagnostic.path})`);
	}
	return getPythonSkillRuntimeInfo(skills);
}

/**
 * Drop this process's pending-boot claim before exiting.
 *
 * The claim protects the window between handing back an interpreter and the spawn recording its own
 * reference; a seeding CLI never spawns, so the claim is dead the moment it is written. Left behind
 * it pins the generation until some later sweep reads it, and it travels into any clone of the venv
 * - which is what `test/repl-kernel-generation-isolation.test.ts` counts.
 */
function releaseOwnBootClaim(python: string): void {
	if (process.env.PRIME_AGENT_KERNEL_PYTHON) return; // override path never claimed
	const venv = path.dirname(path.dirname(python));
	releaseKernelVenvInUseSync(path.join(venv, VENV_IN_USE_DIR_NAME, `${BOOT_CLAIM_PREFIX}${process.pid}`));
}

const withBundledSkills = process.argv.slice(2).includes(WITH_BUNDLED_SKILLS);

try {
	const python = await ensureKernelPython(withBundledSkills ? { pythonSkills: bundledPythonSkills() } : {});
	releaseOwnBootClaim(python);
	console.log(`kernel python: ${python}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
