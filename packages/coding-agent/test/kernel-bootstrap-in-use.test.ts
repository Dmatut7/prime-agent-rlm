import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";
let base = "";
const children: ChildProcess[] = [];
const notWindowsHost = process.platform !== "win32";
const runsAsRoot = process.getuid?.() === 0;
const GENERATION_NAME = /^kernel-venv-[0-9a-f]{12}$/;

/** Undo a permission case so the temp tree stays removable (chmodSync has no recursive form). */
function chmodWritable(root: string): void {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(root);
	} catch {
		return;
	}
	if (stats.isSymbolicLink()) return;
	if (stats.isDirectory()) {
		chmodSync(root, 0o755);
		for (const entry of readdirSync(root)) chmodWritable(join(root, entry));
		return;
	}
	chmodSync(root, 0o644);
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

/** A pid that existed a moment ago and is reaped now: never a live reference holder. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	const pid = Number.parseInt(result.stdout.trim(), 10);
	expect(Number.isInteger(pid) && pid > 0).toBe(true);
	return pid;
}

/** A live process whose pid + start id make a verifiable in-use reference. */
function livePid(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	expect(child.pid).toBeDefined();
	children.push(child);
	return child.pid as number;
}

/** The reference format documented by src/core/kernel/venv-in-use.ts. */
function writeInUseReference(venvDir: string, pid: number, sessionId = "session-1"): string {
	const dir = join(venvDir, ".in-use");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, String(pid));
	writeFileSync(file, `${JSON.stringify({ version: 1, pid, sessionId, recordedAt: new Date().toISOString() })}\n`, {
		mode: 0o600,
	});
	return file;
}

/** The tombstone format documented by src/core/kernel/venv-in-use.ts. */
function writeInUseTombstone(venvDir: string, pid: number, sessionId = "session-1"): string {
	const dir = join(venvDir, ".in-use");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `unverified-${pid}`);
	writeFileSync(
		file,
		`${JSON.stringify({
			version: 1,
			pid,
			sessionId,
			unverified: true,
			reason: "ELOOP: too many symbolic links encountered",
			recordedAt: new Date().toISOString(),
		})}\n`,
		{ mode: 0o600 },
	);
	return file;
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
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

/** A generation directory that looks built but has no usable base record. */
function createPartialGeneration(suffix: string): string {
	const dir = join(tempDir, `kernel-venv-${suffix}`);
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFakePython(join(dir, "bin", "python"), ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
	writeFileSync(join(dir, "previous-build-marker"), "keep me\n");
	return dir;
}

function generationNames(): string[] {
	return readdirSync(tempDir)
		.filter((name) => GENERATION_NAME.test(name))
		.sort();
}

function dirTreeBytes(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		total += entry.isDirectory() ? dirTreeBytes(full) : statSync(full).size;
	}
	return total;
}

function setRecency(dirsOldestFirst: readonly string[]): void {
	for (const [index, dir] of dirsOldestFirst.entries()) {
		const stamp = new Date(Date.now() - (dirsOldestFirst.length - index) * 60_000);
		utimesSync(dir, stamp, stamp);
	}
}

describe("kernel bootstrap builds into versioned generation directories", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-in-use-"));
		base = join(tempDir, "kernel-venv");
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
		process.env.PRIME_AGENT_KERNEL_VENV = base;
	});

	afterEach(() => {
		for (const child of children.splice(0)) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
		process.env = originalEnv;
		if (tempDir) {
			chmodWritable(tempDir);
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
			base = "";
		}
	});

	it("returns a python inside a generation directory, not the shared base path", async () => {
		installFakeUv();

		const python = await ensureKernelPython();

		expect(python).toBe(join(dirname(python), "python"));
		const generation = dirname(dirname(python));
		expect(basename(generation)).toMatch(GENERATION_NAME);
		expect(existsSync(join(base, "bin", "python"))).toBe(false);
		const record = JSON.parse(readFileSync(join(generation, ".bootstrap-version"), "utf8"));
		expect(record.runtime).toBe(runtimeIdentity);
		expect(record.extraUvArgs).toEqual(DEFAULT_RLM_EXTRA_UV_ARGS);
	}, 60_000);

	it("serializes on the base-keyed bootstrap lock across generations", async () => {
		installFakeUv();
		// A stale lock at the base path (the pre-generation spelling) must be the one this
		// boot breaks: the lock is family-wide, not per generation.
		const lockDir = `${base}.bootstrap.lock`;
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "pid"), `${deadPid()}\n`, "utf8");

		const python = await ensureKernelPython();

		expect(basename(dirname(dirname(python)))).toMatch(GENERATION_NAME);
		expect(existsSync(lockDir)).toBe(false);
	}, 60_000);

	it("builds a new generation next to one a kernel is still running from", async () => {
		installFakeUv();
		const running = createPartialGeneration("ffffffffffff");
		writeFileSync(join(running, ".bootstrap-version"), `${JSON.stringify({ schema: 1 })}\n`);
		const pid = livePid();
		writeInUseReference(running, pid, "long-lived-session");
		const inodeBefore = statSync(running).ino;

		const python = await ensureKernelPython();

		const generation = dirname(dirname(python));
		expect(generation).not.toBe(running);
		expect(statSync(running).ino).toBe(inodeBefore);
		expect(readFileSync(join(running, "previous-build-marker"), "utf8")).toBe("keep me\n");
		expect(existsSync(join(running, ".in-use", String(pid)))).toBe(true);
		expect(generationNames()).toEqual(["kernel-venv-ffffffffffff", basename(generation)].sort());
	}, 60_000);

	it("defers instead of rebuilding a generation a kernel is running from", async () => {
		installFakeUv();
		const firstPython = await ensureKernelPython();
		const generation = dirname(dirname(firstPython));
		// The generation loses its base record (a partial or corrupted build) while a
		// kernel still runs from it: it must be reported, not deleted or renamed.
		rmSync(join(generation, ".bootstrap-version"));
		writeFileSync(join(generation, "previous-build-marker"), "keep me\n");
		const pid = livePid();
		writeInUseReference(generation, pid, "session-in-use");
		const inodeBefore = statSync(generation).ino;
		const uvLog = readFileSync(join(tempDir, "uv.log"), "utf8");

		await expect(ensureKernelPython()).rejects.toThrow(/venv rebuild deferred: 1 kernels in use/);

		expect(statSync(generation).ino).toBe(inodeBefore);
		expect(readFileSync(join(generation, "previous-build-marker"), "utf8")).toBe("keep me\n");
		expect(existsSync(join(generation, ".in-use", String(pid)))).toBe(true);
		expect(generationNames()).toEqual([basename(generation)]);
		// No second build was started for the deferred identity.
		expect(readFileSync(join(tempDir, "uv.log"), "utf8")).toBe(uvLog);
	}, 60_000);

	it.skipIf(runsAsRoot)(
		"defers when the reference state of a generation cannot be read",
		async () => {
			installFakeUv();
			const firstPython = await ensureKernelPython();
			const generation = dirname(dirname(firstPython));
			rmSync(join(generation, ".bootstrap-version"));
			const reference = writeInUseReference(generation, livePid(), "session-in-use");
			chmodSync(dirname(reference), 0o000);

			const uvLog = readFileSync(join(tempDir, "uv.log"), "utf8");
			const inodeBefore = statSync(generation).ino;

			try {
				// The count is unknown, and saying so is the point: unreadable bookkeeping
				// defers the rebuild instead of deleting a directory that may be in use.
				await expect(ensureKernelPython()).rejects.toThrow(
					/venv rebuild deferred: 0 kernels in use[\s\S]*could not be read/,
				);
				expect(statSync(generation).ino).toBe(inodeBefore);
				expect(existsSync(join(generation, ".bootstrap-version"))).toBe(false);
				expect(readFileSync(join(tempDir, "uv.log"), "utf8")).toBe(uvLog);
			} finally {
				chmodSync(dirname(reference), 0o700);
			}
			// Unreadable bookkeeping is left alone, not swept: it may name a live kernel.
			expect(existsSync(reference)).toBe(true);
		},
		60_000,
	);

	it("rebuilds an unreferenced generation in place (positive control)", async () => {
		installFakeUv();
		const firstPython = await ensureKernelPython();
		const generation = dirname(dirname(firstPython));
		rmSync(join(generation, ".bootstrap-version"));
		writeFileSync(join(generation, "previous-build-marker"), "keep me\n");

		await expect(ensureKernelPython()).resolves.toBe(firstPython);

		expect(existsSync(join(generation, "previous-build-marker"))).toBe(false);
		expect(JSON.parse(readFileSync(join(generation, ".bootstrap-version"), "utf8")).runtime).toBe(runtimeIdentity);
		expect(generationNames()).toEqual([basename(generation)]);
	}, 60_000);

	it("sweeps a reference whose pid is dead and rebuilds in place", async () => {
		installFakeUv();
		const firstPython = await ensureKernelPython();
		const generation = dirname(dirname(firstPython));
		rmSync(join(generation, ".bootstrap-version"));
		writeFileSync(join(generation, "previous-build-marker"), "keep me\n");
		const dead = deadPid();
		const reference = writeInUseReference(generation, dead, "session-gone");

		await expect(ensureKernelPython()).resolves.toBe(firstPython);

		expect(existsSync(reference)).toBe(false);
		expect(existsSync(join(generation, "previous-build-marker"))).toBe(false);
	}, 60_000);

	it("keeps an unreferenced generation within retention and every referenced one", async () => {
		installFakeUv();
		const python = await ensureKernelPython();
		const active = dirname(dirname(python));
		const oldest = createPartialGeneration("aaaaaaaaaaaa");
		const middle = createPartialGeneration("bbbbbbbbbbbb");
		const referenced = createPartialGeneration("cccccccccccc");
		const referencedPid = livePid();
		writeInUseReference(referenced, referencedPid, "long-lived-session");
		setRecency([oldest, middle, referenced, active]);
		const uvLog = readFileSync(join(tempDir, "uv.log"), "utf8");

		await expect(ensureKernelPython()).resolves.toBe(python);

		const names = generationNames();
		expect(names).not.toContain("kernel-venv-aaaaaaaaaaaa");
		expect(names).toContain("kernel-venv-bbbbbbbbbbbb");
		expect(names).toContain("kernel-venv-cccccccccccc");
		expect(names).toContain(basename(active));
		// A referenced generation survives however many unreferenced ones are pruned.
		expect(existsSync(join(referenced, ".in-use", String(referencedPid)))).toBe(true);
		// The warm boot rebuilt nothing.
		expect(readFileSync(join(tempDir, "uv.log"), "utf8")).toBe(uvLog);
		// I-14 disk account, fs level: active + referenced generations + one retained copy.
		const sizes = names.map((name) => dirTreeBytes(join(tempDir, name)));
		expect(sizes.length).toBeGreaterThan(0);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(sizes.length * Math.max(...sizes));
		expect(sizes.length).toBeLessThanOrEqual(3);
	}, 120_000);

	// Outcome-level defence in depth: an unreadable reference directory also blocks the
	// sweep's own deletion, so the rule that protects it is nailed by the report assertion
	// in kernel-venv-in-use.test.ts and by the referenced-generation case above.
	it.skipIf(runsAsRoot)(
		"leaves a generation with unreadable references on disk",
		async () => {
			installFakeUv();
			const python = await ensureKernelPython();
			const active = dirname(dirname(python));
			const unreadable = createPartialGeneration("aaaaaaaaaaaa");
			const reference = writeInUseReference(unreadable, livePid(), "session-in-use");
			chmodSync(dirname(reference), 0o000);
			const spare = createPartialGeneration("bbbbbbbbbbbb");
			setRecency([unreadable, spare, active]);

			try {
				await expect(ensureKernelPython()).resolves.toBe(python);
				expect(generationNames()).toContain("kernel-venv-aaaaaaaaaaaa");
			} finally {
				chmodSync(dirname(reference), 0o700);
			}
		},
		120_000,
	);

	it("leaves the legacy unsuffixed venv directory alone and reports it once", async () => {
		installFakeUv();
		mkdirSync(join(base, "bin"), { recursive: true });
		writeFakePython(join(base, "bin", "python"), ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(join(base, "legacy-marker"), "still here\n");
		writeFileSync(join(base, "pyvenv.cfg"), "home = /usr/bin\n");
		const progress: string[] = [];
		const onProgress = (message: string): void => {
			progress.push(message);
		};

		const python = await ensureKernelPython({ onProgress });

		expect(dirname(dirname(python))).not.toBe(base);
		expect(readFileSync(join(base, "legacy-marker"), "utf8")).toBe("still here\n");
		expect(existsSync(join(base, ".in-use"))).toBe(false);
		expect(existsSync(join(base, ".bootstrap-version"))).toBe(false);
		const notes = progress.filter((message) => message.includes("pre-generation kernel venv"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain(base);

		// Reported at most once per process, so a warm boot does not repeat it.
		const secondProgress: string[] = [];
		await ensureKernelPython({ onProgress: (message) => secondProgress.push(message) });
		expect(secondProgress.filter((message) => message.includes("pre-generation kernel venv"))).toHaveLength(0);
	}, 60_000);

	it("leaves a partial generation with a failed build behind nothing to sweep", async () => {
		installFakeUv();
		process.env.UV_FAIL_ARG = "dill";

		await expect(ensureKernelPython()).rejects.toThrow(/Failed to set up the Python kernel runtime/);

		// The failed build's directory carries no base record, so the next boot can
		// reclaim or rebuild it; nothing references it and no generation was renamed.
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".bootstrap.lock"))).toHaveLength(0);
		process.env.UV_FAIL_ARG = "";
		const python = await ensureKernelPython();
		expect(basename(dirname(dirname(python)))).toMatch(GENERATION_NAME);
		expect(JSON.parse(readFileSync(join(dirname(dirname(python)), ".bootstrap-version"), "utf8")).runtime).toBe(
			runtimeIdentity,
		);
	}, 60_000);

	it("defers a rebuild when a kernel could only leave a tombstone", async () => {
		// F1: a kernel whose reference write failed must not leave its generation looking free.
		installFakeUv();
		const firstPython = await ensureKernelPython();
		const generation = dirname(dirname(firstPython));
		rmSync(join(generation, ".bootstrap-version"));
		const pid = livePid();
		const tombstone = writeInUseTombstone(generation, pid, "session-unverified");
		const inodeBefore = statSync(generation).ino;
		const uvLog = readFileSync(join(tempDir, "uv.log"), "utf8");

		await expect(ensureKernelPython()).rejects.toThrow(
			/venv rebuild deferred: 1 kernels in use[\s\S]*could not write its in-use reference/,
		);

		expect(statSync(generation).ino).toBe(inodeBefore);
		expect(existsSync(tombstone)).toBe(true);
		expect(readFileSync(join(tempDir, "uv.log"), "utf8")).toBe(uvLog);
	}, 60_000);

	it("reports the deferral on Windows hosts too", async () => {
		// The reachable ceiling on a non-win32 author machine is the decision table in
		// kernel-venv-in-use.test.ts; this integration case only runs on Windows.
		if (notWindowsHost) return;
		installFakeUv();
		const generation = createPartialGeneration("ffffffffffff");
		writeInUseReference(generation, livePid(), "session-in-use");

		await expect(ensureKernelPython()).rejects.toThrow(/venv rebuild deferred: 1 kernels in use/);
		expect(existsSync(join(generation, "previous-build-marker"))).toBe(true);
	}, 60_000);
});

describe("kernel manager pins its generation with an in-use reference", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-ref-"));
		base = join(tempDir, "kernel-venv");
		process.env.HOME = tempDir;
		process.env.PRIME_AGENT_KERNEL_VENV = base;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
			base = "";
		}
	});

	function writeProtocolPython(pythonPath: string): void {
		mkdirSync(dirname(pythonPath), { recursive: true });
		writeExecutable(
			pythonPath,
			["#!/bin/sh", `printf '{"event":"ready","protocol":3,"python":"3.11.0"}\\n'`, "cat > /dev/null", ""].join(
				"\n",
			),
		);
	}

	it("writes the reference at spawn and removes it at teardown", async () => {
		const generation = join(tempDir, "kernel-venv-aaaaaaaaaaaa");
		const python = join(generation, "bin", "python");
		writeProtocolPython(python);
		const manager = new ReplKernelManager({ python, cwd: tempDir, sessionId: "session-ref" });

		try {
			await manager.start();
			expect(manager.isRunning).toBe(true);
			const referenceDir = join(generation, ".in-use");
			const references = readdirSync(referenceDir);
			expect(references).toHaveLength(1);
			const record = JSON.parse(readFileSync(join(referenceDir, references[0] as string), "utf8"));
			expect(references[0]).toBe(String(record.pid));
			expect(record.version).toBe(1);
			expect(record.sessionId).toBe("session-ref");
			expect(typeof record.recordedAt).toBe("string");
			expect(typeof record.processStartId === "string" || record.processStartId === undefined).toBe(true);

			await manager.shutdown({});
			expect(readdirSync(referenceDir)).toHaveLength(0);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("records no reference for an interpreter outside a managed generation", async () => {
		const python = join(tempDir, "override-venv", "bin", "python");
		writeProtocolPython(python);
		const manager = new ReplKernelManager({ python, cwd: tempDir, sessionId: "session-override" });

		try {
			await manager.start();
			expect(manager.isRunning).toBe(true);
			expect(existsSync(join(tempDir, "override-venv", ".in-use"))).toBe(false);
			expect(existsSync(join(base, ".in-use"))).toBe(false);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("logs a warning and still starts when no reference can be written", async () => {
		const generation = join(tempDir, "kernel-venv-cccccccccccc");
		const python = join(generation, "bin", "python");
		writeProtocolPython(python);
		// A regular file where the reference directory belongs: neither the reference nor the
		// tombstone can be created, so the session log is the only trace (the bounded residual).
		writeFileSync(join(generation, ".in-use"), "not a directory\n");
		const entries: LogEntry[] = [];
		setLogSink((entry) => {
			entries.push(entry);
		});
		const manager = new ReplKernelManager({ python, cwd: tempDir, sessionId: "session-unwritable" });

		try {
			await manager.start();
			expect(manager.isRunning).toBe(true);
			const warnings = entries.filter((entry) => entry.msg === "kernel venv in-use reference unavailable");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.level).toBe("warn");
			expect(warnings[0]?.tombstoneWritten).toBe(false);
			expect(warnings[0]?.sessionId).toBe("session-unwritable");
			expect(warnings[0]?.venvDir).toBe(generation);
			expect(typeof warnings[0]?.reason).toBe("string");
		} finally {
			setLogSink(undefined);
			await manager.shutdown({});
		}
	}, 60_000);

	it("keeps the reference of a kernel that dies without a graceful shutdown", async () => {
		const generation = join(tempDir, "kernel-venv-bbbbbbbbbbbb");
		const python = join(generation, "bin", "python");
		writeProtocolPython(python);
		const manager = new ReplKernelManager({ python, cwd: tempDir, sessionId: "session-killed" });

		await manager.start();
		const references = readdirSync(join(generation, ".in-use"));
		expect(references).toHaveLength(1);
		manager.disposeSync();
		expect(readdirSync(join(generation, ".in-use"))).toHaveLength(0);
	}, 60_000);
});
