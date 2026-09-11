import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

/**
 * T0-5 / P1-4 end to end against the real runtime: a restore that failed on one name used to
 * ban every later snapshot write, so the payload on disk never improved and the next restore
 * failed on the same name forever. These cases pin the merge write from the host side — the
 * new work is persisted, the unrestorable blob is carried over verbatim, and it really revives
 * once the module it needs is back.
 *
 * The kernel boots the runtime from this checkout's source (PYTHONPATH), not from whatever copy
 * is installed in the resolved venv, so the announced capabilities are the ones under test.
 */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const kernelPython = resolveKernelPython();
const kernelPythonMissing = kernelPython === null;
const runtimeSrc = resolve(__dirname, "..", "..", "..", "prime-agent-runtime", "src");

describe.skipIf(kernelPythonMissing)(
	"kernel snapshot preserve_names across restarts (real runtime)",
	{ tags: ["kernel-heavy"] },
	() => {
		let workDir = "";
		let snapshotPath = "";
		let manifestPath = "";
		let moduleDir = "";

		beforeAll(() => {
			expect(existsSync(join(runtimeSrc, "rlm", "repl.py"))).toBe(true);
			workDir = mkdtempSync(join(tmpdir(), "prime-agent-preserve-names-"));
			snapshotPath = join(workDir, "kernel-state.dill");
			manifestPath = join(workDir, "kernel-state.json");
			moduleDir = join(workDir, "modules");
			mkdirSync(moduleDir, { recursive: true });
			writeFileSync(
				join(moduleDir, "t0b_gone.py"),
				["class Thing:", "    def __init__(self):", "        self.value = 7", ""].join("\n"),
			);
		});

		afterAll(() => {
			if (workDir) {
				rmSync(workDir, { recursive: true, force: true });
				workDir = "";
			}
		});

		function newManager(): ReplKernelManager {
			return new ReplKernelManager({
				python: kernelPython as string,
				cwd: workDir,
				sessionId: "preserve-names",
				env: { PYTHONPATH: runtimeSrc, PRIME_AGENT_KERNEL_PROTOCOL: "4" },
				snapshot: { path: snapshotPath, manifestPath },
			});
		}

		it("persists new work after a partial restore and carries the unrestorable blob over", async () => {
			// ① A kernel creates a value that a fresh kernel cannot revive: its class lives in a
			// module directory only this kernel has on sys.path.
			const writer = newManager();
			try {
				await writer.start();
				const setup = await writer.execute(
					[
						"import sys",
						`sys.path.insert(0, ${JSON.stringify(moduleDir)})`,
						// Underscore alias: the module object itself stays out of the snapshot
						// (the runtime skips `_`-prefixed names), so `broken` is the only name
						// this fixture makes unrestorable.
						"import t0b_gone as _t0b_gone",
						"broken = _t0b_gone.Thing()",
						"keeper = {'a': 1}",
						"print(broken.value)",
					].join("\n"),
				);
				expect(setup.status, setup.stderr).toBe("ok");
				expect(setup.stdout.trim()).toBe("7");

				const first = await writer.snapshotState();
				expect(first).not.toBeNull();
				expect(first?.saved).toEqual(expect.arrayContaining(["broken", "keeper"]));
			} finally {
				await writer.shutdown({});
			}

			// ② A fresh kernel cannot revive it: the fixture really produced a partial restore.
			const second = newManager();
			try {
				await second.start();
				expect(second.kernelCapabilities?.preserveNames).toBe(true);
				const restore = await second.restoreState();
				expect(restore?.restored).toContain("keeper");
				const failedNames = (restore?.failed ?? []).map((failure) => failure.name);
				expect(failedNames).toContain("broken");
				expect(failedNames.length).toBeGreaterThan(0);
				expect(restore?.snapshotPolicy).toBe("preserve-names");

				// ③ New work is persisted again, and the request carries the unrestored name.
				const cell = await second.execute("fresh = 42");
				expect(cell.status).toBe("ok");
				const snapshot = await second.snapshotState();
				expect(snapshot).not.toBeNull();
				expect(snapshot?.saved).toContain("fresh");
				// Exactly the names that failed to revive are carried over, and the manifest
				// agrees with what the runtime actually wrote.
				expect([...(snapshot?.preserved ?? [])].sort()).toEqual([...failedNames].sort());
				expect(snapshot?.preserved).toContain("broken");
				expect(readFileSync(snapshotPath).length).toBeGreaterThan(0);
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				expect([...(manifest.preserved as string[])].sort()).toEqual([...failedNames].sort());
			} finally {
				await second.shutdown({});
			}

			// ④ A third kernel gets the new work back and is still told the truth about the name
			// that did not revive.
			const third = newManager();
			try {
				await third.start();
				const restore = await third.restoreState();
				expect(restore?.restored).toEqual(expect.arrayContaining(["fresh", "keeper"]));
				expect(restore?.failed.map((failure) => failure.name)).toContain("broken");
				const echo = await third.execute("print(fresh, keeper)");
				expect(echo.stdout.trim()).toBe("42 {'a': 1}");
			} finally {
				await third.shutdown({});
			}

			// The carried blob is the original one: with the module back on sys.path the name
			// revives, and it is the value kernel A wrote — not a placeholder.
			const fourth = newManager();
			try {
				await fourth.start();
				const pathBack = await fourth.execute(
					["import sys", `sys.path.insert(0, ${JSON.stringify(moduleDir)})`].join("\n"),
				);
				expect(pathBack.status).toBe("ok");
				const restore = await fourth.restoreState();
				expect(restore?.failed).toEqual([]);
				expect(restore?.restored).toContain("broken");
				const value = await fourth.execute("print(broken.value)");
				expect(value.status).toBe("ok");
				expect(value.stdout.trim()).toBe("7");
			} finally {
				await fourth.shutdown({});
			}
		}, 240_000);

		it("keeps writes paused against a runtime that does not announce the capability", async () => {
			// The fail-safe half of the gate, self-contained: an older runtime would ignore
			// preserve_names and silently drop the blob, so the host must not write at all.
			const legacyDir = mkdtempSync(join(tmpdir(), "prime-agent-preserve-legacy-"));
			const legacyPath = join(legacyDir, "kernel-state.dill");
			const legacyManifest = join(legacyDir, "kernel-state.json");
			const build = spawnSync(
				kernelPython as string,
				[
					"-c",
					[
						"import dill",
						"good = dill.dumps(1)",
						"payload = {'good': good, 'broken': good[: max(1, len(good) // 2)]}",
						`with open(${JSON.stringify(legacyPath)}, 'wb') as fh:`,
						"    dill.dump(payload, fh)",
					].join("\n"),
				],
				{ encoding: "utf8" },
			);
			expect(build.status, build.stderr).toBe(0);
			const before = readFileSync(legacyPath);

			const legacy = new ReplKernelManager({
				python: kernelPython as string,
				cwd: legacyDir,
				sessionId: "preserve-names-legacy",
				// No PYTHONPATH override: this kernel runs the runtime installed in the venv, which
				// predates the capability, and the protocol is pinned to 3 to keep it honest.
				env: { PRIME_AGENT_KERNEL_PROTOCOL: "3" },
				snapshot: { path: legacyPath, manifestPath: legacyManifest },
			});
			try {
				await legacy.start();
				expect(legacy.kernelCapabilities?.preserveNames).toBe(false);
				const restore = await legacy.restoreState();
				expect(restore?.restored).toEqual(["good"]);
				expect(restore?.failed.map((failure) => failure.name)).toEqual(["broken"]);
				expect(restore?.snapshotPolicy).toBe("write-blocked");

				await expect(legacy.snapshotState()).resolves.toBeNull();
				expect(readFileSync(legacyPath).equals(before)).toBe(true);
				expect(existsSync(legacyManifest)).toBe(false);
			} finally {
				await legacy.shutdown({});
				rmSync(legacyDir, { recursive: true, force: true });
			}
		}, 120_000);
	},
);
