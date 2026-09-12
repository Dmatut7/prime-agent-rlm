import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeKernelVenvDir,
	type BootstrapPythonSkill,
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	type KernelPythonSkill,
	pythonSkillContentHash,
	pythonSkillInstallIsFaithful,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

/** Must match BOOTSTRAP_SCHEMA in bootstrap.ts. */
const BOOTSTRAP_SCHEMA = 10;

/**
 * K-P1-2: one machine-wide venv generation, many checkouts.
 *
 * A generation directory is keyed on content, so every checkout of the same commit resolves to
 * the same one - while a skill's editable install names an absolute path inside whichever
 * checkout wrote the record. Comparing those paths made every alternating boot reinstall the
 * whole skill set under the machine-wide bootstrap lock and flip the record to its own tree, and
 * left installs behind that pointed at worktrees which no longer existed. These cases pin the
 * three facts that replace it: readiness is content-addressed, a record whose install no longer
 * holds that content costs exactly one reinstall, and nothing is swapped under a running kernel.
 */

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

/** One checkout's copy of a skill: `<root>/<name>/{pyproject.toml,src/<import>/__init__.py}`. */
function createCheckoutSkill(
	root: string,
	name: string,
	body = "async def run():\n    return 'ok'\n",
): KernelPythonSkill {
	const packagePath = join(root, name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), body);
	writeFileSync(join(packagePath, "SKILL.md"), `# ${name}\n`);
	return { name, importName, packagePath, pyprojectPath };
}

function recordEntry(skill: KernelPythonSkill, overrides: Partial<BootstrapPythonSkill> = {}): BootstrapPythonSkill {
	return {
		importName: skill.importName,
		packagePath: skill.packagePath,
		pyprojectPath: skill.pyprojectPath,
		pyprojectHash: pyprojectHash(skill.pyprojectPath),
		contentHash: pythonSkillContentHash(skill.packagePath),
		...overrides,
	};
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then',
			'  case "$3" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then',
			'  case "$3" in',
			'    "import rlm") exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

interface RecordedVersion {
	schema: number;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

function readRecord(venv: string): RecordedVersion {
	return JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8")) as RecordedVersion;
}

function writeRecord(venv: string, pythonSkills: readonly BootstrapPythonSkill[]): void {
	mkdirSync(venv, { recursive: true });
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: BOOTSTRAP_SCHEMA,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills,
		})}\n`,
	);
}

/** A warm generation directory whose base install the fake python satisfies. */
async function warmGeneration(base: string, pythonSkills: readonly BootstrapPythonSkill[]): Promise<string> {
	const venv = await activeKernelVenvDir(base);
	mkdirSync(join(venv, "bin"), { recursive: true });
	writeFakePython(join(venv, "bin", "python"), ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
	writeRecord(venv, pythonSkills);
	return venv;
}

function uvLines(logPath: string): string[] {
	// A boot that installs nothing never invokes uv, so the log may not exist at all.
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

function editableInstallCount(logPath: string, packagePath?: string): number {
	return uvLines(logPath).filter(
		(line) => line.includes("--editable") && (packagePath === undefined || line.includes(packagePath)),
	).length;
}

/** The reference format documented by src/core/kernel/venv-in-use.ts; this pid is live by definition. */
function writeInUseReference(venvDir: string, pid = process.pid, sessionId = "another-session"): string {
	const dir = join(venvDir, ".in-use");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, String(pid));
	writeFileSync(file, `${JSON.stringify({ version: 1, pid, sessionId, recordedAt: new Date().toISOString() })}\n`, {
		mode: 0o600,
	});
	return file;
}

describe("kernel bootstrap skill content (K-P1-2)", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-skill-content-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	describe("pythonSkillContentHash", () => {
		it("is path-independent and moves only with installed content", () => {
			const a = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
			const b = createCheckoutSkill(join(tempDir, "checkout-b"), "shared-skill");
			expect(a.packagePath).not.toBe(b.packagePath);
			// The whole fix rests on this: two checkouts, one fingerprint.
			expect(pythonSkillContentHash(a.packagePath)).toBe(pythonSkillContentHash(b.packagePath));
			expect(pythonSkillContentHash(a.packagePath)).toMatch(/^sha256:[0-9a-f]{64}$/);

			const before = pythonSkillContentHash(a.packagePath);
			// A kernel importing an editable install writes .pyc files *into the source tree*:
			// counting them would change the fingerprint on every boot and reinstall forever.
			mkdirSync(join(a.packagePath, "src", "shared_skill", "__pycache__"), { recursive: true });
			writeFileSync(join(a.packagePath, "src", "shared_skill", "__pycache__", "__init__.cpython-311.pyc"), "x");
			expect(pythonSkillContentHash(a.packagePath)).toBe(before);
			// Prose and references are not installed content either.
			writeFileSync(join(a.packagePath, "SKILL.md"), "# rewritten\n");
			expect(pythonSkillContentHash(a.packagePath)).toBe(before);

			// What the wheel does carry: the package source and its metadata.
			writeFileSync(
				join(a.packagePath, "src", "shared_skill", "__init__.py"),
				"async def run():\n    return 'new'\n",
			);
			const afterSource = pythonSkillContentHash(a.packagePath);
			expect(afterSource).not.toBe(before);
			writeFileSync(
				join(a.packagePath, "pyproject.toml"),
				`[project]
name = "shared-skill"
version = "0.2.0"
`,
			);
			expect(pythonSkillContentHash(a.packagePath)).not.toBe(afterSource);
		});

		it("reports a package that is not there any more", () => {
			expect(pythonSkillContentHash(join(tempDir, "deleted-checkout", "shared-skill"))).toBe("missing");
		});
	});

	describe("pythonSkillInstallIsFaithful", () => {
		it("holds only while the recorded path still carries the recorded content", () => {
			const skill = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
			const entry = recordEntry(skill);
			expect(pythonSkillInstallIsFaithful(entry)).toBe(true);
			// A record written before fingerprints existed cannot be vouched for.
			expect(pythonSkillInstallIsFaithful({ ...entry, contentHash: undefined })).toBe(false);
			// The checkout drifted under the record.
			writeFileSync(
				join(skill.packagePath, "src", "shared_skill", "__init__.py"),
				"async def run():\n    return 2\n",
			);
			expect(pythonSkillInstallIsFaithful(entry)).toBe(false);
			// ...or disappeared, which is what a deleted worktree leaves behind in a shared venv.
			rmSync(skill.packagePath, { recursive: true, force: true });
			expect(pythonSkillInstallIsFaithful(entry)).toBe(false);
		});
	});

	it("shares one install between two checkouts of identical content, without flipping the record", async () => {
		const logPath = installFakeUv();
		const checkoutA = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
		const checkoutB = createCheckoutSkill(join(tempDir, "checkout-b"), "shared-skill");

		const python = await ensureKernelPython({ pythonSkills: [checkoutA] });
		const venv = dirname(dirname(python));
		expect(editableInstallCount(logPath, checkoutA.packagePath)).toBe(1);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutA.packagePath);
		const recordPath = join(venv, ".bootstrap-version");
		const recordMtimeMs = statSync(recordPath).mtimeMs;

		// The other checkout boots against the same generation. Same bytes, other path.
		await expect(ensureKernelPython({ pythonSkills: [checkoutB] })).resolves.toBe(python);
		expect(editableInstallCount(logPath)).toBe(1);
		expect(editableInstallCount(logPath, checkoutB.packagePath)).toBe(0);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutA.packagePath);

		// Alternating is the shape the audit measured on this machine: still nothing to do.
		await ensureKernelPython({ pythonSkills: [checkoutA] });
		await ensureKernelPython({ pythonSkills: [checkoutB] });
		await ensureKernelPython({ pythonSkills: [checkoutA] });
		expect(editableInstallCount(logPath)).toBe(1);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutA.packagePath);
		// And the warm path returned before the lock: a satisfied generation is a no-op, not a
		// rewrite of the record (and a reinstall of the whole set) under the machine-wide
		// bootstrap lock that every other boot is waiting on.
		expect(statSync(recordPath).mtimeMs).toBe(recordMtimeMs);
	});

	it("installs this checkout's copy when the recorded content really differs", async () => {
		const logPath = installFakeUv();
		const checkoutA = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
		const checkoutB = createCheckoutSkill(
			join(tempDir, "checkout-b"),
			"shared-skill",
			"async def run():\n    return 'edited in this lane'\n",
		);
		const venv = await warmGeneration(join(tempDir, "kernel-venv"), [recordEntry(checkoutA)]);

		await expect(ensureKernelPython({ pythonSkills: [checkoutB] })).resolves.toBe(join(venv, "bin", "python"));
		expect(editableInstallCount(logPath, checkoutB.packagePath)).toBe(1);
		expect(editableInstallCount(logPath, checkoutA.packagePath)).toBe(0);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutB.packagePath);
	});

	it("repairs a recorded install whose checkout was deleted", async () => {
		const logPath = installFakeUv();
		const gone = createCheckoutSkill(join(tempDir, "wt-deleted"), "shared-skill");
		const entry = recordEntry(gone);
		rmSync(join(tempDir, "wt-deleted"), { recursive: true, force: true });
		const venv = await warmGeneration(join(tempDir, "kernel-venv"), [entry]);
		const local = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");

		await expect(ensureKernelPython({ pythonSkills: [local] })).resolves.toBe(join(venv, "bin", "python"));
		// The dangling editable install is replaced instead of being trusted.
		expect(editableInstallCount(logPath, local.packagePath)).toBe(1);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(local.packagePath);
		expect(readRecord(venv).pythonSkills?.[0]?.contentHash).toBe(pythonSkillContentHash(local.packagePath));
	});

	it("never swaps an editable install under a kernel that runs from the generation", async () => {
		const logPath = installFakeUv();
		const checkoutA = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
		const checkoutB = createCheckoutSkill(
			join(tempDir, "checkout-b"),
			"shared-skill",
			"async def run():\n    return 'edited in this lane'\n",
		);
		const venv = await warmGeneration(join(tempDir, "kernel-venv"), [recordEntry(checkoutA)]);
		writeInUseReference(venv);
		const progress: string[] = [];

		// Booting still works: a referenced generation is not a reason to refuse a kernel.
		await expect(
			ensureKernelPython({ pythonSkills: [checkoutB], onProgress: (m) => progress.push(m) }),
		).resolves.toBe(join(venv, "bin", "python"));
		expect(editableInstallCount(logPath, checkoutB.packagePath)).toBe(0);
		// The record keeps naming the install that is really on disk, so the next boot can retry.
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutA.packagePath);
		expect(progress.join("\n")).toContain("stays installed from");
		expect(progress.join("\n")).toContain(checkoutA.packagePath);
	});

	it("still installs a skill nobody installed yet while a kernel runs from the generation", async () => {
		const logPath = installFakeUv();
		const installed = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
		const newcomer = createCheckoutSkill(join(tempDir, "checkout-b"), "other-skill");
		const venv = await warmGeneration(join(tempDir, "kernel-venv"), [recordEntry(installed)]);
		writeInUseReference(venv);

		await expect(ensureKernelPython({ pythonSkills: [installed, newcomer] })).resolves.toBe(
			join(venv, "bin", "python"),
		);
		// An addition cannot swap content under the running kernel, so the guard does not hold it.
		expect(editableInstallCount(logPath, newcomer.packagePath)).toBe(1);
		expect(editableInstallCount(logPath, installed.packagePath)).toBe(0);
		// The union record keeps both, ordered the way the manifest sorts them (by package path).
		expect(readRecord(venv).pythonSkills?.map((skill) => skill.importName)).toEqual(["shared_skill", "other_skill"]);
	});

	it("treats an unreadable reference state as in use", async () => {
		const logPath = installFakeUv();
		const checkoutA = createCheckoutSkill(join(tempDir, "checkout-a"), "shared-skill");
		const checkoutB = createCheckoutSkill(
			join(tempDir, "checkout-b"),
			"shared-skill",
			"async def run():\n    return 'edited in this lane'\n",
		);
		const venv = await warmGeneration(join(tempDir, "kernel-venv"), [recordEntry(checkoutA)]);
		// A tombstone is the documented "a kernel could not write its reference" marker: the
		// generation is assumed in use rather than risk swapping content under a live kernel.
		mkdirSync(join(venv, ".in-use"), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(venv, ".in-use", `unverified-${process.pid}`),
			`${JSON.stringify({ version: 1, pid: process.pid, unverified: true, reason: "ELOOP" })}\n`,
			{ mode: 0o600 },
		);

		await expect(ensureKernelPython({ pythonSkills: [checkoutB] })).resolves.toBe(join(venv, "bin", "python"));
		expect(editableInstallCount(logPath, checkoutB.packagePath)).toBe(0);
		expect(readRecord(venv).pythonSkills?.[0]?.packagePath).toBe(checkoutA.packagePath);
	});
});
