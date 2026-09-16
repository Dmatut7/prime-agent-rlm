import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeKernelVenvDir, ensureKernelPython } from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

/**
 * A `uv` whose `venv` step fails the way a full disk fails: exit 2 with uv's own diagnostic on
 * stderr. Everything before `venv` succeeds, so the failure the user sees is exactly this step.
 */
function installEnospcUv(): void {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			'if [ "$1" = "python" ]; then exit 0; fi',
			'if [ "$1" = "venv" ]; then',
			"  printf 'error: Failed to create virtual environment\nCaused by: failed to create file ''pyvenv.cfg'': No space left on device (os error 28)\n' >&2",
			"  exit 2",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

/** A `uv` whose `venv` step never returns, the shape of a wedged network/proxy. */
function installHangingUv(): void {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			'if [ "$1" = "python" ]; then exit 0; fi',
			'if [ "$1" = "venv" ]; then',
			"  sleep 60",
			"  exit 0",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

/** A `uv` that builds a working venv and logs every invocation. */
function installWorkingUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then exit 0; fi',
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then exit 0; fi',
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	return logPath;
}

/** Rewrites the warm venv's python so the default-packages probe fails while everything else passes. */
function breakDefaultPackagesProbe(venv: string): void {
	writeExecutable(
		join(venv, "bin", "python"),
		[
			"#!/bin/sh",
			'if [ "$1" = "-P" ] && [ "$2" = "-" ]; then exit 1; fi',
			'if [ "$1" = "-P" ] && [ "$2" = "-c" ]; then exit 0; fi',
			"exit 0",
			"",
		].join("\n"),
	);
}

describe("kernel bootstrap failure diagnostics (r36 INSB-3/INSB-4)", () => {
	beforeEach(async () => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-diag-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.PRIME_AGENT_KERNEL_UV_TIMEOUT_MS;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			chmodSync(tempDir, 0o700);
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("carries uv's own stderr into the failure instead of a bare exit code", async () => {
		installEnospcUv();
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");

		let message = "";
		try {
			await ensureKernelPython();
			expect.unreachable("bootstrap should have failed");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("No space left on device");
		expect(message).toContain("uv venv");
	});

	it("does not blame the network when uv named a non-network cause", async () => {
		installEnospcUv();
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");

		await expect(ensureKernelPython()).rejects.not.toThrow(/First-time setup needs internet/);
	});

	it("bounds a uv step that never returns", { timeout: 15_000 }, async () => {
		installHangingUv();
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_UV_TIMEOUT_MS = "500";

		await expect(ensureKernelPython()).rejects.toThrow(/timed out after 500ms/);
	});

	it("reports an unwritable venv directory with the designed guidance, not a bare errno", async () => {
		const readOnly = join(tempDir, "read-only");
		mkdirSync(readOnly);
		chmodSync(readOnly, 0o500);
		process.env.PRIME_AGENT_KERNEL_VENV = join(readOnly, "kernel-venv");

		let message = "";
		try {
			await ensureKernelPython();
			expect.unreachable("bootstrap should have failed");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("couldn't create");
		expect(message).toContain("PRIME_AGENT_KERNEL_PYTHON");
	});

	it("rebuilds a warm venv whose default packages no longer import", { timeout: 30_000 }, async () => {
		const logPath = installWorkingUv();
		const base = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = base;
		const venv = await activeKernelVenvDir(base);

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		breakDefaultPackagesProbe(venv);
		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		const venvCreations = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("venv ")).length;
		expect(venvCreations).toBeGreaterThanOrEqual(2);
	});
});
