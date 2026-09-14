import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { formatKernelResetNotice } from "../src/core/kernel/reset-notice.js";
import { restoreNoticeLines } from "../src/core/kernel/state-snapshot.js";

/**
 * Snapshot honesty: everything the two revival notices say about the persisted namespace has to be
 * provable from the code path that produced the payload.
 *
 * Two shapes are pinned here, both driven through the real runtime:
 *
 *  - a cell that mutates the namespace and then raises (`late = 2; raise`) used to leave the
 *    on-disk snapshot at the last *successful* cell, while the notice asserted a debounce-worth of
 *    freshness - a variable defined seconds before the death vanished with no mention anywhere;
 *  - names the snapshot writer could not serialize (a generator, an open socket, an oversized
 *    value) were dropped from the payload with no channel back to the model: neither the reset
 *    notice nor the resume notice could name them.
 */

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

interface Harness {
	manager: ReplKernelManager;
	dir: string;
	snapshotPath: string;
	manifestPath: string;
}

function newHarness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-snapshot-honesty-"));
	const snapshotPath = join(dir, "kernel-state.dill");
	const manifestPath = join(dir, "kernel-state.json");
	return {
		dir,
		snapshotPath,
		manifestPath,
		manager: new ReplKernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath, debounceMs: 50 },
		}),
	};
}

/** The manifest the runtime wrote for the payload on disk, or null while there is none. */
function manifest(harness: Harness): { savedNames: string[]; skipped: { name: string; reason: string }[] } | null {
	if (!existsSync(harness.manifestPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(harness.manifestPath, "utf8")) as {
			savedNames?: unknown;
			skipped?: unknown;
		};
		return {
			savedNames: Array.isArray(parsed.savedNames) ? (parsed.savedNames as string[]) : [],
			skipped: Array.isArray(parsed.skipped) ? (parsed.skipped as { name: string; reason: string }[]) : [],
		};
	} catch {
		return null;
	}
}

/** Names the payload on disk currently holds; empty while no snapshot has been written. */
function persistedNames(harness: Harness): string[] {
	return manifest(harness)?.savedNames ?? [];
}

/** Kill the kernel out from under the host - an unowned death, not a teardown. */
async function crashKernel(harness: Harness): Promise<void> {
	const pid = harness.manager.kernelPid;
	expect(pid).toBeDefined();
	process.kill(pid as number, "SIGKILL");
	await vi.waitFor(() => expect(harness.manager.isRunning).toBe(false), { timeout: 15_000 });
}

/** Serve one cell on the replacement kernel and hand back the reset notice that cell carried. */
async function reviveAndReadNotice(harness: Harness): Promise<string> {
	const revived = await harness.manager.execute("1 + 1");
	expect(revived.status).toBe("ok");
	const notice = harness.manager.consumeRestartNotice();
	expect(notice).toBeDefined();
	return notice as string;
}

describeIfKernel("kernel snapshot honesty (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let harness: Harness;

	beforeEach(() => {
		harness = newHarness();
	});

	afterEach(async () => {
		await harness.manager.shutdown({ snapshot: false, drainHostRequests: true }).catch(() => undefined);
		rmSync(harness.dir, { recursive: true, force: true });
	});

	it("keeps what a cell defined before it raised, so the replacement kernel still has it", async () => {
		await harness.manager.execute("early = 'kept'");
		await expect.poll(() => persistedNames(harness), { timeout: 15_000 }).toContain("early");

		const failed = await harness.manager.execute("late = 'defined-then-raised'\nraise ValueError('boom')");
		expect(failed.status).toBe("error");

		// The cell that raised still mutated the namespace, so the snapshot has to advance past it.
		await expect.poll(() => persistedNames(harness), { timeout: 15_000 }).toContain("late");

		await crashKernel(harness);
		const notice = await reviveAndReadNotice(harness);
		const probe = await harness.manager.execute("print(late)");
		if (probe.status === "ok") {
			expect(probe.stdout.trim()).toBe("defined-then-raised");
			return;
		}
		// The two honest outcomes. A lost value that was never written cannot be named - the only
		// record of it died with the kernel - so what the notice owes the model in that case is the
		// bound it can prove: how old the payload is. What it may never do is claim a freshness it
		// has not measured.
		expect(notice).toMatch(/written about \d+(\.\d+)?s before the death/);
		expect(notice).not.toContain("1.5s");
	}, 90_000);

	it("names the names the snapshot could not save in the reset notice", async () => {
		await harness.manager.execute("kept = 1\ngen = (n for n in range(3))");
		await expect
			.poll(() => manifest(harness)?.skipped.map((entry) => entry.name) ?? [], { timeout: 15_000 })
			.toContain("gen");

		await crashKernel(harness);
		const notice = await reviveAndReadNotice(harness);
		expect(notice).toContain("gen");
		expect(notice).toContain("generator");
	}, 90_000);

	it("names the names the snapshot could not save in the resume notice", async () => {
		const writer = harness.manager;
		await writer.execute("kept = 1\ngen = (n for n in range(3))");
		await expect
			.poll(() => manifest(harness)?.skipped.map((entry) => entry.name) ?? [], { timeout: 15_000 })
			.toContain("gen");
		await writer.shutdown({ snapshot: true, drainHostRequests: true });

		const reader = new ReplKernelManager({
			python: python as string,
			cwd: harness.dir,
			snapshot: { path: harness.snapshotPath, manifestPath: harness.manifestPath, debounceMs: 50 },
		});
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toContain("kept");
			const lines = restoreNoticeLines(restore as NonNullable<typeof restore>).join("\n");
			expect(lines).toContain("gen");
			expect(lines).toContain("generator");
		} finally {
			await reader.shutdown({ snapshot: false, drainHostRequests: true }).catch(() => undefined);
		}
	}, 90_000);

	it("reports the real age of the snapshot instead of a fixed debounce claim", async () => {
		await harness.manager.execute("old = 1");
		await expect.poll(() => persistedNames(harness), { timeout: 15_000 }).toContain("old");
		// The write is already seconds old here, and this kernel is configured with a 50ms debounce:
		// "written up to about 1.5s before the death" was false on both counts.
		await new Promise((done) => globalThis.setTimeout(done, 2_000));

		await crashKernel(harness);
		const notice = await reviveAndReadNotice(harness);
		expect(notice).not.toContain("1.5s");
		expect(notice).toMatch(/written about \d+(\.\d+)?s before the death/);
	}, 90_000);
});

describe("kernel reset notice freshness wording", () => {
	const base = {
		cause: { code: 9, signal: null, at: 1_700_000_000_000, stderrTail: "", origin: "unknown" as const },
		restartCount: 1,
		snapshotConfigured: true,
		hostRequests: [],
	};

	it("states the measured age of the snapshot when the host knows it", () => {
		const notice = formatKernelResetNotice({
			...base,
			restore: { restored: ["a"], failed: [], path: "/tmp/kernel-state.dill" },
			snapshotWrittenBeforeDeathMs: 7_400,
		});
		expect(notice).toContain("written about 7.4s before the death");
		expect(notice).toContain("anything a cell changed after that write is not in it");
		// And no false precision on a long-lived payload.
		expect(
			formatKernelResetNotice({
				...base,
				restore: { restored: ["a"], failed: [], path: "/tmp/kernel-state.dill" },
				snapshotWrittenBeforeDeathMs: 42_400,
			}),
		).toContain("written about 42s before the death");
		expect(notice).not.toContain("1.5s");
	});

	it("admits it does not know the write time instead of guessing one", () => {
		const notice = formatKernelResetNotice({
			...base,
			restore: { restored: ["a"], failed: [], path: "/tmp/kernel-state.dill" },
		});
		expect(notice).not.toContain("1.5s");
		expect(notice).toContain("this host cannot tell when");
	});

	it("names the names the snapshot never saved, with the runtime's reason", () => {
		const notice = formatKernelResetNotice({
			...base,
			restore: {
				restored: ["kept"],
				failed: [{ name: "unloadable", reason: "unpickling failed" }],
				notSaved: [{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" }],
				path: "/tmp/kernel-state.dill",
			},
			snapshotWrittenBeforeDeathMs: 1_000,
		});
		expect(notice).toContain("never saved into it");
		expect(notice).toContain("gen (TypeError: cannot pickle 'generator' object)");
		expect(notice).toContain("must be rebuilt: unloadable");
	});
});
