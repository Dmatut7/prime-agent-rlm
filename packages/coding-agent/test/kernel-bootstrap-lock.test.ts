import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	ensureKernelPython,
	KernelBootstrapAbortedError,
	KernelBootstrapLockTimeoutError,
} from "../src/core/kernel/bootstrap.js";

/** Sentinel for "the bounded wait in this test ran out before the code under test settled". */
const BUDGET_EXHAUSTED = Symbol("budget-exhausted");
/** A pid outside every supported pid_max, so the holder is provably gone. */
const DEAD_PID = 999_999_999;

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
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

/** Fake uv whose interpreter install takes long enough to be cancelled mid-flight. */
function installSlowFakeUv(): void {
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
			// The first uv call of a cold bootstrap is the slow one, so an abort lands
			// while a child is genuinely in flight rather than between two fast calls.
			'if [ "$1" = "python" ]; then',
			"  sleep 5",
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
			"exit 0",
			"",
		].join("\n"),
	);
}

/**
 * Settles `promise` within `budgetMs` and never hangs the run: the code under test had no
 * bound at all before this change, so the red evidence has to be a failed assertion rather
 * than a wedged test file. Rejections are returned as values, so a late rejection after the
 * budget cannot surface as an unhandled error either.
 */
async function settle(promise: Promise<unknown>, budgetMs: number): Promise<unknown> {
	const guarded = promise.then(
		(value) => value,
		(error) => error,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			guarded,
			new Promise<typeof BUDGET_EXHAUSTED>((resolve) => {
				timer = setTimeout(() => resolve(BUDGET_EXHAUSTED), budgetMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function lockDirFor(venv: string): string {
	return `${venv}.bootstrap.lock`;
}

function holdLock(venv: string, pid: number | "missing"): string {
	const lockDir = lockDirFor(venv);
	mkdirSync(lockDir, { recursive: true });
	if (pid !== "missing") writeFileSync(join(lockDir, "pid"), `${pid}\n`, "utf8");
	return lockDir;
}

describe("kernel bootstrap lock", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-lock-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		// Hermeticity: an ambient agent dir (a kernel session exports one) would make the
		// lock bound depend on the developer's real settings.json.
		delete process.env[ENV_AGENT_DIR];
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		// Removing the tree also unwedges a boot still spinning on the lock: its next
		// mkdir fails with ENOENT, which rejects the shared promise instead of hanging.
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
		process.env = originalEnv;
	});

	it("fails with an actionable typed error once the lock wait exceeds its bound", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = holdLock(venv, process.pid);
		const startedAt = Date.now();

		const outcome = await settle(ensureKernelPython({ lockTimeoutMs: 200 }), 5_000);
		const waitedMs = Date.now() - startedAt;

		expect(outcome).toBeInstanceOf(KernelBootstrapLockTimeoutError);
		expect(waitedMs).toBeGreaterThanOrEqual(200);
		expect(waitedMs).toBeLessThan(5_000);
		const error = outcome as KernelBootstrapLockTimeoutError;
		expect(error.lockDir).toBe(lockDir);
		expect(error.holderPid).toBe(process.pid);
		// F13: turning "slow" into "failed" is only acceptable with a way out.
		expect(error.message).toContain(lockDir);
		expect(error.message).toContain(String(process.pid));
		expect(error.message).toContain("kernelBootstrap.lockTimeoutMs");
		expect(error.message).toContain("PRIME_AGENT_KERNEL_PYTHON");
		// The holder's lock is not ours to steal.
		expect(existsSync(lockDir)).toBe(true);
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
	});

	it("reads the bound from settings when the caller passes none", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		holdLock(venv, process.pid);
		const agentDir = join(tempDir, "agent-dir");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ kernelBootstrap: { lockTimeoutMs: 200 } }));
		process.env[ENV_AGENT_DIR] = agentDir;

		const startedAt = Date.now();
		const outcome = await settle(ensureKernelPython(), 5_000);
		const waitedMs = Date.now() - startedAt;

		expect(outcome).toBeInstanceOf(KernelBootstrapLockTimeoutError);
		expect(waitedMs).toBeLessThan(5_000);
	});

	it("stops waiting when the session waiting on it aborts", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		holdLock(venv, process.pid);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		const startedAt = Date.now();
		// lockTimeoutMs 0 is the explicit "wait forever" opt-out, so only the abort can end this.
		const outcome = await settle(ensureKernelPython({ signal: controller.signal, lockTimeoutMs: 0 }), 5_000);
		const waitedMs = Date.now() - startedAt;

		expect(outcome).toBeInstanceOf(KernelBootstrapAbortedError);
		expect(waitedMs).toBeLessThan(3_000);
	});

	it("refuses to start a bootstrap the caller already aborted", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const controller = new AbortController();
		controller.abort();

		const outcome = await settle(ensureKernelPython({ signal: controller.signal, lockTimeoutMs: 0 }), 5_000);

		expect(outcome).toBeInstanceOf(KernelBootstrapAbortedError);
		expect(existsSync(lockDirFor(venv))).toBe(false);
	});

	it("keeps a shared bootstrap alive while another session still wants it", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		holdLock(venv, process.pid);
		const controller = new AbortController();

		// Both callers share one memoized bootstrap. The aborting one must not cancel the
		// work the other one is still waiting for: the survivor rides out its own bound and
		// gets the timeout, not the cancellation.
		const abandoning = settle(ensureKernelPython({ signal: controller.signal, lockTimeoutMs: 600 }), 5_000);
		const surviving = settle(ensureKernelPython({ lockTimeoutMs: 600 }), 5_000);
		setTimeout(() => controller.abort(), 50);

		const survivorOutcome = await surviving;
		expect(survivorOutcome).toBeInstanceOf(KernelBootstrapLockTimeoutError);
		expect(await abandoning).toBeInstanceOf(KernelBootstrapLockTimeoutError);
	});

	it("cancels a shared bootstrap once every session waiting on it aborted", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		holdLock(venv, process.pid);
		const first = new AbortController();
		const second = new AbortController();

		const firstOutcome = settle(ensureKernelPython({ signal: first.signal, lockTimeoutMs: 0 }), 5_000);
		const secondOutcome = settle(ensureKernelPython({ signal: second.signal, lockTimeoutMs: 0 }), 5_000);
		setTimeout(() => first.abort(), 30);
		setTimeout(() => second.abort(), 90);

		expect(await firstOutcome).toBeInstanceOf(KernelBootstrapAbortedError);
		expect(await secondOutcome).toBeInstanceOf(KernelBootstrapAbortedError);
	});

	it("cancels an in-flight uv install when the waiting session aborts", async () => {
		installSlowFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);

		const startedAt = Date.now();
		const outcome = await settle(ensureKernelPython({ signal: controller.signal, lockTimeoutMs: 10_000 }), 9_000);
		const waitedMs = Date.now() - startedAt;

		// The signal reaches run(uv) as a spawn signal, so the child is killed at the abort
		// instead of the boot riding out a 5s install nobody wants any more. Without the
		// spawn signal the rejection only arrives when that child exits on its own (~5s).
		expect(outcome).toBeInstanceOf(KernelBootstrapAbortedError);
		expect(waitedMs).toBeLessThan(2_500);
	});

	it("refuses to probe an override interpreter for a session that already aborted", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(overridePython, ["#!/bin/sh", "exit 0", ""].join("\n"));
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;
		const controller = new AbortController();
		controller.abort();

		const outcome = await settle(ensureKernelPython({ signal: controller.signal }), 5_000);

		// The override path takes no lock, so without the early check a cancelled session
		// would still spawn every readiness probe and then report success.
		expect(outcome).toBeInstanceOf(KernelBootstrapAbortedError);
	});

	it("breaks a lock whose holder pid is gone", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = holdLock(venv, DEAD_PID);

		const python = await ensureKernelPython({ lockTimeoutMs: 5_000 });

		expect(python).toMatch(/bin[\\/]python$/);
		expect(existsSync(join(dirname(dirname(python)), ".bootstrap-version"))).toBe(true);
		// Positive control for the timeout path: a breakable lock never reaches the bound,
		// and the boot releases the lock it took.
		expect(existsSync(lockDir)).toBe(false);
	});

	it("breaks a pid-less lock older than the stale window", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = holdLock(venv, "missing");
		const stale = (Date.now() - 31_000) / 1000;
		utimesSync(lockDir, stale, stale);

		const python = await ensureKernelPython({ lockTimeoutMs: 5_000 });

		expect(python).toMatch(/bin[\\/]python$/);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("retries on the next call after a lock timeout instead of caching the failure", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lockDir = holdLock(venv, process.pid);

		expect(await settle(ensureKernelPython({ lockTimeoutMs: 150 }), 5_000)).toBeInstanceOf(
			KernelBootstrapLockTimeoutError,
		);

		// The holder is gone now: the same call must run the bootstrap again rather than
		// replay the memoized rejection.
		rmSync(lockDir, { recursive: true, force: true });
		const python = await ensureKernelPython({ lockTimeoutMs: 5_000 });
		expect(python).toMatch(/bin[\\/]python$/);
	});
});
