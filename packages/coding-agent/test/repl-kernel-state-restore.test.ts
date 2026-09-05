import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 40; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

const SNAPSHOT_OPTS = { path: "/tmp/restore-guard.dill", manifestPath: "/tmp/restore-guard.json" };

const restoreDirs: string[] = [];
afterEach(() => {
	while (restoreDirs.length > 0) {
		const directory = restoreDirs.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function stubRunning(manager: ReplKernelManager, extra: Record<string, unknown> = {}): void {
	Object.assign(manager as unknown as Record<string, unknown>, {
		state: "running",
		start: async () => {},
		...extra,
	});
}

describe("ReplKernelManager restore failure guards", () => {
	it("bounds the resume restore with the repair step timeout", async () => {
		vi.useFakeTimers();
		try {
			const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { ...SNAPSHOT_OPTS } });
			const seen: { type: string; hasTimeoutSignal: boolean }[] = [];
			const executeInner = vi.fn(
				async (
					requestFields: Record<string, unknown> & { type: string },
					_code: string,
					opts: { signal?: AbortSignal },
				) => {
					seen.push({ type: requestFields.type, hasTimeoutSignal: opts.signal !== undefined });
					return await new Promise<{ stdout: string; stderr: string; status: "aborted"; durationMs: number }>(
						(resolve) => {
							opts.signal?.addEventListener(
								"abort",
								() => resolve({ stdout: "", stderr: "", status: "aborted", durationMs: 30_000 }),
								{ once: true },
							);
						},
					);
				},
			);
			stubRunning(manager, { executeInner });

			const restore = manager.restoreState();
			await waitForCalls(executeInner, 1);
			expect(seen[0]).toEqual({ type: "restore", hasTimeoutSignal: true });

			await vi.advanceTimersByTimeAsync(29_999);
			let settled = false;
			void restore.finally(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await expect(restore).resolves.toBeNull();
			expect((manager as unknown as { restoreFailed: boolean }).restoreFailed).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("suppresses every snapshot write after a failed restore", async () => {
		vi.useFakeTimers();
		try {
			const manager = new ReplKernelManager({
				cwd: process.cwd(),
				snapshot: { ...SNAPSHOT_OPTS, debounceMs: 50 },
			});
			const enqueueRequest = vi.fn(async () => ({
				stdout: "",
				stderr: "",
				status: "ok" as const,
				durationMs: 0,
				doneFields: { saved: [], skipped: [], bytes: 0 },
			}));
			const cleanupResources = vi.fn();
			stubRunning(manager, { restoreFailed: true, enqueueRequest, cleanupResources });

			// Debounced auto-snapshot path: no timer may even be scheduled.
			(manager as unknown as { scheduleSnapshot: () => void }).scheduleSnapshot();
			await vi.advanceTimersByTimeAsync(1000);
			expect(enqueueRequest).not.toHaveBeenCalled();

			// Explicit snapshot and prune paths refuse before touching the kernel.
			await expect(manager.snapshotState()).resolves.toBeNull();
			await expect(manager.pruneOversizedVariables()).resolves.toBeNull();
			expect(enqueueRequest).not.toHaveBeenCalled();

			// The dispose flush skips its final snapshot too.
			await expect(manager.shutdown({ snapshot: true, drainHostRequests: true })).resolves.toBe(true);
			expect(enqueueRequest).not.toHaveBeenCalled();
			expect(cleanupResources).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes snapshotting after a later fully successful restore", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { ...SNAPSHOT_OPTS } });
		const enqueueRequest = vi.fn(async () => ({
			stdout: "",
			stderr: "",
			status: "ok" as const,
			durationMs: 0,
			doneFields: { restored: ["x"], failed: [] },
		}));
		stubRunning(manager, { restoreFailed: true, enqueueRequest });

		await expect(manager.restoreState()).resolves.toEqual({
			restored: ["x"],
			failed: [],
			path: SNAPSHOT_OPTS.path,
		});
		expect((manager as unknown as { restoreFailed: boolean }).restoreFailed).toBe(false);
	});

	it("keeps the guard after a partially successful restore", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { ...SNAPSHOT_OPTS } });
		const enqueueRequest = vi.fn(async () => ({
			stdout: "",
			stderr: "",
			status: "ok" as const,
			durationMs: 0,
			doneFields: { restored: ["x"], failed: [{ name: "sock", reason: "bad" }] },
		}));
		stubRunning(manager, { enqueueRequest });

		const restore = await manager.restoreState();
		expect(restore?.failed).toEqual([{ name: "sock", reason: "bad" }]);
		expect((manager as unknown as { restoreFailed: boolean }).restoreFailed).toBe(true);
	});

	it("isolates a corrupt snapshot so later work can persist again", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-restore-isolate-"));
		restoreDirs.push(directory);
		const path = join(directory, "kernel-state.dill");
		const manifestPath = join(directory, "kernel-state.json");
		writeFileSync(path, "corrupt-payload");
		writeFileSync(manifestPath, '{"saved":["x"]}');

		const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { path, manifestPath } });
		const enqueueRequest = vi.fn(async (request: { type: string }) => {
			if (request.type === "restore") {
				return {
					stdout: "",
					stderr: "bad pickle",
					status: "error" as const,
					durationMs: 0,
					error: { ename: "ValueError", evalue: "bad pickle", traceback: [] },
				};
			}
			return {
				stdout: "",
				stderr: "",
				status: "ok" as const,
				durationMs: 0,
				doneFields: { saved: ["y"], skipped: [], bytes: 4 },
			};
		});
		stubRunning(manager, { enqueueRequest });

		await expect(manager.restoreState()).resolves.toBeNull();
		expect((manager as unknown as { restoreFailed: boolean }).restoreFailed).toBe(false);

		const names = readdirSync(directory);
		const isolatedPayload = names.find((name) => name.startsWith("kernel-state.dill.corrupt-"));
		const isolatedManifest = names.find((name) => name.startsWith("kernel-state.json.corrupt-"));
		expect(isolatedPayload).toBeDefined();
		expect(isolatedManifest).toBeDefined();
		expect(readFileSync(join(directory, isolatedPayload!), "utf8")).toBe("corrupt-payload");
		expect(readFileSync(join(directory, isolatedManifest!), "utf8")).toBe('{"saved":["x"]}');
		expect(names).not.toContain("kernel-state.dill");
		expect(names).not.toContain("kernel-state.json");

		await expect(manager.snapshotState()).resolves.toEqual({
			saved: ["y"],
			skipped: [],
			pruned: undefined,
			bytes: 4,
			path,
		});
		expect(enqueueRequest.mock.calls.some((call) => call[0]?.type === "snapshot")).toBe(true);
	});
});
