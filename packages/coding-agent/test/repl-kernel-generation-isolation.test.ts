import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { pruneKernelVenvGenerations } from "../src/core/kernel/venv-in-use.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const seedPython = resolveReplPython();
const kernelPythonMissing = seedPython === null;

function sitePackages(venvDir: string): string {
	const lib = join(venvDir, "lib");
	const versions = existsSync(lib) ? readdirSync(lib).filter((name) => name.startsWith("python")) : [];
	expect(versions.length).toBeGreaterThan(0);
	return join(lib, versions.sort()[versions.length - 1] as string, "site-packages");
}

/**
 * Copy a real venv into a generation directory. Clones/hardlinks keep this cheap; the
 * copy is a genuinely independent tree, which is the property under test.
 */
function cloneVenv(source: string, target: string): void {
	const attempts: string[][] =
		process.platform === "darwin"
			? [
					["-c", "-R", source, target],
					["-R", source, target],
				]
			: process.platform === "linux"
				? [
						["-al", source, target],
						["-R", source, target],
					]
				: [["-R", source, target]];
	let copied = false;
	for (const args of attempts) {
		const result = spawnSync("cp", args, { encoding: "utf8" });
		if (result.status === 0) {
			copied = true;
			break;
		}
		rmSync(target, { recursive: true, force: true });
	}
	expect(copied, `could not clone ${source}`).toBe(true);
	expect(existsSync(join(target, "pyvenv.cfg"))).toBe(true);
	expect(existsSync(join(target, "bin", "python"))).toBe(true);
}

/** Replace a file without following a hardlink/clone back into the source tree. */
function replaceFile(target: string, content: string): void {
	rmSync(target, { force: true });
	writeFileSync(target, content, { mode: 0o644 });
}

function installProbe(venvDir: string, moduleName: string, value: string): void {
	const moduleDir = join(sitePackages(venvDir), moduleName);
	mkdirSync(moduleDir, { recursive: true });
	writeFileSync(join(moduleDir, "__init__.py"), `VALUE = ${JSON.stringify(value)}\n`, { mode: 0o644 });
}

describe.skipIf(kernelPythonMissing)(
	"kernel generations isolate a live kernel (real runtime)",
	{ tags: ["kernel-heavy"] },
	() => {
		let tempDir = "";
		let base = "";
		let generationA = "";
		let generationB = "";
		let originalEnv: NodeJS.ProcessEnv;

		beforeAll(() => {
			originalEnv = { ...process.env };
			tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-generation-"));
			base = join(tempDir, "kernel-venv");
			generationA = join(tempDir, "kernel-venv-aaaaaaaaaaaa");
			generationB = join(tempDir, "kernel-venv-bbbbbbbbbbbb");
			const seedVenv = dirname(dirname(seedPython as string));
			cloneVenv(seedVenv, generationA);
			cloneVenv(seedVenv, generationB);
			process.env.PRIME_AGENT_KERNEL_VENV = base;
		});

		afterAll(() => {
			process.env = originalEnv;
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
				tempDir = "";
			}
		});

		it("keeps a running kernel on its own generation while another one lands next to it", async () => {
			const liveKernel = new ReplKernelManager({
				python: join(generationA, "bin", "python"),
				cwd: tempDir,
				sessionId: "live-generation",
			});
			const nextGeneration = new ReplKernelManager({
				python: join(generationB, "bin", "python"),
				cwd: tempDir,
				sessionId: "next-generation",
			});

			try {
				await liveKernel.start();
				expect(liveKernel.isRunning).toBe(true);

				// The live kernel pinned its own generation with a real reference file.
				const referenceDir = join(generationA, ".in-use");
				const references = readdirSync(referenceDir);
				expect(references).toHaveLength(1);
				const inodeBefore = statSync(generationA).ino;

				const startup = await liveKernel.execute(
					[
						// `import rlm.repl` alone binds the package, whose __getattr__ hides
						// submodules, so the probe binds the submodule explicitly.
						"import sys",
						"import rlm.repl as startup_repl",
						"print(startup_repl.PROTOCOL_VERSION)",
						"print([entry for entry in sys.path if entry.endswith('site-packages')])",
					].join("\n"),
				);
				expect(startup.status).toBe("ok");
				const [startupProtocol, startupPath] = startup.stdout.trim().split("\n");
				expect(startupProtocol).toMatch(/^[0-9]+$/);
				expect(startupPath).toContain(generationA);
				expect(startupPath).not.toContain(generationB);

				// A different build identity lands next to the running kernel: its runtime
				// reports another protocol version and it carries a package A never had.
				const replPath = join(sitePackages(generationB), "rlm", "repl.py");
				const replSource = readFileSync(replPath, "utf8");
				expect(replSource).toContain("PROTOCOL_VERSION = ");
				// A different, still supported protocol version: the host's range handshake
				// accepts it, so the pair is a real mixed-version window (v3 live + v4 next).
				replaceFile(replPath, replSource.replace(/PROTOCOL_VERSION = [0-9]+/, "PROTOCOL_VERSION = 4"));
				installProbe(generationB, "t0b_other_generation", "from-b");
				// A skill sync into the live kernel's own generation, after it started.
				installProbe(generationA, "t0b_own_generation", "from-a");

				// The boot sweep runs with B as the generation being built.
				const report = await pruneKernelVenvGenerations(base, { activeDir: generationB, retention: 0 });
				expect(report.removed).not.toContain(generationA);
				expect(report.kept.some((entry) => entry.dir === generationA && entry.protectedByReference)).toBe(true);

				// The running kernel still resolves lazy imports, in its own generation only.
				const after = await liveKernel.execute(
					[
						"import dill, t0b_own_generation",
						"import rlm.repl as after_repl",
						"print(after_repl.PROTOCOL_VERSION, t0b_own_generation.VALUE, dill.__file__)",
						"try:",
						"    import t0b_other_generation",
						"    print('leaked')",
						"except ModuleNotFoundError:",
						"    print('isolated')",
					].join("\n"),
				);
				expect(after.status).toBe("ok");
				const [protocolNow, ownValue, dillFile, isolation] = after.stdout.trim().split(/\s+/);
				// No mixed versions: the module it already loaded keeps its startup version.
				expect(protocolNow).toBe(startupProtocol);
				expect(ownValue).toBe("from-a");
				expect(dillFile).toContain(generationA);
				expect(isolation).toBe("isolated");

				// Nothing was renamed or deleted under the live kernel.
				expect(statSync(generationA).ino).toBe(inodeBefore);
				expect(existsSync(join(referenceDir, references[0] as string))).toBe(true);

				// The next generation is genuinely independent: it negotiates the new version
				// while the live kernel keeps the one it started with.
				await nextGeneration.start();
				const other = await nextGeneration.execute(
					"import rlm.repl as other_repl\nimport t0b_other_generation\nprint(other_repl.PROTOCOL_VERSION, t0b_other_generation.VALUE)",
				);
				expect(other.status).toBe("ok");
				expect(other.stdout.trim().split(/\s+/)).toEqual(["4", "from-b"]);
				// A's runtime is still the startup one on disk too.
				expect(readFileSync(join(sitePackages(generationA), "rlm", "repl.py"), "utf8")).toContain(
					`PROTOCOL_VERSION = ${startupProtocol}`,
				);

				await liveKernel.shutdown({});
				expect(readdirSync(referenceDir)).toHaveLength(0);
			} finally {
				await liveKernel.shutdown({});
				await nextGeneration.shutdown({});
			}

			// With both kernels gone the generations are reclaimable.
			const reclaimed = await pruneKernelVenvGenerations(base, { retention: 0 });
			expect(reclaimed.removed).toContain(generationA);
			expect(reclaimed.removed).toContain(generationB);
			expect(existsSync(generationA)).toBe(false);
			expect(existsSync(generationB)).toBe(false);
			expect(basename(base)).toBe("kernel-venv");
		}, 240_000);
	},
);
