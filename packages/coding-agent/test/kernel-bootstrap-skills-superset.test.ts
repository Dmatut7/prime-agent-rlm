import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	pythonSkillsSatisfied,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

/** Must match BOOTSTRAP_SCHEMA in bootstrap.ts; the bump is deliberate (mixed-version window). */
const BOOTSTRAP_SCHEMA = 10;
/** The schema the previous release wrote; used to prove a stale record rebuilds exactly once. */
const PREVIOUS_BOOTSTRAP_SCHEMA = 9;

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function createPythonSkill(name: string): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
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
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return { name, importName, packagePath, pyprojectPath };
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
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
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
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

function writeRecord(venv: string, record: RecordedVersion): void {
	mkdirSync(venv, { recursive: true });
	writeFileSync(join(venv, ".bootstrap-version"), `${JSON.stringify(record)}\n`);
}

function recordedSkills(skills: readonly KernelPythonSkill[]): BootstrapPythonSkill[] {
	return skills.map((skill) => recordEntry(skill));
}

function uvLines(logPath: string): string[] {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

function editableInstallCount(logPath: string, packagePath?: string): number {
	return uvLines(logPath).filter(
		(line) => line.includes("--editable") && (packagePath === undefined || line.includes(packagePath)),
	).length;
}

/** `uv venv` invocations, matched by shape so a versioned venv directory still counts. */
function venvCreateCount(logPath: string): number {
	return uvLines(logPath).filter((line) => /^venv .+ --python 3\.11 --seed/.test(line)).length;
}

/** A record entry for a real on-disk skill; `overrides` simulates drift (stale hash, other checkout). */
function recordEntry(skill: KernelPythonSkill, overrides: Partial<BootstrapPythonSkill> = {}): BootstrapPythonSkill {
	return {
		importName: skill.importName,
		packagePath: skill.packagePath,
		pyprojectPath: skill.pyprojectPath,
		pyprojectHash: pyprojectHash(skill.pyprojectPath),
		...overrides,
	};
}

/** A record entry with no on-disk package, for the predicate table. */
function fakeEntry(importName: string, overrides: Partial<BootstrapPythonSkill> = {}): BootstrapPythonSkill {
	return {
		importName,
		packagePath: `/skills/${importName}`,
		pyprojectPath: `/skills/${importName}/pyproject.toml`,
		pyprojectHash: `sha256:${importName}`,
		...overrides,
	};
}

describe("kernel bootstrap python skill superset", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-superset-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	describe("pythonSkillsSatisfied", () => {
		const alpha = fakeEntry("alpha");
		const beta = fakeEntry("beta");
		const gamma = fakeEntry("gamma");

		it("accepts a superset record and rejects every way a request can be uncovered", () => {
			const cases: {
				name: string;
				installed: BootstrapPythonSkill[] | undefined;
				requested: BootstrapPythonSkill[];
				expected: boolean;
			}[] = [
				{ name: "empty record, nothing requested", installed: [], requested: [], expected: true },
				{ name: "absent record, nothing requested", installed: undefined, requested: [], expected: true },
				{ name: "identical sets", installed: [alpha, beta], requested: [alpha, beta], expected: true },
				{ name: "record is a superset", installed: [alpha, beta, gamma], requested: [beta], expected: true },
				{ name: "record order differs", installed: [beta, alpha], requested: [alpha, beta], expected: true },
				{ name: "requested skill missing", installed: [alpha], requested: [alpha, beta], expected: false },
				{ name: "absent record with a request", installed: undefined, requested: [alpha], expected: false },
				{
					name: "pyproject hash differs",
					installed: [fakeEntry("alpha", { pyprojectHash: "sha256:stale" })],
					requested: [alpha],
					expected: false,
				},
				{
					name: "same import name from another checkout",
					installed: [
						fakeEntry("alpha", {
							packagePath: "/other-checkout/alpha",
							pyprojectPath: "/other-checkout/alpha/pyproject.toml",
						}),
					],
					requested: [alpha],
					expected: false,
				},
				{
					// Pins the package-path dimension on its own: an identical hash under
					// another checkout is still a conflict over one import name.
					name: "package path differs, pyproject hash identical",
					installed: [fakeEntry("alpha", { packagePath: "/other-checkout/alpha" })],
					requested: [alpha],
					expected: false,
				},
				{
					name: "pyproject path differs, hash identical",
					installed: [fakeEntry("alpha", { pyprojectPath: "/moved/alpha/pyproject.toml" })],
					requested: [alpha],
					expected: false,
				},
			];
			expect(cases.length).toBeGreaterThan(0);
			for (const testCase of cases) {
				expect(pythonSkillsSatisfied(testCase.installed, testCase.requested), testCase.name).toBe(
					testCase.expected,
				);
			}
		});
	});

	it("keeps the record a union so a narrower session does not reinstall anything", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const skills = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7", "s-8"].map(createPythonSkill);
		expect(skills).toHaveLength(8);

		const python = await ensureKernelPython({ pythonSkills: skills });
		expect(python).toMatch(/bin[\\/]python$/);
		// Derived from the resolved interpreter, not from PRIME_AGENT_KERNEL_VENV, so the
		// assertions survive a venv directory naming change.
		const venvDir = dirname(dirname(python));
		const afterWideBoot = editableInstallCount(logPath);
		expect(afterWideBoot).toBe(8);
		expect(readRecord(venvDir).pythonSkills).toHaveLength(8);

		// A session that only asks for one of the installed skills: the record must
		// survive as the union, otherwise the next wide session reinstalls everything.
		await ensureKernelPython({ pythonSkills: [skills[0]] });
		expect(editableInstallCount(logPath)).toBe(afterWideBoot);
		expect(readRecord(venvDir).pythonSkills).toHaveLength(8);

		await ensureKernelPython({ pythonSkills: skills });
		expect(editableInstallCount(logPath)).toBe(afterWideBoot);
		expect(venvCreateCount(logPath)).toBe(1);
		expect(readRecord(venvDir).pythonSkills).toHaveLength(8);
	});

	it("installs a newly requested skill without dropping the recorded ones", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const skills = ["s-1", "s-2", "s-3"].map(createPythonSkill);

		const python = await ensureKernelPython({ pythonSkills: skills });
		const venvDir = dirname(dirname(python));
		const afterFirstBoot = editableInstallCount(logPath);
		expect(afterFirstBoot).toBe(3);

		// Positive control: a skill nobody installed yet really is installed...
		const newcomer = createPythonSkill("s-new");
		await ensureKernelPython({ pythonSkills: [skills[0], newcomer] });
		expect(editableInstallCount(logPath, newcomer.packagePath)).toBe(1);
		// ...and the union record keeps the two skills this session did not request.
		const record = readRecord(venvDir);
		expect(record.pythonSkills).toHaveLength(4);
		expect(record.pythonSkills?.map((skill) => skill.importName)).toEqual(
			expect.arrayContaining(["s_1", "s_2", "s_3", "s_new"]),
		);

		// Half-mutation catcher: a predicate-only fix would have rewritten the record
		// to [s_1, s_new], so this wide session would reinstall s_2 and s_3.
		await ensureKernelPython({ pythonSkills: skills });
		expect(editableInstallCount(logPath)).toBe(afterFirstBoot + 1);
	});

	it("reinstalls a skill whose recorded checkout path differs", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// The warm venv has to be built where bootstrap looks for it: this identity's
		// generation directory, not the unsuffixed base.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const skill = createPythonSkill("shared-skill");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeRecord(venv, {
			schema: BOOTSTRAP_SCHEMA,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			// Another checkout's copy of the same import name is a real conflict, not a
			// superset: the union record must not paper over it.
			pythonSkills: [
				recordEntry(skill, {
					packagePath: join(tempDir, "other-checkout", "shared-skill"),
					pyprojectPath: join(tempDir, "other-checkout", "shared-skill", "pyproject.toml"),
				}),
			],
		});
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		const resolved = await ensureKernelPython({ pythonSkills: [skill] });
		expect(resolved).toMatch(/bin[\\/]python$/);

		expect(editableInstallCount(logPath, skill.packagePath)).toBe(1);
		expect(venvCreateCount(logPath)).toBe(0);
		expect(dirname(dirname(resolved))).toBe(venv);
		const record = readRecord(dirname(dirname(resolved)));
		expect(record.pythonSkills).toHaveLength(1);
		expect(record.pythonSkills?.[0]?.packagePath).toBe(skill.packagePath);
	});

	it("rebuilds exactly once from a previous-schema record and then stops", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const skills = ["s-1", "s-2"].map(createPythonSkill);
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeRecord(venv, {
			schema: PREVIOUS_BOOTSTRAP_SCHEMA,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: recordedSkills(skills),
		});
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		const resolved = await ensureKernelPython({ pythonSkills: skills });
		expect(resolved).toMatch(/bin[\\/]python$/);

		// Mixed-version window: one bounded rebuild, then the record is back on the
		// current schema and the same request is a no-op.
		expect(venvCreateCount(logPath)).toBe(1);
		const record = readRecord(dirname(dirname(resolved)));
		expect(record.schema).toBe(BOOTSTRAP_SCHEMA);
		expect(record.pythonSkills).toHaveLength(2);

		await ensureKernelPython({ pythonSkills: skills });
		expect(venvCreateCount(logPath)).toBe(1);
		expect(editableInstallCount(logPath)).toBe(2);
	});
});
