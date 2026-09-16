import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentCronJobStore,
	AgentCronScheduler,
	migrateLegacyCronJobsToSessionArtifacts,
} from "../src/core/cron-jobs.js";
import type { KernelLivenessSample } from "../src/core/kernel/shared.js";
import { canPassivateSession, clampForeignClockNow } from "../src/core/session-action-store.js";
import { StallWatchdog, type StallWatchdogTimers } from "../src/core/stall-watchdog.js";
import { createTurnLiveness, kernelVouchedAlive, shouldRetainHeartbeatSample } from "../src/core/turn-liveness.js";

const MINUTE_MS = 60_000;
const T0 = 1_800_000_000_000;

/**
 * Deterministic clock for watchdog tests that can also step the wall clock backwards,
 * modelling an NTP step or a manual time correction while a turn is being watched.
 */
class RollbackFakeClock {
	nowMs = 0;
	/** Monotonic stand-in: total advanced time, unaffected by backward wall steps. */
	monoMs = 0;
	private nextId = 1;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];

	readonly timersImpl: StallWatchdogTimers = {
		setTimeout: (fn, delayMs) => {
			const id = this.nextId++;
			this.timers.push({ id, at: this.nowMs + delayMs, fn });
			return id;
		},
		clearTimeout: (handle) => {
			this.timers = this.timers.filter((timer) => timer.id !== handle);
		},
		now: () => this.nowMs,
		monotonicNow: () => this.monoMs,
	};

	advance(ms: number): void {
		this.monoMs += ms;
		const target = this.nowMs + ms;
		for (;;) {
			this.timers.sort((a, b) => a.at - b.at);
			const next = this.timers.find((timer) => timer.at <= target);
			if (!next) break;
			this.timers = this.timers.filter((timer) => timer !== next);
			this.nowMs = next.at;
			next.fn();
		}
		this.nowMs = target;
	}

	stepBack(ms: number): void {
		this.nowMs -= ms;
	}
}

function freshKernelSample(receivedAt: number): KernelLivenessSample {
	return {
		receivedAt,
		tick: 10,
		intervalMs: 5_000,
		cpuMs: 0,
		streamBytes: 0,
		cellsDone: 0,
		hostRequests: 0,
		bashHandles: 3,
		bashCellHandles: 0,
		bashBufferedBytes: 0,
		bashPipePending: 0,
	};
}

describe("stall watchdog under a backward wall-clock step", () => {
	function makeWatchdog(clock: RollbackFakeClock, stages: string[]): StallWatchdog {
		return new StallWatchdog({
			enabled: true,
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 5 * MINUTE_MS,
			vouchLivenessBudgetMs: 20 * MINUTE_MS,
			vouch: () => ({ active: true, reasons: ["live_bash_handles"], tier: "liveness" }),
			onStage: (info) => stages.push(info.stage),
			timers: clock.timersImpl,
		});
	}

	it("positive control: forward clock reaches warn, abort and abort_unsettled unchanged", () => {
		const clock = new RollbackFakeClock();
		const stages: string[] = [];
		const watchdog = makeWatchdog(clock, stages);
		watchdog.arm();
		clock.advance(30 * MINUTE_MS);
		expect(stages).toEqual(["warn", "abort", "abort_unsettled"]);
	});

	it("keeps consuming the exemption budget while the wall clock is behind", () => {
		const clock = new RollbackFakeClock();
		const stages: string[] = [];
		const watchdog = makeWatchdog(clock, stages);
		watchdog.arm();
		clock.advance(MINUTE_MS);
		clock.stepBack(30 * MINUTE_MS);
		clock.advance(MINUTE_MS);
		expect(watchdog.exemption?.usedMs).toBeGreaterThan(0);
	});

	it("still escalates to abort after a backward step", () => {
		const clock = new RollbackFakeClock();
		const stages: string[] = [];
		const watchdog = makeWatchdog(clock, stages);
		watchdog.arm();
		clock.advance(MINUTE_MS);
		clock.stepBack(30 * MINUTE_MS);
		for (let i = 0; i < 40 && !stages.includes("abort"); i++) {
			clock.advance(MINUTE_MS);
		}
		expect(stages).toContain("abort");
	});
});

describe("turn liveness under a backward wall-clock step", () => {
	it("positive control: a 6-minute-old sample is stale forward", () => {
		const verdict = kernelVouchedAlive({ latest: freshKernelSample(T0) }, T0 + 6 * MINUTE_MS, {});
		expect(verdict.state).toBe("stale");
	});

	it("fails a heartbeat closed to stale when the clock steps back past the sample", () => {
		// The kernel frame arrived at T0; the wall clock then stepped back 30 minutes.
		// Its age is unknown, and an unknown age cannot certify freshness.
		const verdict = kernelVouchedAlive({ latest: freshKernelSample(T0) }, T0 - 30 * MINUTE_MS, {});
		expect(verdict.state).toBe("stale");
	});

	it("drops the revival vouch when the clock steps back past its anchor", () => {
		let clock = T0;
		const liveness = createTurnLiveness({
			kernel: () => ({ protocol: 4, revival: { since: T0 } }) as never,
			now: () => clock,
			revivalVouchMaxAgeMs: 10 * MINUTE_MS,
		});
		clock = T0 + 11 * MINUTE_MS;
		const forward = liveness.sample();
		expect(forward.vouched).toBe(false);
		expect(forward.kernelReasons).toContain("kernel_revival_aged_out");

		clock = T0 - 30 * MINUTE_MS;
		const rolled = liveness.sample();
		expect(rolled.vouched).toBe(false);
		expect(rolled.kernelReasons).toContain("kernel_revival_aged_out");
	});

	it("expires the degraded journal facts when the clock steps back past the read", () => {
		let clock = T0;
		const liveness = createTurnLiveness({
			kernel: () => ({ protocol: 3 }) as never,
			now: () => clock,
			readJournaledBashHandles: () => ({ liveBashHandles: 2 }),
			degradedFactsMaxAgeMs: 10 * MINUTE_MS,
		});
		liveness.refreshDegradedFacts();
		clock = T0 + 11 * MINUTE_MS;
		const forward = liveness.sample();
		expect(forward.vouched).toBe(false);

		const rolledLiveness = createTurnLiveness({
			kernel: () => ({ protocol: 3 }) as never,
			now: () => clock,
			readJournaledBashHandles: () => ({ liveBashHandles: 2 }),
			degradedFactsMaxAgeMs: 10 * MINUTE_MS,
		});
		clock = T0;
		rolledLiveness.refreshDegradedFacts();
		clock = T0 - 45 * MINUTE_MS;
		const rolled = rolledLiveness.sample();
		expect(rolled.vouched).toBe(false);
		expect(rolled.degraded).toBe(false);
	});
});

describe("cron scheduler under a backward wall-clock step", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a due job at its armed cadence after a backward step", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		try {
			const root = mkdtemp();
			const storePath = join(root, "cron-jobs.json");
			const store = new AgentCronJobStore(storePath);
			store.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(root, "sessions", "session-1.jsonl"),
				cwd: root,
				scheduleText: "in 5m",
				prompt: "rollback cadence job",
				now: new Date(T0),
			});
			const runJob = vi.fn(async () => "ran" as const);
			const scheduler = new AgentCronScheduler(store, { runJob });
			scheduler.start();
			// The wall clock steps back 30 minutes after the arm was set for 5 minutes.
			vi.setSystemTime(T0 - 30 * MINUTE_MS);
			await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
			expect(runJob).toHaveBeenCalledTimes(1);
			scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("positive control: no step, the job still runs after exactly 5 minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		try {
			const root = mkdtemp();
			const storePath = join(root, "cron-jobs.json");
			const store = new AgentCronJobStore(storePath);
			store.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(root, "sessions", "session-1.jsonl"),
				cwd: root,
				scheduleText: "in 5m",
				prompt: "forward cadence job",
				now: new Date(T0),
			});
			const runJob = vi.fn(async () => "ran" as const);
			const scheduler = new AgentCronScheduler(store, { runJob });
			scheduler.start();
			await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
			expect(runJob).toHaveBeenCalledTimes(1);
			scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("cron scheduler exit hygiene", () => {
	it("does not hold the process open with a far-future arm", async () => {
		const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
		const scriptPath = resolve(__dirname, "fixtures/cron-scheduler-unref-child.ts");
		const child = spawn(process.execPath, [tsxPath, scriptPath], {
			cwd: __dirname,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		const exited = new Promise<boolean>((resolveExit) => {
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
				resolveExit(false);
			}, 10_000);
			child.on("exit", () => {
				clearTimeout(killTimer);
				resolveExit(true);
			});
		});
		expect(await exited).toBe(true);
		expect(stdout).toContain("armed");
	}, 30_000);
});

describe("legacy cron migration backup names", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not overwrite an earlier backup when the wall clock repeats a timestamp", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		try {
			runBackupCollisionScenario();
		} finally {
			vi.useRealTimers();
		}
	});

	function runBackupCollisionScenario(): void {
		const root = mkdtemp();
		const legacyPath = join(root, "cron-jobs.json");
		const now = new Date(T0);
		for (let round = 0; round < 2; round++) {
			const legacy = new AgentCronJobStore(legacyPath);
			legacy.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(root, "sessions", "session-1.jsonl"),
				cwd: root,
				scheduleText: "in 1h",
				prompt: "backup collision job",
				now,
			});
			expect(migrateLegacyCronJobsToSessionArtifacts(legacyPath, { now })).toBe(1);
		}
		// Two migrations at the same wall timestamp must leave two distinct backups,
		// not one file overwritten by the second rename.
		const backups = readdirSync(root).filter((name) => name.startsWith("cron-jobs.json.migrated-"));
		expect(backups.length).toBe(2);
	}
});

describe("heartbeat sample retention across a clock step", () => {
	it("positive control: throttles frames closer than the minimum gap", () => {
		expect(shouldRetainHeartbeatSample(T0 + 500, T0)).toBe(false);
		expect(shouldRetainHeartbeatSample(T0 + 1_000, T0)).toBe(true);
	});

	it("retains a frame when the wall clock steps back past the retained sample", () => {
		expect(shouldRetainHeartbeatSample(T0 - 30 * MINUTE_MS, T0)).toBe(true);
	});
});

describe("mixed-clock idle eviction clamp", () => {
	const idleSnapshot = (lastActivityAt: number) => ({
		isSessionActive: false,
		attachedClients: 0,
		hasRegisteredCronJob: false,
		hasParent: true,
		hasNonPassiveDescendants: false,
		isHydrating: false,
		lastActivityAt,
	});

	it("positive control: 31 minutes of real idle stays evictable, 25 does not", () => {
		expect(canPassivateSession(idleSnapshot(T0 - 31 * MINUTE_MS), 30, T0)).toBe(true);
		expect(canPassivateSession(idleSnapshot(T0 - 25 * MINUTE_MS), 30, T0)).toBe(false);
	});

	it("clamps a supervisor clock that stepped forward past this side's monotonic elapsed", () => {
		const anchor = { wall: T0 - 25 * MINUTE_MS, mono: 1_000 };
		// Five real minutes passed since the anchor; the supervisor's clock stepped
		// forward 10 minutes on top, reading 35 minutes of "idle" for a 25-minute-old session.
		const clamped = clampForeignClockNow(T0 + 10 * MINUTE_MS, anchor, 1_000 + 5 * MINUTE_MS);
		expect(canPassivateSession(idleSnapshot(T0 - 25 * MINUTE_MS), 30, clamped)).toBe(false);
		// Unclamped, the same step evicts a session that is not idle yet.
		expect(canPassivateSession(idleSnapshot(T0 - 25 * MINUTE_MS), 30, T0 + 10 * MINUTE_MS)).toBe(true);
	});
});

function mkdtemp(): string {
	const dir = join(tmpdir(), `r41-clock-rollback-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
