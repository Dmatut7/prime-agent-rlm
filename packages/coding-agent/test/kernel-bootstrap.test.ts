import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activeKernelVenvDir,
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	type KernelPythonSkill,
	pythonSkillContentHash,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

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

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 10,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
				contentHash: pythonSkillContentHash(skill.packagePath),
			})),
		})}\n`,
	);
}

/** The marker content the fake uv saw at each editable install, in install order. */
function markerProbes(logPath: string): string[] {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("MARKER "))
		.map((line) => line.slice("MARKER ".length));
}

function skillNames(version: { pythonSkills: Array<{ importName: string }> }): string[] {
	return version.pythonSkills.map((skill) => skill.importName);
}

/**
 * Waits for one line in the fake uv's log. The fake uv is an external process, so there is no
 * in-process signal to await; the deadline only bites on the failure path and it throws rather
 * than passing silently.
 */
async function waitForFakeUvLog(logPath: string, needle: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(logPath) && readFileSync(logPath, "utf8").includes(needle)) return;
		await sleep(25);
	}
	throw new Error(`the fake uv log never contained: ${needle}`);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
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
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
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

/**
 * Installs a fake `uv`. `venvUnreadyImports` and `venvRuntimeReady` describe a runtime that
 * installs without error yet does not satisfy the host's readiness check, which is the state the
 * post-install recheck has to surface instead of reporting "ready".
 */
function installFakeUv(options: { venvUnreadyImports?: readonly string[]; venvRuntimeReady?: boolean } = {}): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const unreadyImports = options.venvUnreadyImports ?? [];
	const unreadyImportCases = unreadyImports.map((moduleName) => `    "import ${moduleName}") exit 1 ;;`);
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter(
		(moduleName) => !unreadyImports.includes(moduleName),
	).map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	const runtimeReadyCase =
		options.venvRuntimeReady === false
			? '    *"_harness_methods"*) exit 1 ;;'
			: '    *"_harness_methods"*) exit 0 ;;';
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
			...unreadyImportCases,
			'    "import rlm") exit 0 ;;',
			...extraImportCases,
			runtimeReadyCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  marker_file=""',
			'  seen_editable=""',
			'  prev=""',
			'  for arg in "$@"; do',
			'    if [ "$prev" = "--python" ]; then',
			'      marker_file="$(dirname "$arg")/../.bootstrap-version"',
			"    fi",
			'    if [ "$arg" = "--editable" ]; then',
			"      seen_editable=1",
			"    fi",
			'    if [ "$UV_HANG_ARG" != "" ] && [ "$arg" = "$UV_HANG_ARG" ]; then',
			"      sleep 30",
			"    fi",
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			'    prev="$arg"',
			"  done",
			// The marker as this install sees it: recorded after the install ran, so
			// probe N shows what the sync had persisted before skill N's own write.
			'  if [ "$seen_editable" != "" ] && [ "$marker_file" != "" ]; then',
			'    if [ -f "$marker_file" ]; then',
			'      printf "MARKER %s\n" "$(cat "$marker_file")" >> "$UV_LOG"',
			"    else",
			'      printf "MARKER missing\n" >> "$UV_LOG"',
			"    fi",
			"  fi",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
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

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("bootstraps a missing venv with uv, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11`);
		expect(log).not.toContain("--seed");
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 10,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				join(venv, "bin", "python"),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
				contentHash: pythonSkillContentHash(pythonSkill.packagePath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
				contentHash: pythonSkillContentHash(dependencySkill.packagePath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
				contentHash: pythonSkillContentHash(dependentSkill.packagePath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it("preserves recorded Python skills when a no-skill bootstrap call reuses a warm venv", async () => {
		installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(python);

		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
				contentHash: pythonSkillContentHash(pythonSkill.packagePath),
			},
		]);
	});

	it("keeps a skill-synced venv fast for real sessions after a no-skill bootstrap call", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));
		const syncedLog = readFileSync(logPath, "utf8");

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));
		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toBe(syncedLog);
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			join(venv, "bin", "python"),
		);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
				contentHash: pythonSkillContentHash(goodSkill.packagePath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			join(venv, "bin", "python"),
		);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("lands the base marker before the first skill install and persists each completed one", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		const first = createPythonSkill("agent-a");
		const second = createPythonSkill("agent-b");
		const broken = createPythonSkill("agent-c");
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		process.env.UV_FAIL_ARG = broken.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [first, second, broken] })).resolves.toBe(
			join(venv, "bin", "python"),
		);

		// The failing install exits before the fake uv records its probe, so there is
		// one probe per completed-or-attempted-and-logged install: the first sees the
		// base marker, the second sees the first skill already persisted.
		const probes = markerProbes(logPath);
		expect(probes).toHaveLength(2);
		expect(skillNames(JSON.parse(probes[0] as string))).toEqual([]);
		expect(skillNames(JSON.parse(probes[1] as string))).toEqual([first.importName]);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(skillNames(version)).toEqual([first.importName, second.importName]);
	});

	it("keeps a resumable marker when the skill sync is cancelled mid-install", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		const first = createPythonSkill("agent-a");
		const second = createPythonSkill("agent-b");
		const hanging = createPythonSkill("agent-c");
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		process.env.UV_HANG_ARG = hanging.packagePath;
		const controller = new AbortController();
		const cancelled = ensureKernelPython({
			pythonSkills: [first, second, hanging],
			signal: controller.signal,
		});
		// Attached immediately: the abort below is the expected rejection path.
		cancelled.catch(() => undefined);
		try {
			await waitForFakeUvLog(logPath, `--editable ${hanging.packagePath}`);
			// Mid-sync, with the third install still running: the marker on disk is
			// already a valid base record carrying the two completed installs, which
			// is what lets a session killed here resume instead of rebuilding.
			const midSync = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
			expect(midSync.runtime).toBe(runtimeIdentity);
			expect(skillNames(midSync)).toEqual([first.importName, second.importName]);
		} finally {
			controller.abort();
			await expect(cancelled).rejects.toThrow();
		}

		delete process.env.UV_HANG_ARG;
		await expect(ensureKernelPython({ pythonSkills: [first, second] })).resolves.toBe(join(venv, "bin", "python"));

		const lines = readFileSync(logPath, "utf8").split("\n");
		// One build, ever: the resume took the skills-only path and reinstalled nothing.
		expect(lines.filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(lines.filter((line) => line.includes(`--editable ${first.packagePath}`))).toHaveLength(1);
		expect(lines.filter((line) => line.includes(`--editable ${second.packagePath}`))).toHaveLength(1);
	});

	it("resumes from the base marker when the sync is cancelled before the first install finishes", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		const first = createPythonSkill("agent-a");
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		process.env.UV_HANG_ARG = first.packagePath;
		const controller = new AbortController();
		const cancelled = ensureKernelPython({ pythonSkills: [first], signal: controller.signal });
		cancelled.catch(() => undefined);
		try {
			await waitForFakeUvLog(logPath, `--editable ${first.packagePath}`);
			// No skill has finished yet, so the base marker is all that is on disk -
			// and it is enough: it records the runtime identity this venv was built
			// for, which is what the next boot's skills-only path checks.
			const midSync = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
			expect(midSync.runtime).toBe(runtimeIdentity);
			expect(skillNames(midSync)).toEqual([]);
		} finally {
			controller.abort();
			await expect(cancelled).rejects.toThrow();
		}

		delete process.env.UV_HANG_ARG;
		await expect(ensureKernelPython({ pythonSkills: [first] })).resolves.toBe(join(venv, "bin", "python"));

		const lines = readFileSync(logPath, "utf8").split("\n");
		// One build, ever: the resume re-synced the single missing skill instead of
		// wiping the venv and re-paying the runtime install.
		expect(lines.filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(lines.filter((line) => line.includes(`--editable ${first.packagePath}`))).toHaveLength(2);
	});

	it("leaves the previous marker intact when the atomic swap cannot complete", async () => {
		installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const recorded = createPythonSkill("agent-a");
		const fresh = createPythonSkill("agent-b");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [recorded]);
		const before = readFileSync(join(venv, ".bootstrap-version"), "utf8");
		// Block the swap: the temp path is a non-empty directory, so the temp write
		// fails on every bounded retry and the rename never runs.
		mkdirSync(join(venv, ".bootstrap-version.tmp", "blocker"), { recursive: true });
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython({ pythonSkills: [recorded, fresh] })).rejects.toThrow();

		// The in-place overwrite this replaces would have truncated the marker here,
		// and a partial marker reads as absent: the next boot would rebuild the venv
		// and re-pay the runtime install instead of re-syncing one skill.
		expect(readFileSync(join(venv, ".bootstrap-version"), "utf8")).toBe(before);
	});

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				runtime: "prime-agent-runtime",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [
					{
						importName: pythonSkill.importName,
						packagePath: pythonSkill.packagePath,
						pyprojectPath: pythonSkill.pyprojectPath,
					},
				],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 10,
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("rebuilds a warm venv with a stale rlm runtime", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then',
				'  case "$3" in',
				'    "import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11`);
	});

	it("rejects a freshly installed venv whose runtime is not ready", async () => {
		installFakeUv({ venvRuntimeReady: false });
		const base = join(tempDir, "kernel-venv");
		// Bootstrap builds into a generation directory next to the base; the base itself
		// only names the family and holds the lock.
		const venv = await activeKernelVenvDir(base);
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		const progress: string[] = [];

		const failure = await ensureKernelPython({ onProgress: (message) => progress.push(message) }).then(
			() => undefined,
			(error: Error) => error,
		);

		expect(failure?.message).toMatch(/missing a current prime-agent-runtime with callable rlm\.run/);
		expect(failure?.message).toContain(venv);
		expect(progress).not.toContain("✓ ready");
	});

	it("rejects a freshly installed venv missing a default package the install claimed", async () => {
		installFakeUv({ venvUnreadyImports: ["yaml"] });
		const base = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml")]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["dill"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then',
				'  case "$3" in',
				'    "import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/PRIME_AGENT_KERNEL_PYTHON points to a Python missing/);
	});
});
