import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import type { RestoreResult } from "../src/core/kernel/state-snapshot.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("repl kernel state snapshot round-trip (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-roundtrip-"));
		snapshotPath = join(dir, "session.dill");
		manifestPath = join(dir, "session.json");
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function newManager(): ReplKernelManager {
		return new ReplKernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath },
		});
	}

	/** Build a snapshot artifact by running a dill script in the kernel python. */
	function writeDillPayload(script: string): void {
		const build = spawnSync(python as string, ["-c", script], { encoding: "utf8" });
		expect(build.status).toBe(0);
	}

	it("saves picklable names, reports unpicklable ones, then revives them in a fresh runtime", async () => {
		const writer = newManager();
		try {
			await writer.execute("x = 42");
			await writer.execute("df = [1, 2, 3]");
			await writer.execute("def double(n):\n    return n * 2");
			await writer.execute("gen = (n for n in range(3))");

			const snap = await writer.snapshotState();
			expect(snap).not.toBeNull();
			expect(snap?.saved).toEqual(expect.arrayContaining(["x", "df", "double"]));
			expect(snap?.skipped.map((s) => s.name)).toContain("gen");
			expect(existsSync(snapshotPath)).toBe(true);
			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			await writer.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const reader = newManager();
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(expect.arrayContaining(["df", "double", "x"]));
			expect(restore?.failed.map((f) => f.name) ?? []).not.toContain("x");

			const echo = await reader.execute("print(x, double(x), sum(df))");
			expect(echo.stdout.trim()).toBe("42 84 6");
		} finally {
			await reader.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}, 60_000);

	it("treats a missing snapshot as an empty restore (clean start)", async () => {
		const freshDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-empty-"));
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: freshDir,
			snapshot: { path: join(freshDir, "missing.dill"), manifestPath: join(freshDir, "missing.json") },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore).toEqual({ restored: [], failed: [], path: join(freshDir, "missing.dill") });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(freshDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("restores a snapshot artifact containing IPython-injected blobs, skipping those names", async () => {
		// Synthesize the artifact shape an IPython-kernel snapshot writes: a dict of
		// dill blobs including In/Out/get_ipython entries.
		const ipythonArtifactDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-ipython-artifact-"));
		const ipythonArtifactPath = join(ipythonArtifactDir, "kernel-state.dill");
		const buildScript = [
			"import dill",
			"dill.settings['recurse'] = True",
			"payload = {",
			"    'kept_number': dill.dumps(41),",
			"    'kept_text': dill.dumps('hello'),",
			"    'In': dill.dumps(['print(1)']),",
			"    'Out': dill.dumps({1: 'x'}),",
			"    'get_ipython': dill.dumps(None),",
			"}",
			`with open(${JSON.stringify(ipythonArtifactPath)}, "wb") as fh:`,
			"    dill.dump(payload, fh)",
		].join("\n");
		const build = spawnSync(python as string, ["-c", buildScript], { encoding: "utf8" });
		expect(build.status).toBe(0);

		const manager = new ReplKernelManager({
			python: python as string,
			cwd: ipythonArtifactDir,
			snapshot: { path: ipythonArtifactPath, manifestPath: join(ipythonArtifactDir, "kernel-state.json") },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore?.restored).toEqual(["kept_number", "kept_text"]);
			expect(restore?.failed).toEqual([]);
			const echo = await manager.execute("print(kept_number + 1, kept_text, 'In' in dir(), 'Out' in dir())");
			expect(echo.stdout.trim()).toBe("42 hello False False");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(ipythonArtifactDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("lists live user-defined names, filtering internals and live handles", async () => {
		const listDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-list-"));
		const manager = new ReplKernelManager({ python: python as string, cwd: listDir });
		try {
			expect(await manager.listNamespaceNames()).toBeNull();
			await manager.execute("alpha = 1\ndef helper(n):\n    return n\n_hidden = 2\nrlm = object()");
			const names = await manager.listNamespaceNames();
			expect(names).toEqual(expect.arrayContaining(["alpha", "helper"]));
			expect(names).not.toContain("_hidden");
			expect(names).not.toContain("rlm");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(listDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("prunes oversized variables via a compaction snapshot", async () => {
		const boundedDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-bounded-"));
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: boundedDir,
			snapshot: {
				path: join(boundedDir, "bounded.dill"),
				manifestPath: join(boundedDir, "bounded.json"),
				maxBytes: 10 * 1024,
				maxVariableBytes: 8 * 1024,
			},
		});
		try {
			await manager.execute('small_text = "a" * 100\nlarge_text = "x" * 16_384');
			const snapshot = await manager.snapshotState();
			expect(snapshot?.skipped.map(({ name }) => name)).toContain("large_text");
			expect(snapshot?.saved).toContain("small_text");

			const compacted = await manager.pruneOversizedVariables();
			expect(compacted?.pruned).toEqual(["large_text"]);
			const remaining = await manager.listNamespaceNames();
			expect(remaining).toContain("small_text");
			expect(remaining).not.toContain("large_text");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(boundedDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("auto-snapshots after a successful execution (debounced)", async () => {
		const autoDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-auto-"));
		const autoPath = join(autoDir, "auto.dill");
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: autoDir,
			snapshot: { path: autoPath, manifestPath: join(autoDir, "auto.json"), debounceMs: 50 },
		});
		try {
			await manager.execute("auto_var = 'persisted'");
			await expect.poll(() => existsSync(autoPath), { timeout: 10_000 }).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(autoDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("keeps a corrupted snapshot on disk when the whole restore fails", async () => {
		const corruptDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-restore-corrupt-"));
		const snapPath = join(corruptDir, "corrupt.dill");
		const manifestPath = join(corruptDir, "corrupt.json");
		writeDillPayload(
			[
				"import dill",
				"payload = {'x': dill.dumps(1)}",
				`with open(${JSON.stringify(snapPath)}, 'wb') as fh:`,
				"    dill.dump(payload, fh)",
			].join("\n"),
		);
		// Simulate a torn write: truncate the payload in place.
		const goodBytes = readFileSync(snapPath);
		writeFileSync(snapPath, goodBytes.subarray(0, Math.floor(goodBytes.length / 2)));
		const corrupted = readFileSync(snapPath);

		const manager = new ReplKernelManager({
			python: python as string,
			cwd: corruptDir,
			snapshot: { path: snapPath, manifestPath, debounceMs: 50 },
		});
		try {
			// Failure is visible: the restore resolves null instead of silently continuing.
			await expect(manager.restoreState()).resolves.toBeNull();

			const cell = await manager.execute("y = 2");
			expect(cell.status).toBe("ok");
			// The debounced auto-snapshot must not replace the corrupted-but-partial file.
			await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
			expect(readFileSync(snapPath).equals(corrupted)).toBe(true);
			expect(existsSync(manifestPath)).toBe(false);

			// Explicit snapshots also refuse while the failure stands.
			await expect(manager.snapshotState()).resolves.toBeNull();
			expect(readFileSync(snapPath).equals(corrupted)).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
		// The dispose flush must not have overwritten it either.
		expect(readFileSync(snapPath).equals(corrupted)).toBe(true);
		expect(existsSync(manifestPath)).toBe(false);
		rmSync(corruptDir, { recursive: true, force: true });
	}, 60_000);

	it("keeps the on-disk snapshot when individual names fail to restore", async () => {
		const partialDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-restore-partial-"));
		const snapPath = join(partialDir, "partial.dill");
		const manifestPath = join(partialDir, "partial.json");
		writeDillPayload(
			[
				"import dill",
				"good = dill.dumps(1)",
				"payload = {'good': good, 'bad': good[: max(1, len(good) // 2)]}",
				`with open(${JSON.stringify(snapPath)}, 'wb') as fh:`,
				"    dill.dump(payload, fh)",
			].join("\n"),
		);
		const before = readFileSync(snapPath);

		const manager = new ReplKernelManager({
			python: python as string,
			cwd: partialDir,
			snapshot: { path: snapPath, manifestPath, debounceMs: 50 },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore?.restored).toEqual(["good"]);
			expect(restore?.failed.map((f) => f.name)).toEqual(["bad"]);

			const cell = await manager.execute("z = 3");
			expect(cell.status).toBe("ok");
			await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
			expect(readFileSync(snapPath).equals(before)).toBe(true);

			await expect(manager.snapshotState()).resolves.toBeNull();
			expect(readFileSync(snapPath).equals(before)).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
		expect(readFileSync(snapPath).equals(before)).toBe(true);
		rmSync(partialDir, { recursive: true, force: true });
	}, 60_000);

	it("auto-snapshots again after a fully successful restore", async () => {
		const okDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-restore-ok-"));
		const snapPath = join(okDir, "ok.dill");
		writeDillPayload(
			[
				"import dill",
				"payload = {'x': dill.dumps(1)}",
				`with open(${JSON.stringify(snapPath)}, 'wb') as fh:`,
				"    dill.dump(payload, fh)",
			].join("\n"),
		);
		const before = readFileSync(snapPath);

		const manager = new ReplKernelManager({
			python: python as string,
			cwd: okDir,
			snapshot: { path: snapPath, manifestPath: join(okDir, "ok.json"), debounceMs: 50 },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore?.restored).toEqual(["x"]);
			expect(restore?.failed).toEqual([]);

			await manager.execute("y = 2");
			await expect.poll(() => readFileSync(snapPath).equals(before), { timeout: 10_000 }).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(okDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("surfaces a failed whole restore as a visible error via the provisioner", async () => {
		const visDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-restore-visible-"));
		const snapPath = join(visDir, "kernel-state.dill");
		writeDillPayload(
			[
				"import dill",
				"payload = {'x': dill.dumps(1)}",
				`with open(${JSON.stringify(snapPath)}, 'wb') as fh:`,
				"    dill.dump(payload, fh)",
			].join("\n"),
		);
		const goodBytes = readFileSync(snapPath);
		writeFileSync(snapPath, goodBytes.subarray(0, Math.floor(goodBytes.length / 2)));
		const corrupted = readFileSync(snapPath);

		const restores: RestoreResult[] = [];
		const provisioner = new IpythonKernelProvisioner(visDir, {
			python: python as string,
			snapshotDir: visDir,
			onRestore: (result) => restores.push(result),
		});
		try {
			await provisioner.ensure();
			expect(restores).toHaveLength(1);
			expect(restores[0]?.restored).toEqual([]);
			expect(restores[0]?.failed).toEqual([]);
			expect(restores[0]?.error).toContain("could not be restored");
			expect(provisioner.lastRestore?.error).toContain("could not be restored");
		} finally {
			await provisioner.dispose();
		}
		// Bootstrap and the dispose flush ran on top of the failed restore: the file survives.
		expect(readFileSync(snapPath).equals(corrupted)).toBe(true);
		expect(existsSync(join(visDir, "kernel-state.json"))).toBe(false);
		rmSync(visDir, { recursive: true, force: true });
	}, 60_000);
});
