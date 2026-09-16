import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId, getProcessStartIdAsync } from "../src/core/session-lease.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

// R31-14 / RC-1: the supervisor is single-threaded, so a synchronous `ps` fork
// per worker launch queues every client command behind N x ~55ms. The launch
// path must resolve the child's start identity asynchronously. The probe keeps
// a fake busy-wait in place of the helper round trip so the event-loop block is
// deterministic, and measures how long the loop actually goes silent while
// several launches are in flight.
const launchProbe = vi.hoisted(() => ({
	spawns: 0,
	syncStartIdCalls: 0,
	syncDwellMs: 0,
	/** Reported by every fake child; resolved once before the probe window so the mock itself never blocks. */
	childPid: 0,
}));

const CONCURRENT_LAUNCHES = 5;
/** One helper-process round trip, deterministic: blocks the thread without forking. */
const SYNC_PS_BLOCK_MS = 80;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (() => {
			launchProbe.spawns++;
			return fakeWorkerChild();
		}) as typeof actual.spawn,
	};
});

interface SupervisorInternals {
	createOrReuseWorker(clientId: string, command: { type: "create"; config?: { cwd: string } }): Promise<unknown>;
	cleanupSupervisorResources(): Promise<void>;
	start(): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
	vi.restoreAllMocks();
});

/** The startup gate the real worker would hold open: it accepts the commit but never reports it landed. */
class NeverCommittingGate extends Writable {
	_write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback();
	}

	_final(_callback: (error?: Error | null) => void): void {
		void _callback;
		// Intentionally never settled: a launch without its gate commit stays in flight.
	}
}

/** A dead pid the fake child reports: never signalled, never identity-checked as live. */
function deadChildPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	const pid = Number.parseInt(result.stdout.trim(), 10);
	expect(Number.isInteger(pid) && pid > 0).toBe(true);
	return pid;
}

function fakeWorkerChild(): ChildProcess {
	const stderr = new PassThrough();
	const gate = new NeverCommittingGate();
	const child = Object.assign(new EventEmitter(), {
		pid: launchProbe.childPid,
		connected: true,
		exitCode: null,
		signalCode: null,
		stderr,
		stdio: [null, null, stderr, gate],
		kill: () => true,
		unref: () => {},
		ref: () => {},
	}) as unknown as ChildProcess;
	// "spawn" must land after the caller registers its listener, like a real child.
	setImmediate(() => child.emit("spawn"));
	return child;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("daemon supervisor worker launch start-id capture", () => {
	it("keeps the event loop responsive across concurrent launches", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-launch-startid-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const catalogStart = vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue(undefined);
		await supervisor.start();

		launchProbe.childPid = deadChildPid();
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		const realGetProcessStartId = sessionLeaseModule.getProcessStartId;
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockImplementation((pid: number) => {
			launchProbe.syncStartIdCalls++;
			const start = performance.now();
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SYNC_PS_BLOCK_MS);
			launchProbe.syncDwellMs += performance.now() - start;
			return realGetProcessStartId(pid);
		});

		let lastBeat = performance.now();
		let maxGapMs = 0;
		const longGaps: number[] = [];
		const heartbeat = setInterval(() => {
			const now = performance.now();
			const gapMs = now - lastBeat;
			lastBeat = now;
			maxGapMs = Math.max(maxGapMs, gapMs);
			if (gapMs > SYNC_PS_BLOCK_MS) longGaps.push(gapMs);
		}, 2);

		try {
			const launches = Array.from({ length: CONCURRENT_LAUNCHES }, (_, index) =>
				supervisor
					.createOrReuseWorker(`probe-client-${index}`, { type: "create", config: { cwd: directory } })
					.catch(() => undefined),
			);
			const spawnDeadline = performance.now() + 5000;
			while (launchProbe.spawns < CONCURRENT_LAUNCHES && performance.now() < spawnDeadline) {
				await delay(5);
			}
			await delay(400);
			void launches;

			expect(launchProbe.spawns).toBe(CONCURRENT_LAUNCHES);
			expect(launchProbe.syncStartIdCalls).toBe(0);
			// Count form instead of an absolute single-gap ceiling: the pre-fix shape
			// leaves one long gap per launch (each sync block stops the 2ms heartbeat
			// for its full 80ms), while shard noise produces isolated spikes that only
			// lengthen a gap, never mint new ones - so "fewer long gaps than launches"
			// tolerates runner jitter where a 160ms max-gap ceiling flakes on one
			// deschedule.
			expect(longGaps.length).toBeLessThan(CONCURRENT_LAUNCHES);
			// Diagnostic only: the fused pre-fix shape (every sync block landing in
			// one tick) would show as a single max gap near the serial 5 x 80ms cost.
			// The deterministic root proposition above (zero synchronous identity
			// calls) is what carries that regression, so the probe never gates CI.
			console.info(`[startid-async] event-loop probe: maxGapMs=${maxGapMs.toFixed(1)} longGaps=${longGaps.length}`);
		} finally {
			clearInterval(heartbeat);
			startIdSpy.mockRestore();
			catalogStart.mockRestore();
			await supervisor.cleanupSupervisorResources();
		}
	});

	it("captures the same start identity synchronously and asynchronously", async () => {
		// Positive control for switching the launch path to the async twin: an
		// identity captured by either variant must compare equal for a live pid.
		const synchronous = getProcessStartId(process.pid);
		const asynchronous = await getProcessStartIdAsync(process.pid);
		expect(synchronous).toBeDefined();
		expect(asynchronous).toBe(synchronous);
	});
});
