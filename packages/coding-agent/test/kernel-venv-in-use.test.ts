import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideKernelVenvRebuild,
	generationDirForSuffix,
	isKernelVenvGenerationDir,
	KERNEL_VENV_SUFFIX_LENGTH,
	KernelVenvRebuildDeferredError,
	kernelVenvDirForPython,
	kernelVenvGenerationSuffix,
	listKernelVenvGenerations,
	pruneKernelVenvGenerations,
	RETIRED_VENV_RETENTION,
	readKernelVenvInUseState,
	recordKernelVenvInUseSync,
	releaseKernelVenvInUseSync,
	VENV_IN_USE_DIR_NAME,
} from "../src/core/kernel/venv-in-use.js";
import { getProcessStartId } from "../src/core/session-lease.js";

let tempDir = "";
let base = "";

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

/** Undo a permission case so the temp tree stays removable (chmodSync has no recursive form). */
function restorePermissions(root: string): void {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(root);
	} catch {
		return;
	}
	if (stats.isSymbolicLink()) return;
	if (stats.isDirectory()) {
		chmodSync(root, 0o755);
		for (const entry of readdirSync(root)) restorePermissions(join(root, entry));
		return;
	}
	chmodSync(root, 0o644);
}

function generation(suffix: string): string {
	return generationDirForSuffix(base, suffix);
}

/** Pin directory mtimes so "newest first" is decidable: the first entry is the oldest. */
function setRecency(dirsOldestFirst: string[]): void {
	for (const [index, dir] of dirsOldestFirst.entries()) {
		const stamp = new Date(Date.now() - (dirsOldestFirst.length - index) * 60_000);
		utimesSync(dir, stamp, stamp);
	}
}

function createGeneration(suffix: string): string {
	const dir = generation(suffix);
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
	return dir;
}

const runsAsRoot = process.getuid?.() === 0;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-venv-in-use-"));
	base = join(tempDir, "kernel-venv");
});

afterEach(() => {
	if (!tempDir) return;
	restorePermissions(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
	base = "";
});

describe("kernel venv in-use references", () => {
	it("records a reference the reader accepts and a release removes", async () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		const referencePath = recordKernelVenvInUseSync(venv, { pid: process.pid, sessionId: "session-a" });
		expect(referencePath).toBe(join(venv, VENV_IN_USE_DIR_NAME, String(process.pid)));
		expect(readdirSync(join(venv, VENV_IN_USE_DIR_NAME))).toEqual([String(process.pid)]);
		const record = JSON.parse(readFileSync(referencePath as string, "utf8"));
		expect(record.version).toBe(1);
		expect(record.pid).toBe(process.pid);
		expect(record.sessionId).toBe("session-a");
		expect(typeof record.recordedAt).toBe("string");

		const state = await readKernelVenvInUseState(venv);
		expect(state.unknown).toBe(false);
		expect(state.references).toHaveLength(1);
		expect(state.references[0]?.pid).toBe(process.pid);
		expect(state.references[0]?.sessionId).toBe("session-a");

		releaseKernelVenvInUseSync(referencePath);
		expect(await readKernelVenvInUseState(venv)).toMatchObject({ references: [], unknown: false });
	});

	it("reports no references for a venv without a reference directory", async () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		expect(await readKernelVenvInUseState(venv)).toEqual({ references: [], unknown: false, swept: [] });
	});

	it("sweeps a reference whose pid is dead and keeps a live one", async () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		const dead = deadPid();
		recordKernelVenvInUseSync(venv, { pid: dead, sessionId: "gone" });
		const live = recordKernelVenvInUseSync(venv, { pid: process.pid, sessionId: "here" });

		const state = await readKernelVenvInUseState(venv);
		expect(state.references.map((reference) => reference.pid)).toEqual([process.pid]);
		expect(state.swept).toEqual([join(venv, VENV_IN_USE_DIR_NAME, String(dead))]);
		expect(readdirSync(join(venv, VENV_IN_USE_DIR_NAME))).toEqual([String(process.pid)]);
		expect(live).toBeDefined();
	});

	it("sweeps a reference whose live pid was reused by another process", async () => {
		// The double check the orphan journal uses: a live pid alone does not prove
		// identity, so a start-id mismatch means the recorded kernel is gone.
		const venv = createGeneration("aaaaaaaaaaaa");
		const referenceDir = join(venv, VENV_IN_USE_DIR_NAME);
		mkdirSync(referenceDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(referenceDir, String(process.pid)),
			`${JSON.stringify({
				version: 1,
				pid: process.pid,
				processStartId: "ps:Mon Jan  1 00:00:00 2001",
				recordedAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const currentStartId = getProcessStartId(process.pid);
		expect(typeof currentStartId).toBe("string");

		const state = await readKernelVenvInUseState(venv);
		expect(state.references).toHaveLength(0);
		expect(state.swept).toHaveLength(1);
	});

	it("keeps a reference it cannot disprove when the start id is unavailable", async () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		const referenceDir = join(venv, VENV_IN_USE_DIR_NAME);
		mkdirSync(referenceDir, { recursive: true, mode: 0o700 });
		// An identity-free record (old writer): liveness is all the evidence there is.
		writeFileSync(
			join(referenceDir, String(process.pid)),
			`${JSON.stringify({ version: 1, pid: process.pid, recordedAt: new Date().toISOString() })}\n`,
			{ mode: 0o600 },
		);

		const state = await readKernelVenvInUseState(venv);
		expect(state.references.map((reference) => reference.pid)).toEqual([process.pid]);
		expect(state.references[0]?.processStartId).toBeUndefined();
	});

	it.skipIf(runsAsRoot)("reports unknown (assume in use) when the reference directory cannot be read", async () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		const referencePath = recordKernelVenvInUseSync(venv, { pid: process.pid, sessionId: "session-a" });
		chmodSync(join(venv, VENV_IN_USE_DIR_NAME), 0o000);
		try {
			const state = await readKernelVenvInUseState(venv);
			expect(state.unknown).toBe(true);
			expect(state.references).toHaveLength(0);
		} finally {
			chmodSync(join(venv, VENV_IN_USE_DIR_NAME), 0o700);
		}
		expect(existsReference(referencePath)).toBe(true);
	});

	it.skipIf(runsAsRoot)("survives an unwritable venv without throwing", () => {
		const venv = createGeneration("aaaaaaaaaaaa");
		chmodSync(venv, 0o500);
		try {
			expect(recordKernelVenvInUseSync(venv, { pid: process.pid })).toBeUndefined();
		} finally {
			chmodSync(venv, 0o700);
		}
		releaseKernelVenvInUseSync(undefined);
	});
});

function existsReference(referencePath: string | undefined): boolean {
	if (!referencePath) return false;
	try {
		readFileSync(referencePath);
		return true;
	} catch {
		return false;
	}
}

describe("kernel venv rebuild decision", () => {
	const cases = [
		{
			name: "no directory for this identity yet: build it",
			input: { platform: "darwin", generationDirExists: false, liveReferences: 0, referenceStateUnknown: false },
			mode: "replace",
		},
		{
			name: "directory nobody references: rebuild in place",
			input: { platform: "linux", generationDirExists: true, liveReferences: 0, referenceStateUnknown: false },
			mode: "replace",
		},
		{
			name: "directory a kernel is running from: defer (posix)",
			input: { platform: "darwin", generationDirExists: true, liveReferences: 2, referenceStateUnknown: false },
			mode: "defer",
		},
		{
			name: "directory a kernel is running from: defer (win32)",
			input: { platform: "win32", generationDirExists: true, liveReferences: 1, referenceStateUnknown: false },
			mode: "defer",
		},
		{
			name: "unreadable reference bookkeeping: defer rather than delete",
			input: { platform: "linux", generationDirExists: true, liveReferences: 0, referenceStateUnknown: true },
			mode: "defer",
		},
	] as const;

	it("decides per generation state and platform", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			const decision = decideKernelVenvRebuild(testCase.input);
			expect(decision.mode, testCase.name).toBe(testCase.mode);
			expect(decision.platform).toBe(testCase.input.platform);
			expect(decision.liveReferences).toBe(testCase.input.liveReferences);
			expect(decision.reason.length).toBeGreaterThan(0);
		}
	});

	it("carries an actionable deferral message", () => {
		const error = new KernelVenvRebuildDeferredError(join(tempDir, "kernel-venv-aaaaaaaaaaaa"), 3, false);
		expect(error.name).toBe("KernelVenvRebuildDeferredError");
		expect(error.liveReferences).toBe(3);
		expect(error.message).toContain("venv rebuild deferred: 3 kernels in use");
		expect(error.message).toContain("PRIME_AGENT_KERNEL_PYTHON");
		expect(error.message).toContain(basename(join(tempDir, "kernel-venv-aaaaaaaaaaaa")));
	});
});

describe("kernel venv generation naming", () => {
	it("derives a stable 12 hex suffix from the build identity", () => {
		const suffix = kernelVenvGenerationSuffix('{"schema":10,"runtime":"sha256:aa"}');
		expect(suffix).toMatch(/^[0-9a-f]{12}$/);
		expect(suffix).toHaveLength(KERNEL_VENV_SUFFIX_LENGTH);
		expect(kernelVenvGenerationSuffix('{"schema":10,"runtime":"sha256:aa"}')).toBe(suffix);
		expect(kernelVenvGenerationSuffix('{"schema":10,"runtime":"sha256:bb"}')).not.toBe(suffix);
		// A schema bump alone must move to its own directory: an in-use directory is
		// never rebuilt in place, so a colliding name would leave no room to build.
		expect(kernelVenvGenerationSuffix('{"schema":9,"runtime":"sha256:aa"}')).not.toBe(suffix);
		// Non-hash identities (registry install) still get a filesystem-safe suffix.
		expect(kernelVenvGenerationSuffix("prime-agent-runtime")).toMatch(/^[0-9a-f]{12}$/);
	});

	it("names generations as siblings of the base and recognizes them", () => {
		const dir = generationDirForSuffix(base, "aaaaaaaaaaaa");
		expect(dir).toBe(join(tempDir, "kernel-venv-aaaaaaaaaaaa"));
		expect(isKernelVenvGenerationDir(base, dir)).toBe(true);
		expect(isKernelVenvGenerationDir(base, base)).toBe(false);
		expect(isKernelVenvGenerationDir(base, join(tempDir, "kernel-venv-legacy"))).toBe(false);
		expect(isKernelVenvGenerationDir(base, join(tempDir, "kernel-venv.bootstrap.lock"))).toBe(false);
		expect(isKernelVenvGenerationDir(base, join(tempDir, "other-aaaaaaaaaaaa"))).toBe(false);
	});

	it("maps a managed kernel python back to its generation directory", () => {
		const dir = generation("aaaaaaaaaaaa");
		expect(kernelVenvDirForPython(join(dir, "bin", "python"), [base])).toBe(dir);
		expect(kernelVenvDirForPython(join(dir, "Scripts", "python.exe"), [base])).toBe(dir);
		// The legacy unsuffixed venv and an unrelated interpreter are not managed generations.
		expect(kernelVenvDirForPython(join(base, "bin", "python"), [base])).toBeUndefined();
		expect(kernelVenvDirForPython(join(tempDir, "somewhere", "bin", "python"), [base])).toBeUndefined();
		expect(kernelVenvDirForPython(join(dir, "bin", "python"), [])).toBeUndefined();
		expect(kernelVenvDirForPython(join(dir, "notbin", "python"), [base])).toBeUndefined();
	});
});

describe("kernel venv generation pruning", () => {
	it("lists only generation siblings, never the base or the lock", async () => {
		createGeneration("aaaaaaaaaaaa");
		createGeneration("bbbbbbbbbbbb");
		mkdirSync(base, { recursive: true });
		mkdirSync(`${base}.bootstrap.lock`, { recursive: true });
		mkdirSync(join(tempDir, "unrelated"), { recursive: true });

		const listed = (await listKernelVenvGenerations(base)).map((dir) => basename(dir)).sort();
		expect(listed).toEqual(["kernel-venv-aaaaaaaaaaaa", "kernel-venv-bbbbbbbbbbbb"]);
	});

	it("keeps a referenced generation beyond retention and prunes unreferenced ones", async () => {
		const oldest = createGeneration("aaaaaaaaaaaa");
		const middle = createGeneration("bbbbbbbbbbbb");
		const newest = createGeneration("cccccccccccc");
		const active = createGeneration("dddddddddddd");
		// The oldest copy still has a kernel running from it.
		recordKernelVenvInUseSync(oldest, { pid: process.pid, sessionId: "long-lived" });
		// Recency order: oldest < middle < newest.
		setRecency([oldest, middle, newest]);

		const report = await pruneKernelVenvGenerations(base, { activeDir: active });

		expect(report.removed).toContain(middle);
		expect(report.removed).not.toContain(oldest);
		expect(report.removed).not.toContain(active);
		expect(readdirSync(tempDir).sort()).toEqual([basename(oldest), basename(newest), basename(active)].sort());
		expect(report.kept.length).toBeGreaterThan(0);
		const keptOldest = report.kept.find((entry) => entry.dir === oldest);
		expect(keptOldest?.protectedByReference).toBe(true);
		expect(keptOldest?.liveReferences).toBe(1);
	});

	it("keeps every unreferenced generation up to the retention bound", async () => {
		expect(RETIRED_VENV_RETENTION).toBe(1);
		const first = createGeneration("aaaaaaaaaaaa");
		const second = createGeneration("bbbbbbbbbbbb");
		setRecency([first, second]);

		const report = await pruneKernelVenvGenerations(base, { retention: RETIRED_VENV_RETENTION });

		expect(report.removed).toHaveLength(1);
		expect(report.removed[0]).toBe(first);
		expect(readdirSync(tempDir)).toContain(basename(second));
	});

	it("never prunes the generation this boot is about to use", async () => {
		const active = createGeneration("aaaaaaaaaaaa");
		const report = await pruneKernelVenvGenerations(base, { activeDir: active, retention: 0 });
		expect(report.removed).toEqual([]);
		expect(readdirSync(tempDir)).toContain(basename(active));
	});

	it.skipIf(runsAsRoot)("leaves an unreadable generation alone instead of deleting it", async () => {
		const unreadable = createGeneration("aaaaaaaaaaaa");
		const readable = createGeneration("bbbbbbbbbbbb");
		recordKernelVenvInUseSync(unreadable, { pid: process.pid, sessionId: "session-a" });
		chmodSync(join(unreadable, VENV_IN_USE_DIR_NAME), 0o000);
		try {
			const report = await pruneKernelVenvGenerations(base, { retention: 0 });
			expect(report.removed).not.toContain(unreadable);
			expect(report.removed).toContain(readable);
		} finally {
			chmodSync(join(unreadable, VENV_IN_USE_DIR_NAME), 0o700);
		}
	});

	it("survives a missing parent directory", async () => {
		const report = await pruneKernelVenvGenerations(join(tempDir, "absent", "kernel-venv"), {});
		expect(report).toEqual({ removed: [], kept: [] });
	});
});
