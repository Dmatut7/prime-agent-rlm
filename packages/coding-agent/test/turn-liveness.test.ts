import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelLivenessSample } from "../src/core/kernel/shared.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { STALL_VOUCH_REASONS } from "../src/core/stall-watchdog.js";
import {
	createTurnLiveness,
	DEFAULT_DEGRADED_FACTS_MAX_AGE_MS,
	DEFAULT_HOST_REQUEST_MAX_AGE_MS,
	type JournaledBashFacts,
	kernelVouchedAlive,
	readJournaledBashHandles,
	TURN_LIVENESS_REASONS,
	type TurnLivenessEvent,
	type TurnLivenessKernelFacts,
} from "../src/core/turn-liveness.js";

/**
 * T1-3 fact source: the verdict that decides whether silence is excused, and how much budget it
 * buys. Two properties carry the whole design and are pinned from both directions here: existence
 * of something (a handle, a live loop) is liveness and buys the short tier, while movement
 * (streamed bytes, pipe backlog, buffered output, a host request being executed) is progress and
 * buys the full one. A loop tick is deliberately on the liveness side - `await
 * asyncio.Event().wait()` ticks forever, and handing it the full budget would excuse a deadlock.
 */
const T0 = 1_000_000;

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		receivedAt: T0,
		tick: 10,
		intervalMs: 5_000,
		cellId: "cell-1",
		cpuMs: 1_000,
		streamBytes: 0,
		cellsDone: 0,
		hostRequests: 0,
		bashHandles: 0,
		bashCellHandles: 0,
		bashBufferedBytes: 0,
		bashPipePending: 0,
		...overrides,
	};
}

function facts(overrides: Partial<TurnLivenessKernelFacts> = {}): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		hasActiveExecution: true,
		kernelPid: 4242,
		...overrides,
	};
}

describe("kernelVouchedAlive", () => {
	it("classifies the three states by the kernel's own interval", () => {
		const cases: [string, KernelLivenessSample | undefined, number, "fresh" | "stale" | "absent"][] = [
			["no sample at all", undefined, T0, "absent"],
			["just arrived", sample({ receivedAt: T0 }), T0 + 1_000, "fresh"],
			["two intervals old", sample({ receivedAt: T0, intervalMs: 5_000 }), T0 + 10_000, "fresh"],
			["three intervals and a day", sample({ receivedAt: T0, intervalMs: 5_000 }), T0 + 15_001, "stale"],
			// The kernel reports its own period, so a slowed heartbeat is judged against itself.
			["a 15s heartbeat at 45s", sample({ receivedAt: T0, intervalMs: 15_000 }), T0 + 45_000, "fresh"],
			["a 15s heartbeat past 45s", sample({ receivedAt: T0, intervalMs: 15_000 }), T0 + 45_001, "stale"],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [name, latest, now, expected] of cases) {
			expect(kernelVouchedAlive({ latest }, now).state, name).toBe(expected);
		}
	});

	it("reports an absent heartbeat as no evidence, with an age only when there is one", () => {
		const absent = kernelVouchedAlive({}, T0);
		expect(absent.state).toBe("absent");
		expect(absent.ageMs).toBeUndefined();
		expect(absent.loopAlive).toBe(false);
		expect(absent.cellAwaiting).toBe(false);
		expect(absent.progress).toBe(false);
		// Positive control: the same shape with a sample does report an age.
		expect(kernelVouchedAlive({ latest: sample({ receivedAt: T0 - 2_000 }) }, T0).ageMs).toBe(2_000);
	});

	it("reads loop liveness from the tick delta, not from the frames arriving", () => {
		const previous = sample({ receivedAt: T0, tick: 10 });
		// A synchronous cell monopolizes the loop: frames keep coming, the tick does not move.
		const blocked = kernelVouchedAlive(
			{ previous, latest: sample({ receivedAt: T0 + 5_000, tick: 10 }) },
			T0 + 5_000,
		);
		expect(blocked.loopAlive).toBe(false);
		// An awaiting cell yields: the tick advances between the same two frames.
		const live = kernelVouchedAlive({ previous, latest: sample({ receivedAt: T0 + 5_000, tick: 20 }) }, T0 + 5_000);
		expect(live.loopAlive).toBe(true);
		// One retained sample cannot answer the question either way.
		expect(kernelVouchedAlive({ latest: sample() }, T0).loopAlive).toBe(false);
	});

	it("counts movement as progress and a ticking loop as liveness only", () => {
		const previous = sample({ receivedAt: T0, tick: 10, streamBytes: 0, bashBufferedBytes: 0, cellsDone: 0 });
		const cases: [string, Partial<KernelLivenessSample>, boolean, boolean][] = [
			// [name, latest overrides, progress, bashProgress]
			["nothing moved, loop ticking", { tick: 40 }, false, false],
			["streamed bytes", { tick: 40, streamBytes: 900 }, true, true],
			["buffered output", { tick: 40, bashBufferedBytes: 512 }, true, true],
			["pipe backlog on one sample", { tick: 40, bashPipePending: 2 }, true, true],
			["a request finished", { tick: 40, cellsDone: 1 }, true, false],
			["cpu burned, nothing shipped", { tick: 10, cpuMs: 90_000 }, false, false],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [name, overrides, progress, bashProgress] of cases) {
			const verdict = kernelVouchedAlive(
				{ previous, latest: sample({ receivedAt: T0 + 5_000, ...overrides }) },
				T0 + 5_000,
			);
			expect(verdict.progress, name).toBe(progress);
			expect(verdict.bashProgress, name).toBe(bashProgress);
		}
		// A counter that somehow went backwards (a restarted kernel, a torn read) never reads as
		// negative progress.
		const backwards = kernelVouchedAlive(
			{ previous: sample({ streamBytes: 500 }), latest: sample({ receivedAt: T0 + 5_000, streamBytes: 0 }) },
			T0 + 5_000,
		);
		expect(backwards.progress).toBe(false);
	});

	it("needs two samples before it calls the loop stalled", () => {
		// One retained sample means the tick never had a chance to move, so "stalled" would be a
		// guess. Reachable with a heartbeat interval near its ceiling: a 600s interval leaves a
		// single frame before a 900s abort.
		expect(kernelVouchedAlive({ latest: sample({ tick: 10 }) }, T0).loopStalled).toBe(false);
		expect(kernelVouchedAlive({}, T0).loopStalled).toBe(false);
		// Positive control: the same frozen tick, with a delta to judge it by, is a finding.
		expect(
			kernelVouchedAlive({ previous: sample({ tick: 10 }), latest: sample({ receivedAt: T0, tick: 10 }) }, T0)
				.loopStalled,
		).toBe(true);
		// ... and a moving tick is not.
		expect(
			kernelVouchedAlive({ previous: sample({ tick: 10 }), latest: sample({ receivedAt: T0, tick: 11 }) }, T0)
				.loopStalled,
		).toBe(false);
	});
});

describe("createTurnLiveness", () => {
	function build(options: {
		kernel?: TurnLivenessKernelFacts | undefined;
		now?: number;
		journal?: (kernelPid: number | undefined) => JournaledBashFacts | undefined;
		hostRequestMaxAgeMs?: number;
		degradedFactsMaxAgeMs?: number;
	}) {
		const events: TurnLivenessEvent[] = [];
		let clock = options.now ?? T0;
		const liveness = createTurnLiveness({
			kernel: () => options.kernel,
			now: () => clock,
			onEvent: (event) => {
				events.push(event);
			},
			...(options.journal ? { readJournaledBashHandles: options.journal } : {}),
			...(options.hostRequestMaxAgeMs === undefined ? {} : { hostRequestMaxAgeMs: options.hostRequestMaxAgeMs }),
			...(options.degradedFactsMaxAgeMs === undefined
				? {}
				: { degradedFactsMaxAgeMs: options.degradedFactsMaxAgeMs }),
		});
		return {
			liveness,
			events,
			advance(ms: number): void {
				clock += ms;
			},
			setClock(at: number): void {
				clock = at;
			},
		};
	}

	it("vouches for an in-flight host request as progress, and stops at the age bound", () => {
		const { liveness } = build({
			kernel: facts({ latest: sample(), hostRequestCount: 1, hostRequestOldestAgeMs: 30_000 }),
		});
		const vouched = liveness.sample();
		expect(vouched.vouched).toBe(true);
		expect(vouched.reasons).toContain(STALL_VOUCH_REASONS.hostRequestInFlight);
		expect(vouched.progress).toBe(true);
		expect(vouched.hostRequestCount).toBe(1);

		// B7 / I-5: one request older than the bound stops excusing silence, so a wedged host
		// handler cannot hold the whole exemption budget.
		const aged = build({
			kernel: facts({
				latest: sample(),
				hostRequestCount: 1,
				hostRequestOldestAgeMs: DEFAULT_HOST_REQUEST_MAX_AGE_MS + 1,
			}),
		});
		const agedFacts = aged.liveness.sample();
		expect(agedFacts.vouched).toBe(false);
		expect(agedFacts.kernelReasons).toContain(TURN_LIVENESS_REASONS.hostRequestAgedOut);
		// Positive control: exactly at the bound still vouches.
		const atBound = build({
			kernel: facts({
				latest: sample(),
				hostRequestCount: 1,
				hostRequestOldestAgeMs: DEFAULT_HOST_REQUEST_MAX_AGE_MS,
			}),
		});
		expect(atBound.liveness.sample().vouched).toBe(true);
	});

	it("separates a live handle with movement from a live handle with none", () => {
		// M3's shape: a command wedged on stdin has a handle and produces nothing.
		const hung = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 40, bashHandles: 1, bashCellHandles: 1 }),
			}),
		});
		const hungFacts = hung.liveness.sample();
		expect(hungFacts.vouched).toBe(true);
		expect(hungFacts.reasons).toContain(STALL_VOUCH_REASONS.liveBashHandles);
		// The loop is ticking (the cell awaits the handle), so it vouches too - but a tick is
		// liveness, not movement, so the tier stays short. This is the case that decides whether
		// a command wedged on stdin is rescued near today's window or after the full budget.
		expect(hungFacts.reasons).toContain(STALL_VOUCH_REASONS.kernelLoopAwaitingCell);
		expect(hungFacts.progress).toBe(false);
		expect(hungFacts.liveBashHandles).toBe(1);

		// The same handle streaming output is a working job, not a hung one.
		const working = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10, streamBytes: 100 }),
				latest: sample({ tick: 40, bashHandles: 1, bashCellHandles: 1, streamBytes: 900 }),
			}),
		});
		const workingFacts = working.liveness.sample();
		expect(workingFacts.vouched).toBe(true);
		expect(workingFacts.progress).toBe(true);
		expect(workingFacts.reasons).toContain(STALL_VOUCH_REASONS.liveBashHandles);
	});

	it("vouches for a live loop awaiting the cell, without granting it progress", () => {
		const { liveness } = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 40, cellId: "cell-1" }),
			}),
		});
		const sampled = liveness.sample();
		expect(sampled.vouched).toBe(true);
		expect(sampled.reasons).toEqual([STALL_VOUCH_REASONS.kernelLoopAwaitingCell]);
		expect(sampled.progress).toBe(false);
	});

	it("does not vouch when the loop is stalled and nothing else is running", () => {
		const { liveness } = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 10, cellId: "cell-1" }),
			}),
		});
		const sampled = liveness.sample();
		// The genuine deadlock: frames arrive, the tick is frozen, no handle, no host request.
		expect(sampled.vouched).toBe(false);
		expect(sampled.reasons).toEqual([]);
		expect(sampled.kernelReasons).toEqual([TURN_LIVENESS_REASONS.loopStalled]);
		expect(sampled.state).toBe("fresh");
	});

	it("falls back to the journaled bash handles when the heartbeat went stale", () => {
		const reads: (number | undefined)[] = [];
		const { liveness, events, advance } = build({
			kernel: facts({
				latest: sample({ receivedAt: T0, intervalMs: 15_000, bashHandles: 1 }),
				kernelPid: 4242,
			}),
			journal: (kernelPid) => {
				reads.push(kernelPid);
				return { liveBashHandles: 2 };
			},
		});

		// Acceptance (5): the heartbeat stopped 45s+ ago (three of its own 15s intervals).
		advance(46_000);
		const beforeRefresh = liveness.sample();
		expect(beforeRefresh.state).toBe("stale");
		expect(beforeRefresh.vouched).toBe(false);
		expect(beforeRefresh.kernelReasons).toContain(TURN_LIVENESS_REASONS.heartbeatStale);
		expect(reads).toEqual([]);

		// The session refreshes at most once per stall stage; the read is what makes the
		// fallback real instead of a silent no-op.
		liveness.refreshDegradedFacts();
		expect(reads).toEqual([4242]);
		const degraded = liveness.sample();
		expect(degraded.vouched).toBe(true);
		expect(degraded.degraded).toBe(true);
		expect(degraded.liveBashHandles).toBe(2);
		expect(degraded.reasons).toEqual([STALL_VOUCH_REASONS.liveBashHandles, TURN_LIVENESS_REASONS.degradedJournal]);
		// A journal record proves existence, never movement: the short tier only.
		expect(degraded.progress).toBe(false);
		expect(events).toEqual([expect.objectContaining({ kind: "degraded_read", kernelPid: 4242, liveBashHandles: 2 })]);
		expect(liveness.degradedReads).toBe(1);
		expect(liveness.degradedEngagements).toBe(1);

		// The read has a lifetime; an expired one must be re-read, not trusted forever.
		advance(DEFAULT_DEGRADED_FACTS_MAX_AGE_MS + 1);
		const expired = liveness.sample();
		expect(expired.vouched).toBe(false);
		expect(expired.degraded).toBe(false);
		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "degraded_expired" })]));
	});

	it("uses the host's own facts when the kernel reports none at all", () => {
		// Protocol 3 (or no kernel): absent facts are not dead facts.
		const reads: (number | undefined)[] = [];
		const { liveness } = build({
			kernel: facts({ protocol: 3, latest: undefined, previous: undefined, kernelPid: 99 }),
			journal: (kernelPid) => {
				reads.push(kernelPid);
				return { liveBashHandles: 1 };
			},
		});
		const absent = liveness.sample();
		expect(absent.state).toBe("absent");
		expect(absent.vouched).toBe(false);
		// A kernel below the heartbeat protocol sends nothing by design: that is the expected
		// state, not a finding, so it does not appear in the reasons a stall report carries.
		expect(absent.kernelReasons).toEqual([]);
		expect(absent.protocol).toBe(3);

		liveness.refreshDegradedFacts();
		expect(reads).toEqual([99]);
		expect(liveness.sample().vouched).toBe(true);
	});

	it("reports rejected frames as a reason instead of quietly looking like protocol 3", () => {
		const { liveness } = build({
			kernel: facts({ latest: undefined, rejectedFrames: 7, consecutiveRejectedFrames: 7 }),
		});
		const sampled = liveness.sample();
		expect(sampled.vouched).toBe(false);
		expect(sampled.kernelReasons).toEqual([
			TURN_LIVENESS_REASONS.noKernelFacts,
			TURN_LIVENESS_REASONS.heartbeatRejected,
		]);
		expect(sampled.rejectedFrames).toBe(7);
	});

	it("says so when the degraded read fails, and vouches nothing", () => {
		const { liveness, events } = build({
			kernel: facts({ latest: undefined, kernelPid: 7 }),
			journal: () => ({ error: "EACCES" }),
		});
		liveness.refreshDegradedFacts();
		expect(liveness.sample().vouched).toBe(false);
		expect(events).toEqual([expect.objectContaining({ kind: "degraded_read_failed", reason: "EACCES" })]);
	});

	it("keeps a zero-handle journal read from vouching, and drops state on reset", () => {
		const { liveness } = build({
			kernel: facts({ latest: undefined, kernelPid: 7 }),
			journal: () => ({ liveBashHandles: 0 }),
		});
		liveness.refreshDegradedFacts();
		expect(liveness.sample().vouched).toBe(false);

		const withHandle = build({
			kernel: facts({ latest: undefined, kernelPid: 7 }),
			journal: () => ({ liveBashHandles: 3 }),
		});
		withHandle.liveness.refreshDegradedFacts();
		expect(withHandle.liveness.sample().vouched).toBe(true);
		// A new turn must not inherit the previous turn's degraded read.
		withHandle.liveness.reset();
		expect(withHandle.liveness.sample().vouched).toBe(false);
	});

	it("does not put a guessed loop_stalled in the reasons (N1)", () => {
		const single = build({ kernel: facts({ latest: sample({ tick: 10, cellId: "cell-1" }), previous: undefined }) });
		const sampled = single.liveness.sample();
		expect(sampled.state).toBe("fresh");
		expect(sampled.vouched).toBe(false);
		// The batch's production signature is "an abort that still happens comes with
		// kernel.reasons=[loop_stalled]"; a reason with no delta behind it would poison it.
		expect(sampled.kernelReasons).toEqual([]);

		const withPrevious = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 10, cellId: "cell-1" }),
			}),
		});
		expect(withPrevious.liveness.sample().kernelReasons).toEqual([TURN_LIVENESS_REASONS.loopStalled]);
	});

	it("treats a host request with no measurable age as aged out (N2)", () => {
		// Both facts come from one map in the real client, so this is unreachable today; it is a
		// footgun for any future KernelClient that implements the count but not the age. The
		// fail-safe direction is "does not vouch", never "vouches without a bound".
		const { liveness } = build({ kernel: facts({ latest: sample(), hostRequestCount: 1 }) });
		const sampled = liveness.sample();
		expect(sampled.vouched).toBe(false);
		expect(sampled.kernelReasons).toContain(TURN_LIVENESS_REASONS.hostRequestAgedOut);
	});

	it("samples without a kernel at all", () => {
		const { liveness } = build({ kernel: undefined });
		const sampled = liveness.sample();
		expect(sampled.vouched).toBe(false);
		expect(sampled.state).toBe("absent");
		expect(sampled.hostRequestCount).toBe(0);
		expect(sampled.protocol).toBeUndefined();
		expect(sampled.kernelReasons).toEqual([]);
	});

	it("reports a negotiated-4 kernel that sends nothing as a finding", () => {
		// The heartbeat thread died, or every frame failed validation: this is the case where
		// "no facts" is evidence rather than an older runtime doing what it was told.
		const { liveness } = build({
			kernel: facts({ protocol: 4, latest: undefined, previous: undefined, kernelPid: 5 }),
		});
		const sampled = liveness.sample();
		expect(sampled.state).toBe("absent");
		expect(sampled.kernelReasons).toEqual([TURN_LIVENESS_REASONS.noKernelFacts]);
		expect(sampled.vouched).toBe(false);
	});
});

describe("readJournaledBashHandles", () => {
	let tempDir = "";
	let savedJournal: string | undefined;

	function journalPath(): string {
		return join(tempDir, "orphan-journal.jsonl");
	}

	function writeJournal(records: Record<string, unknown>[]): void {
		writeFileSync(journalPath(), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	}

	function env(path?: string): NodeJS.ProcessEnv {
		const base: NodeJS.ProcessEnv = { ...process.env };
		delete base[ORPHAN_PROCESS_JOURNAL_ENV];
		return path === undefined ? base : { ...base, [ORPHAN_PROCESS_JOURNAL_ENV]: path };
	}

	function record(pid: number, kernelPid?: number): Record<string, unknown> {
		return {
			version: 1,
			pid,
			ownerPid: process.pid,
			...(kernelPid === undefined ? {} : { kernelPid }),
			active: true,
			recordedAt: new Date().toISOString(),
		};
	}

	beforeEach(() => {
		savedJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-turn-liveness-"));
	});

	afterEach(() => {
		if (savedJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = savedJournal;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("counts one kernel's journaled children and nobody else's", () => {
		writeJournal([
			record(1001, 4242),
			record(1002, 4242),
			// The kernel itself is not one of its own bash children.
			record(4242, 4242),
			// A sibling kernel's child must not vouch for this session.
			record(2001, 9999),
			// A host-written record with no kernel attribution.
			record(3001),
		]);

		const result = readJournaledBashHandles(4242, env(journalPath()));
		expect(result).toEqual({ liveBashHandles: 2 });
		// Positive control: the sibling kernel sees exactly its own child.
		expect(readJournaledBashHandles(9999, env(journalPath()))).toEqual({ liveBashHandles: 1 });
	});

	it("is not applicable without a journal or without a kernel pid", () => {
		writeJournal([record(1001, 4242)]);

		const cases: [string, number | undefined, NodeJS.ProcessEnv][] = [
			["no journal configured", 4242, env(undefined)],
			["no kernel pid", undefined, env(journalPath())],
			["a pid that is not an integer", Number.NaN, env(journalPath())],
			["a pid that cannot be a process", 0, env(journalPath())],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [name, kernelPid, environment] of cases) {
			expect(readJournaledBashHandles(kernelPid, environment), name).toBeUndefined();
		}
	});

	it("reports a failed read instead of reporting zero handles", () => {
		// A directory where the journal file should be: readFileSync fails with EISDIR.
		mkdirSync(journalPath());

		const result = readJournaledBashHandles(4242, env(journalPath()));
		expect(result).toBeDefined();
		expect(result !== undefined && "error" in result).toBe(true);
	});

	it("counts nothing when the journal has no active records for that kernel", () => {
		writeJournal([{ ...record(1001, 4242), active: false }]);

		expect(readJournaledBashHandles(4242, env(journalPath()))).toEqual({ liveBashHandles: 0 });
	});

	it("does not throw when the journal file is missing", () => {
		const read = vi.fn(readJournaledBashHandles);
		expect(read(4242, env(join(tempDir, "missing.jsonl")))).toEqual({ liveBashHandles: 0 });
	});
});
