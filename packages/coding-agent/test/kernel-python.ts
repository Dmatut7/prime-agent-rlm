/**
 * Resolve a Python interpreter for the real-kernel test files.
 *
 * These files resolve an interpreter at module load and fall back to `describe.skip` when none
 * resolves, and vitest exits 0 for a fully skipped file: a stale candidate list therefore reports
 * green while the kernel face has zero coverage. That is exactly what happened to
 * `test/repl-kernel-execute.test.ts` - `6 skipped` in every CI job, `6 passed` on a developer
 * machine - because its fallback named `~/.prime/agent/kernel-venv`, the pre-generation directory
 * this build no longer creates (see `reportLegacyKernelVenv` in `src/core/kernel/bootstrap.ts`),
 * while bootstrap builds `<base>-<12 hex>` and the checked-in runtime venv is gitignored.
 *
 * The candidates are the ones the product's own bootstrap resolves, in the same order
 * (`ensureKernelPython`), so a checkout that ran `bootstrap-cli.ts` - the first half of
 * `npm run test:ci` - hands these tests the interpreter a kernel would get.
 * `test/kernel-python-resolution.test.ts` pins that consistency: the generation candidate is
 * `kernelVenvDirForIdentity(base, ...)`, the very path `ensureKernelPython` computes.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeKernelVenvDir, getKernelVenvDir, KERNEL_PYTHON_SAFE_PATH_ARGS } from "../src/core/kernel/bootstrap.js";

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
	return filePath;
}

/** A venv committed nowhere: the source checkout's own runtime venv, a developer-machine shortcut. */
const SOURCE_CHECKOUT_VENV = fileURLToPath(new URL("../../../prime-agent-runtime/.venv/bin/python", import.meta.url));

/**
 * The candidates `ensureKernelPython` resolves for `base`, in its order.
 *
 * Identity resolution reads the runtime source; a checkout that cannot be read must degrade to
 * "no candidate" rather than make the importing test file uncollectable, so the generation
 * candidate is dropped on failure instead of thrown.
 */
export async function productKernelPythonCandidates(base = getKernelVenvDir()): Promise<string[]> {
	const candidates: string[] = [];
	const pinned = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (pinned) candidates.push(resolve(expandHome(pinned)));
	try {
		candidates.push(join(await activeKernelVenvDir(base), "bin", "python"));
	} catch {
		// Unreadable runtime source: the generation directory cannot be named, so skip it.
	}
	// The pre-generation directory. This build never creates it, but an older host still runs a
	// kernel from one, so a machine that only has it keeps working.
	candidates.push(join(base, "bin", "python"));
	return candidates;
}

/** Every candidate an interpreter may be taken from, product paths first. */
export async function kernelPythonCandidates(base = getKernelVenvDir()): Promise<string[]> {
	return [...(await productKernelPythonCandidates(base)), SOURCE_CHECKOUT_VENV];
}

/**
 * The first candidate that exists and answers `probe` with exit code 0, or null to skip the file.
 *
 * `probe` is the import check for the caller's face (`"import rlm.repl, dill"`); it runs with the
 * product's `-P` flag so a checkout carrying a module that shadows the kernel's own imports cannot
 * make a wrong interpreter look usable.
 */
export async function resolveKernelPython(probe: string, candidates?: string[]): Promise<string | null> {
	for (const python of candidates ?? (await kernelPythonCandidates())) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-c", probe], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}
