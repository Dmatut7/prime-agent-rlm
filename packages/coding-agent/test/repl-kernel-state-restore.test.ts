import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const runsAsRoot = process.getuid?.() === 0;

/** Session-log entries, which is where a refused or failed snapshot write is reported. */
let logEntries: LogEntry[] = [];

function logMessages(message: string): LogEntry[] {
	return logEntries.filter((entry) => entry.msg === message);
}

beforeEach(() => {
	logEntries = [];
	setLogSink((entry) => {
		logEntries.push(entry);
	});
});

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
	setLogSink(undefined);
	while (restoreDirs.length > 0) {
		const directory = restoreDirs.pop();
		if (directory) {
			chmodSync(directory, 0o755);
			rmSync(directory, { recursive: true, force: true });
		}
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
			// A timed-out restore isolates (nothing to isolate here) and must not leave
			// writes banned: the ban is reported, and only by the isolation failure.
			expect(logMessages("kernel state restore failed; snapshot could not be isolated")).toHaveLength(0);
			expect(logMessages("kernel state restore failed; snapshot isolated")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(runsAsRoot)("suppresses every snapshot write after a whole restore failed unisolated", async () => {
		vi.useFakeTimers();
		const directory = mkdtempSync(join(tmpdir(), "pi-restore-ban-"));
		restoreDirs.push(directory);
		const path = join(directory, "kernel-state.dill");
		writeFileSync(path, "payload on disk");
		try {
			const manager = new ReplKernelManager({
				cwd: process.cwd(),
				snapshot: { path, manifestPath: join(directory, "kernel-state.json"), debounceMs: 50 },
			});
			const enqueueRequest = vi.fn(async (request: { type: string }) =>
				request.type === "restore"
					? {
							stdout: "",
							stderr: "bad pickle",
							status: "error" as const,
							durationMs: 0,
							error: { ename: "ValueError", evalue: "bad pickle", traceback: [] },
						}
					: {
							stdout: "",
							stderr: "",
							status: "ok" as const,
							durationMs: 0,
							doneFields: { saved: [], skipped: [], bytes: 0 },
						},
			);
			const cleanupResources = vi.fn();
			stubRunning(manager, { enqueueRequest, cleanupResources });

			// Drive the ban through the production path: the whole payload fails to load and a
			// read-only artifact directory makes the isolation rename fail too.
			chmodSync(directory, 0o500);
			await expect(manager.restoreState()).resolves.toBeNull();
			chmodSync(directory, 0o755);
			expect(logMessages("kernel state restore failed; snapshot could not be isolated")).toHaveLength(1);

			const snapshotCalls = (): number =>
				enqueueRequest.mock.calls.filter((call) => call[0]?.type === "snapshot").length;
			expect(snapshotCalls()).toBe(0);

			// Debounced auto-snapshot path: no timer may even be scheduled.
			(manager as unknown as { scheduleSnapshot: () => void }).scheduleSnapshot();
			await vi.advanceTimersByTimeAsync(1000);
			expect(snapshotCalls()).toBe(0);

			// Explicit snapshot and prune paths refuse before touching the kernel.
			await expect(manager.snapshotState()).resolves.toBeNull();
			await expect(manager.pruneOversizedVariables()).resolves.toBeNull();
			expect(snapshotCalls()).toBe(0);
			// The refusal is reported once per reason, not once per attempt.
			expect(logMessages("kernel state snapshot skipped")).toHaveLength(1);
			expect(logMessages("kernel state snapshot skipped")[0]?.reason).toBe("restore-write-blocked");

			// The dispose flush skips its final snapshot too.
			await expect(manager.shutdown({ snapshot: true, drainHostRequests: true })).resolves.toBe(true);
			expect(snapshotCalls()).toBe(0);
			expect(cleanupResources).toHaveBeenCalledOnce();
			expect(readFileSync(path, "utf8")).toBe("payload on disk");
		} finally {
			chmodSync(directory, 0o755);
			vi.useRealTimers();
		}
	});

	it("resumes snapshotting after a later fully successful restore", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { ...SNAPSHOT_OPTS } });
		const enqueueRequest = vi.fn(async (request: { type: string }) =>
			request.type === "restore"
				? {
						stdout: "",
						stderr: "",
						status: "ok" as const,
						durationMs: 0,
						doneFields: { restored: ["x"], failed: [] },
					}
				: {
						stdout: "",
						stderr: "",
						status: "ok" as const,
						durationMs: 0,
						doneFields: { saved: ["x"], skipped: [], bytes: 4 },
					},
		);
		stubRunning(manager, { enqueueRequest });

		await expect(manager.restoreState()).resolves.toEqual({
			restored: ["x"],
			failed: [],
			path: SNAPSHOT_OPTS.path,
		});

		// Writing resumes, with nothing to preserve.
		await expect(manager.snapshotState()).resolves.toMatchObject({ saved: ["x"] });
		const snapshotCalls = enqueueRequest.mock.calls.filter((call) => call[0]?.type === "snapshot");
		expect(snapshotCalls).toHaveLength(1);
		expect(snapshotCalls[0]?.[0]).toEqual({
			type: "snapshot",
			path: SNAPSHOT_OPTS.path,
			manifest_path: SNAPSHOT_OPTS.manifestPath,
			max_bytes: 268435456,
			max_variable_bytes: 16777216,
			prune_oversized: false,
		});
	});

	it("keeps writes paused after a partial restore when the runtime cannot preserve names", async () => {
		// No ready handshake in this stub, so no capability was negotiated: a runtime that
		// does not understand preserve_names would drop the unrestored blob, and losing data
		// is worse than not writing. The capability-on branch (write + preserve_names) is
		// covered against a fake kernel in kernel-snapshot-write-policy.test.ts.
		const manager = new ReplKernelManager({ cwd: process.cwd(), snapshot: { ...SNAPSHOT_OPTS } });
		const enqueueRequest = vi.fn(async (request: { type: string }) =>
			request.type === "restore"
				? {
						stdout: "",
						stderr: "",
						status: "ok" as const,
						durationMs: 0,
						doneFields: { restored: ["x"], failed: [{ name: "sock", reason: "bad" }] },
					}
				: {
						stdout: "",
						stderr: "",
						status: "ok" as const,
						durationMs: 0,
						doneFields: { saved: ["x"], skipped: [], bytes: 4 },
					},
		);
		stubRunning(manager, { enqueueRequest });

		const restore = await manager.restoreState();
		expect(restore?.failed).toEqual([{ name: "sock", reason: "bad" }]);
		expect(restore?.snapshotPolicy).toBe("write-blocked");

		await expect(manager.snapshotState()).resolves.toBeNull();
		expect(enqueueRequest.mock.calls.filter((call) => call[0]?.type === "snapshot")).toHaveLength(0);
		expect(logMessages("kernel state snapshot skipped")).toHaveLength(1);
		expect(logMessages("kernel state snapshot skipped")[0]?.reason).toBe("unrestored-names-without-preserve");
		expect(logMessages("kernel state snapshot skipped")[0]?.names).toEqual(["sock"]);
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
		// Isolation succeeded, so writes are not banned: reported, and only the failure
		// branch would say otherwise.
		expect(logMessages("kernel state restore failed; snapshot isolated")).toHaveLength(1);
		expect(logMessages("kernel state restore failed; snapshot could not be isolated")).toHaveLength(0);

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
