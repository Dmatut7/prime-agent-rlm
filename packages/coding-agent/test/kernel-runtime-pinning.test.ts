import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeKernelVenvDir,
	DEFAULT_RLM_EXTRA_IMPORT_LABELS,
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	isPinnedRequirementSpec,
	kernelInstallArgs,
	REGISTRY_RUNTIME_ALLOW_ENV,
	REGISTRY_RUNTIME_SPEC_ENV,
	resolveKernelRuntimeInstall,
	resolveRuntimeIdentity,
	resolveRuntimeSourceDir,
	runtimeCandidateDirs,
} from "../src/core/kernel/bootstrap.js";

/** The unregistered registry name the kernel runtime must never be installed as a bare name. */
const RUNTIME_NAME = "prime-agent-runtime";

/** The default packages as [uv requirement, kernel import name, prompt label]. */
const EXPECTED_DEFAULT_PACKAGES: ReadonlyArray<readonly [string, string, string]> = [
	["requests==2.34.2", "requests", "requests"],
	["httpx==0.28.1", "httpx", "httpx"],
	["pyyaml==6.0.3", "yaml", "yaml (PyYAML)"],
	["tomli==2.4.1", "tomli", "tomli"],
	["python-dotenv==1.2.3", "dotenv", "dotenv (python-dotenv)"],
	["pandas==3.0.5", "pandas", "pandas"],
	["numpy==2.4.6", "numpy", "numpy"],
	["scipy==1.17.1", "scipy", "scipy"],
	["beautifulsoup4==4.15.0", "bs4", "bs4 (Beautiful Soup)"],
	["lxml==6.1.3", "lxml", "lxml"],
	["pydantic==2.13.5", "pydantic", "pydantic"],
	["tyro==1.0.16", "tyro", "tyro"],
];

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

/**
 * An install shape with no runtime source: the package directory is redirected to a temp tree that
 * ships none, while the module directory stays where bootstrap.ts really lives (that is the layout
 * of a build whose assets went missing, and the only layout where the registry fallback is reached).
 */
function runtimeFreeInstallShape(): { moduleDir: string; packageDir: string } {
	const packageDir = join(tempDir, "packages", "coding-agent");
	return { moduleDir: join(packageDir, "dist", "bundle"), packageDir };
}

/** Precondition shared by the runtime-free cases: the shape resolves to nothing on disk. */
function assertRuntimeFreeShape(shape: { moduleDir: string; packageDir: string }): void {
	mkdirSync(shape.moduleDir, { recursive: true });
	expect(runtimeCandidateDirs(shape).filter((candidate) => existsSync(candidate))).toEqual([]);
}

/** A runtime source tree (`pyproject.toml` + `src/rlm/*.py`) for the local-source arm. */
function writeLocalRuntimeSource(parentDir: string): string {
	const sourceDir = join(parentDir, RUNTIME_NAME);
	mkdirSync(join(sourceDir, "src", "rlm"), { recursive: true });
	writeFileSync(join(sourceDir, "pyproject.toml"), `[project]\nname = "${RUNTIME_NAME}"\nversion = "0.0.0"\n`);
	writeFileSync(join(sourceDir, "src", "rlm", "__init__.py"), "def run():\n    return None\n");
	return sourceDir;
}

/**
 * The observation the negative controls rely on: whitespace-separated tokens that name the runtime
 * *without* pinning a version. A hit means the bare registry name was passed as a requirement.
 */
function bareRuntimeTokens(text: string): string[] {
	return text
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token === RUNTIME_NAME);
}

/** Same shape as the fake `uv` in kernel-bootstrap.test.ts: records argv, plants a venv python. */
function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
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

describe("kernel runtime pinning", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-pinning-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
		delete process.env.UV_LOG;
		delete process.env[REGISTRY_RUNTIME_ALLOW_ENV];
		delete process.env[REGISTRY_RUNTIME_SPEC_ENV];
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("fails closed when the install ships no local runtime source", async () => {
		const shape = runtimeFreeInstallShape();
		// Precondition: the redirect really is a runtime-free shape. Without this the negative
		// control below would silently be exercising the local-source arm instead.
		assertRuntimeFreeShape(shape);
		expect(await resolveRuntimeSourceDir(shape)).toBeNull();

		const outcome = await resolveRuntimeIdentity(shape).then(
			(identity) => `resolved:${identity}`,
			(error: Error) => error,
		);

		// Old code resolved this to the bare registry name; the identity must not exist at all.
		expect(outcome).toBeInstanceOf(Error);
		const message = (outcome as Error).message;
		expect(message).toContain(RUNTIME_NAME);
		// Why: the registry name is unclaimed, so installing it means running a stranger's package.
		expect(message).toMatch(/unregistered/i);
		expect(message).toMatch(/register/i);
		// Ways out: a build that ships runtime source, a pre-installed interpreter, or the explicit
		// opt-in with an exact pin.
		expect(message).toContain("PRIME_AGENT_KERNEL_PYTHON");
		expect(message).toContain(REGISTRY_RUNTIME_ALLOW_ENV);
		expect(message).toContain(REGISTRY_RUNTIME_SPEC_ENV);
	});

	it("never builds an install command naming the bare registry runtime", async () => {
		const shape = runtimeFreeInstallShape();
		assertRuntimeFreeShape(shape);

		// Positive control for the observation: the detector does see the bare requirement the old
		// fallback produced, so "no token" below means "not present", not "not looked for".
		const bareFallbackArgs = kernelInstallArgs("/venv/bin/python", RUNTIME_NAME);
		expect(bareRuntimeTokens(bareFallbackArgs.join(" "))).toEqual([RUNTIME_NAME]);

		// Negative control: with no local runtime source, no requirement is produced at all, so the
		// bare name cannot reach an install command. The failure is a typed one, so callers can tell
		// "this installation cannot be bootstrapped safely" apart from a real install error.
		const outcome = await resolveKernelRuntimeInstall(shape).then(
			(install) => `resolved:${install.requirement}`,
			(error: Error) => error,
		);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).name).toBe("KernelRuntimeSourceUnavailableError");
	});

	it("allows a registry install only behind the explicit switch and an exact pin", async () => {
		const shape = runtimeFreeInstallShape();
		assertRuntimeFreeShape(shape);
		expect(await resolveRuntimeSourceDir(shape)).toBeNull();
		const spec = `${RUNTIME_NAME}==1.2.3`;
		process.env[REGISTRY_RUNTIME_ALLOW_ENV] = "1";
		process.env[REGISTRY_RUNTIME_SPEC_ENV] = spec;

		const install = await resolveKernelRuntimeInstall(shape);

		expect(install.sourceDir).toBeNull();
		expect(install.requirement).toBe(spec);
		expect(install.identity).toBe(`registry:${spec}`);
		expect(await resolveRuntimeIdentity(shape)).toBe(`registry:${spec}`);
		// The opted-in path builds a real install command, and it still never names the bare runtime.
		expect(kernelInstallArgs("/venv/bin/python", install.requirement)).toContain(spec);
		expect(bareRuntimeTokens(kernelInstallArgs("/venv/bin/python", install.requirement).join(" "))).toEqual([]);
	});

	it("refuses the registry switch without an exact pinned spec", async () => {
		const shape = runtimeFreeInstallShape();
		mkdirSync(shape.moduleDir, { recursive: true });
		process.env[REGISTRY_RUNTIME_ALLOW_ENV] = "1";

		const missingSpec = await resolveKernelRuntimeInstall(shape).then(
			(install) => `resolved:${install.requirement}`,
			(error: Error) => error,
		);
		expect(missingSpec).toBeInstanceOf(Error);
		expect((missingSpec as Error).message).toContain(REGISTRY_RUNTIME_SPEC_ENV);

		for (const unpinned of [RUNTIME_NAME, `${RUNTIME_NAME}>=1.2.3`, `${RUNTIME_NAME}==1.2.*`]) {
			process.env[REGISTRY_RUNTIME_SPEC_ENV] = unpinned;
			const outcome = await resolveKernelRuntimeInstall(shape).then(
				(install) => `resolved:${install.requirement}`,
				(error: Error) => error,
			);
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toMatch(/pinned|exact/i);
		}
	});

	it("keeps installing the runtime source shipped next to a source checkout", async () => {
		const packageDir = join(tempDir, "packages", "coding-agent");
		const moduleDir = join(packageDir, "src", "core", "kernel");
		mkdirSync(moduleDir, { recursive: true });
		const sourceDir = writeLocalRuntimeSource(tempDir);

		const install = await resolveKernelRuntimeInstall({ moduleDir, packageDir });

		expect(install.sourceDir).toBe(sourceDir);
		expect(install.requirement).toBe(sourceDir);
		expect(install.identity).toMatch(/^sha256:/);
		expect(await resolveRuntimeIdentity({ moduleDir, packageDir })).toBe(install.identity);
		expect(bareRuntimeTokens(kernelInstallArgs("/venv/bin/python", install.requirement).join(" "))).toEqual([]);
	});

	it("boots a real checkout through uv with pinned default packages and no bare runtime name", async () => {
		const logPath = installFakeUv();
		const base = join(tempDir, "kernel-venv");
		const venv = await activeKernelVenvDir(base);
		process.env.PRIME_AGENT_KERNEL_VENV = base;

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		// What a real boot asks uv for: the exact pins, asserted from the literal list above, so this
		// cannot pass while the module ships bare names.
		for (const [uvArg] of EXPECTED_DEFAULT_PACKAGES) {
			expect(log).toContain(uvArg);
		}
		expect(bareRuntimeTokens(log)).toEqual([]);
	});

	it("pins every default package and keeps the exported contract", () => {
		// Guard the data-driven assertions: an empty list would satisfy "all pinned" vacuously.
		expect(DEFAULT_RLM_EXTRA_UV_ARGS.length).toBe(12);
		expect(DEFAULT_RLM_EXTRA_UV_ARGS).toEqual(EXPECTED_DEFAULT_PACKAGES.map(([uvArg]) => uvArg));
		expect(DEFAULT_RLM_EXTRA_IMPORT_NAMES).toEqual(EXPECTED_DEFAULT_PACKAGES.map(([, importName]) => importName));
		expect(DEFAULT_RLM_EXTRA_IMPORT_LABELS).toEqual(EXPECTED_DEFAULT_PACKAGES.map(([, , label]) => label));

		expect(DEFAULT_RLM_EXTRA_UV_ARGS.filter((uvArg) => !isPinnedRequirementSpec(uvArg))).toEqual([]);

		// Positive control: the same predicate catches an unpinned requirement, so the assertion above
		// is a statement about the list rather than a predicate that always passes.
		expect(["requests", ...DEFAULT_RLM_EXTRA_UV_ARGS].filter((uvArg) => !isPinnedRequirementSpec(uvArg))).toEqual([
			"requests",
		]);
		expect(isPinnedRequirementSpec("requests")).toBe(false);
		expect(isPinnedRequirementSpec("requests>=2.0")).toBe(false);
		expect(isPinnedRequirementSpec("requests==2.32.*")).toBe(false);
		expect(isPinnedRequirementSpec("requests==")).toBe(false);
		expect(isPinnedRequirementSpec("requests==2.32.5")).toBe(true);
		expect(isPinnedRequirementSpec("beautifulsoup4==4.15.0")).toBe(true);
	});
});
