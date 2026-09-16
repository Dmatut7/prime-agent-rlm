import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kernelVenvDirForIdentity, resolveRuntimeIdentity } from "../src/core/kernel/bootstrap.js";
import { kernelPythonCandidates, productKernelPythonCandidates, resolveKernelPython } from "./kernel-python.js";

/**
 * The candidate list is the thing that decides whether a real-kernel test file runs or reports a
 * green `describe.skip`, so it is pinned here against planted venvs: the reported CI false green
 * was a fallback list naming a directory this build never creates.
 */

const PROBE = "import rlm.repl, dill";
/** One bootstrap generation directory: `<base>-<12 hex>`. */
const GENERATION_SUFFIX = /^kernel-venv-[0-9a-f]{12}$/;

/** A stand-in interpreter whose exit code answers the import probe. */
function plantPython(venvDir: string, exitCode: number): string {
	const bin = join(venvDir, "bin");
	mkdirSync(bin, { recursive: true });
	const python = join(bin, "python");
	writeFileSync(python, `#!/bin/sh\nexit ${exitCode}\n`);
	chmodSync(python, 0o755);
	return python;
}

let tempDir = "";
let savedPin: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-python-"));
	savedPin = process.env.PRIME_AGENT_KERNEL_PYTHON;
	delete process.env.PRIME_AGENT_KERNEL_PYTHON;
});

afterEach(() => {
	if (savedPin === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
	else process.env.PRIME_AGENT_KERNEL_PYTHON = savedPin;
	rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

describe("kernel python resolution for real-kernel tests", () => {
	it("resolves the generation directory the product's own bootstrap computes", async () => {
		const base = join(tempDir, "kernel-venv");
		const generation = kernelVenvDirForIdentity(base, await resolveRuntimeIdentity());
		expect(basename(generation)).toMatch(GENERATION_SUFFIX);
		const planted = plantPython(generation, 0);

		const candidates = await productKernelPythonCandidates(base);
		// Same path, same order as `ensureKernelPython`: the pin is unset, so the generation is first.
		expect(candidates[0]).toBe(planted);
		expect(await resolveKernelPython(PROBE, candidates)).toBe(planted);
	});

	it("keeps the source checkout venv as the last resort for developer machines", async () => {
		const candidates = await kernelPythonCandidates(join(tempDir, "kernel-venv"));
		expect(candidates.at(-1)?.endsWith(join("prime-agent-runtime", ".venv", "bin", "python"))).toBe(true);
	});

	it("still resolves the pre-generation directory this build no longer creates", async () => {
		const base = join(tempDir, "kernel-venv");
		const planted = plantPython(base, 0);
		expect(await resolveKernelPython(PROBE, await productKernelPythonCandidates(base))).toBe(planted);
	});

	it("takes a pinned PRIME_AGENT_KERNEL_PYTHON ahead of the generation directory", async () => {
		const base = join(tempDir, "kernel-venv");
		plantPython(kernelVenvDirForIdentity(base, await resolveRuntimeIdentity()), 0);
		const pinned = plantPython(join(tempDir, "pinned"), 0);
		process.env.PRIME_AGENT_KERNEL_PYTHON = pinned;

		const candidates = await productKernelPythonCandidates(base);
		expect(candidates[0]).toBe(pinned);
		expect(await resolveKernelPython(PROBE, candidates)).toBe(pinned);
	});

	it("skips an interpreter that cannot answer the probe", async () => {
		const base = join(tempDir, "kernel-venv");
		plantPython(kernelVenvDirForIdentity(base, await resolveRuntimeIdentity()), 1);
		const legacy = plantPython(base, 0);
		expect(await resolveKernelPython(PROBE, await productKernelPythonCandidates(base))).toBe(legacy);
	});

	it("does not accept an unrelated generation directory as the current build", async () => {
		const base = join(tempDir, "kernel-venv");
		plantPython(join(tempDir, "kernel-venv-aaaaaaaaaaaa"), 0);
		expect(await resolveKernelPython(PROBE, await productKernelPythonCandidates(base))).toBe(null);
	});

	it("returns null, so the file reports skipped, when no candidate exists", async () => {
		expect(await resolveKernelPython(PROBE, await productKernelPythonCandidates(join(tempDir, "absent")))).toBe(null);
	});
});

describe("L8D-2: the venv generation identity includes the interpreter version", () => {
	it("gives two interpreter lines different generation directories under one base", () => {
		const base = join(tempDir, "kernel-venv");
		const runtime = "runtime-identity-l8d2";
		const py311 = kernelVenvDirForIdentity(base, runtime, "3.11");
		const py312 = kernelVenvDirForIdentity(base, runtime, "3.12");
		// RED on HEAD: the identity hashed only schema/runtime/snapshot/uv-args, so
		// bumping the requested interpreter rebuilt the same directory in place
		// (rm + recreate) instead of moving to a new generation.
		expect(py311).not.toBe(py312);
		expect(basename(py311)).toMatch(GENERATION_SUFFIX);
		expect(basename(py312)).toMatch(GENERATION_SUFFIX);
		// Positive controls: the same line is still the same generation, and the
		// runtime identity still separates generations on its own.
		expect(kernelVenvDirForIdentity(base, runtime, "3.12")).toBe(py312);
		expect(kernelVenvDirForIdentity(base, "runtime-identity-other", "3.12")).not.toBe(py312);
	});
});
