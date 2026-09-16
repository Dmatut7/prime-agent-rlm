import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelLivenessSample } from "../src/core/kernel/shared.js";
import {
	DEGRADED_READ_MAX_BYTES,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
} from "../src/core/orphan-process-journal.js";
import { STALL_VOUCH_REASONS } from "../src/core/stall-watchdog.js";
import {
	createTurnLiveness,
	DEFAULT_DEGRADED_FACTS_MAX_AGE_MS,
	DEFAULT_HOST_REQUEST_MAX_AGE_MS,
	DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS,
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
 * (streamed bytes, pipe backlog, buffered output, a finished request, a host request being
 * executed) is progress and buys the full one. A loop tick is deliberately on the liveness side -
 * `await asyncio.Event().wait()` ticks forever, and handing it the full budget would excuse a
 * deadlock.
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

	it("upgrades the cell vouch on finished requests, and the handle vouch only on bash movement", () => {
		// A cell workload that is provably moving: the loop ticks and `cellsDone` advanced between
		// the two retained frames, with no bash handle, no streamed byte and no host request. The
		// kernel finished a request, which is movement, so this earns the full budget tier.
		const moving = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10, cellsDone: 3 }),
				latest: sample({ tick: 40, cellId: "cell-1", cellsDone: 4 }),
			}),
		});
		const movingFacts = moving.liveness.sample();
		expect(movingFacts.vouched).toBe(true);
		expect(movingFacts.reasons).toEqual([STALL_VOUCH_REASONS.kernelLoopAwaitingCell]);
		expect(movingFacts.progress).toBe(true);

		// The same pair with nothing finished: a tick is liveness, so the tier stays short.
		const ticking = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10, cellsDone: 3 }),
				latest: sample({ tick: 40, cellId: "cell-1", cellsDone: 3 }),
			}),
		});
		expect(ticking.liveness.sample().progress).toBe(false);

		// Bash-side movement still upgrades the cell vouch on its own, without a finished request.
		const streamed = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10, streamBytes: 100 }),
				latest: sample({ tick: 40, cellId: "cell-1", streamBytes: 900 }),
			}),
		});
		expect(streamed.liveness.sample().progress).toBe(true);

		// A live handle that produces nothing keeps the short tier even with a finished request on
		// the frame pair (M3's stdin wedge): here the frozen tick means the cell vouch is absent, so
		// the handle vouch carries the sample alone and only bash-side evidence may upgrade it.
		const wedged = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10, cellsDone: 3 }),
				latest: sample({ tick: 10, cellId: "cell-1", cellsDone: 4, bashHandles: 1, bashCellHandles: 1 }),
			}),
		});
		const wedgedFacts = wedged.liveness.sample();
		expect(wedgedFacts.vouched).toBe(true);
		expect(wedgedFacts.reasons).toEqual([STALL_VOUCH_REASONS.liveBashHandles]);
		expect(wedgedFacts.kernelReasons).toEqual([TURN_LIVENESS_REASONS.loopStalled]);
		expect(wedgedFacts.progress).toBe(false);
	});

	it("vouches for the finishing phase, where a frozen tick is the expected shape (K-P2-2)", () => {
		// The post-run phase (a huge `repr`, the output drain) is synchronous: the loop tick is
		// frozen while the request is still in flight and the frames keep arriving. Without the
		// phase marker this sample is indistinguishable from the genuine-deadlock shape, so a
		// healthy kernel serializing a million-row result is aborted with no reason recorded at all.
		const finishing = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 10, cellId: "cell-1", finishing: true }),
			}),
		});
		const sampled = finishing.liveness.sample();
		expect(sampled.vouched).toBe(true);
		expect(sampled.reasons).toEqual([TURN_LIVENESS_REASONS.kernelFinishingResult]);
		// Existence only: a `__repr__` that waits on a lock looks identical from here, so this buys
		// the short tier and never the progress one.
		expect(sampled.progress).toBe(false);
		// The frozen tick is this phase's own doing, so it is not reported as a stalled loop.
		expect(sampled.kernelReasons).toEqual([]);

		// Same frozen tick, no phase marker: the cell body is blocking the loop, which stays the
		// deadlock shape nothing excuses.
		const blocked = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 5_000, tick: 10 }),
				latest: sample({ tick: 10, cellId: "cell-1" }),
			}),
		});
		const blockedFacts = blocked.liveness.sample();
		expect(blockedFacts.vouched).toBe(false);
		expect(blockedFacts.kernelReasons).toEqual([TURN_LIVENESS_REASONS.loopStalled]);

		// A heartbeat that stopped arriving vouches for nothing, whatever phase it last reported.
		const stale = build({
			kernel: facts({
				previous: sample({ receivedAt: T0 - 60_000, tick: 10 }),
				latest: sample({ receivedAt: T0 - 60_000, tick: 10, cellId: "cell-1", finishing: true }),
			}),
		});
		expect(stale.liveness.sample().vouched).toBe(false);
	});

	it("reads the finishing phase off the frame, and only with a cell to attribute it to", () => {
		expect(kernelVouchedAlive({ latest: sample({ finishing: true }) }, T0).cellFinishing).toBe(true);
		expect(kernelVouchedAlive({ latest: sample({ cellId: undefined, finishing: true }) }, T0).cellFinishing).toBe(
			false,
		);
		expect(kernelVouchedAlive({ latest: sample() }, T0).cellFinishing).toBe(false);
		expect(kernelVouchedAlive({ latest: sample({ finishing: false }) }, T0).cellFinishing).toBe(false);
		expect(kernelVouchedAlive({}, T0).cellFinishing).toBe(false);
	});

	it("identifies movement, so 'moved since I looked' is not confused with 'says it is moving'", () => {
		// A frame the watchdog can compare two samples of: the token is derived from the cumulative
		// output counters, so a job that produced more since the last look has a different one and a
		// wedged job keeps reporting the same claim - and the same token - forever.
		const frame = (overrides: Partial<KernelLivenessSample> = {}) =>
			build({
				kernel: facts({
					previous: sample({ receivedAt: T0 - 5_000, tick: 10, streamBytes: 100 }),
					latest: sample({ tick: 40, bashHandles: 1, bashCellHandles: 1, streamBytes: 900, ...overrides }),
				}),
			}).liveness.sample();

		const baseline = frame();
		expect(baseline.progress).toBe(true);
		expect(baseline.movementToken).toBeDefined();
		// The identical frame again: nothing moved between the two looks.
		expect(frame().movementToken).toBe(baseline.movementToken);

		const moved: [string, Partial<KernelLivenessSample>][] = [
			["more streamed output", { streamBytes: 1_500 }],
			["more buffered output", { bashBufferedBytes: 32 }],
			["a pipe backlog appeared", { bashPipePending: 1 }],
			["a request finished", { cellsDone: 1 }],
		];
		expect(moved.length).toBeGreaterThan(0);
		for (const [name, overrides] of moved) {
			expect(frame(overrides).movementToken, name).not.toBe(baseline.movementToken);
		}

		// A tick is liveness, and whether cpu counts as activity is a pending product decision
		// (`treatKernelCpuProgressAsActivity`), so neither may look like movement.
		const notMoved: [string, Partial<KernelLivenessSample>][] = [
			["the loop ticked", { tick: 999 }],
			["the kernel burned cpu", { cpuMs: 999_999 }],
			["the frame is newer", { receivedAt: T0 + 5_000 }],
		];
		expect(notMoved.length).toBeGreaterThan(0);
		for (const [name, overrides] of notMoved) {
			expect(frame(overrides).movementToken, name).toBe(baseline.movementToken);
		}
	});

	it("reports no movement token when the heartbeat cannot attest one", () => {
		// No frame at all: nothing to compare.
		expect(build({ kernel: facts() }).liveness.sample().movementToken).toBeUndefined();

		// A stale heartbeat with a journaled handle: the degraded path vouches on existence, and
		// existence must never be able to settle the budget of a segment it is excusing.
		const { liveness, advance } = build({
			kernel: facts({
				latest: sample({ receivedAt: T0, intervalMs: 15_000, bashHandles: 1, streamBytes: 900 }),
				kernelPid: 4242,
			}),
			journal: () => ({ liveBashHandles: 2 }),
		});
		advance(46_000);
		liveness.refreshDegradedFacts();
		const degraded = liveness.sample();
		expect(degraded.vouched).toBe(true);
		expect(degraded.degraded).toBe(true);
		expect(degraded.progress).toBe(false);
		expect(degraded.movementToken).toBeUndefined();
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

	it("parses an oversized journal as a bounded tail instead of in full", () => {
		// A journal whose compaction is failing, or a legacy one written before there
		// was a bound, grows without limit; the degraded stall check runs on the host
		// thread and must not scale with it.
		const kernelPid = 4242;
		const pad = "x".repeat(64 * 1024);
		const fillerCount = Math.ceil(DEGRADED_READ_MAX_BYTES / (pad.length + 256)) + 2;
		const records: string[] = [JSON.stringify(record(1001, kernelPid))];
		for (let index = 0; index < fillerCount; index++) {
			records.push(JSON.stringify({ ...record(200_000 + index), active: false, pad }));
		}
		records.push(JSON.stringify(record(1002, kernelPid)));
		writeFileSync(journalPath(), `${records.join("\n")}\n`);
		expect(statSync(journalPath()).size).toBeGreaterThan(DEGRADED_READ_MAX_BYTES);

		// The handle written after the filler is inside the window; the one written
		// before it is not, so the degraded count is a lower bound (a vouch it cannot
		// prove is one it does not give) while the unbounded read stays complete.
		expect(readJournaledBashHandles(kernelPid, env(journalPath()))).toEqual({ liveBashHandles: 1 });
		expect(
			readActiveOrphanProcesses(journalPath(), process.pid).filter((orphan) => orphan.kernelPid === kernelPid),
		).toHaveLength(2);
	});
});

describe("revival vouch (B7 / L10.4)", () => {
	function build(options: {
		kernel?: TurnLivenessKernelFacts | undefined;
		revivalVouchMaxAgeMs?: number | (() => number);
	}) {
		let clock = T0;
		const liveness = createTurnLiveness({
			kernel: () => options.kernel,
			now: () => clock,
			...(options.revivalVouchMaxAgeMs === undefined ? {} : { revivalVouchMaxAgeMs: options.revivalVouchMaxAgeMs }),
		});
		return {
			liveness,
			advance(ms: number): void {
				clock += ms;
			},
		};
	}

	it("vouches for a revival in flight as progress", () => {
		const { liveness } = build({
			// A reviving kernel has no heartbeat yet: this is the only fact on the table, which
			// is exactly the window the vouch exists for (spawn + restore + bootstrap).
			kernel: facts({ latest: undefined, previous: undefined, revival: { since: T0 - 5_000 } }),
		});
		const vouched = liveness.sample();
		expect(vouched.vouched).toBe(true);
		expect(vouched.reasons).toContain(TURN_LIVENESS_REASONS.kernelReviving);
		expect(vouched.progress).toBe(true);
		expect(vouched.revivalAgeMs).toBe(5_000);
	});

	it("stops vouching once the revival outlives the age bound", () => {
		const aged = build({
			kernel: facts({
				latest: undefined,
				previous: undefined,
				revival: { since: T0 - DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS - 1 },
			}),
		});
		const agedFacts = aged.liveness.sample();
		expect(agedFacts.vouched).toBe(false);
		expect(agedFacts.kernelReasons).toContain(TURN_LIVENESS_REASONS.revivalAgedOut);

		// Positive control: exactly at the bound still vouches.
		const atBound = build({
			kernel: facts({
				latest: undefined,
				previous: undefined,
				revival: { since: T0 - DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS },
			}),
		});
		expect(atBound.liveness.sample().vouched).toBe(true);
	});

	it("ages a revival out with its own clock, not with the age it was handed", () => {
		const { liveness, advance } = build({
			kernel: facts({ latest: undefined, previous: undefined, revival: { since: T0 } }),
			revivalVouchMaxAgeMs: 1_000,
		});
		expect(liveness.sample().vouched).toBe(true);
		advance(1_001);
		const aged = liveness.sample();
		expect(aged.vouched).toBe(false);
		expect(aged.kernelReasons).toContain(TURN_LIVENESS_REASONS.revivalAgedOut);
		expect(aged.revivalAgeMs).toBe(1_001);
	});

	it("does not vouch for a session that failed closed", () => {
		// A spent restart budget leaves no revival in flight, so the watchdog gets nothing to
		// exempt: the two mechanisms cannot contradict each other (amend B2/T2-3).
		const { liveness } = build({ kernel: facts({ latest: undefined, previous: undefined, revival: undefined }) });
		const sampled = liveness.sample();
		expect(sampled.vouched).toBe(false);
		expect(sampled.revivalAgeMs).toBeUndefined();
	});
});

describe("staleness threshold vs host sample retention (r35 H-1)", () => {
	it("keeps a healthy sub-second-interval kernel fresh across the 1s retention gap", () => {
		// The host retains heartbeat samples at least 1s apart, so a kernel beating at
		// 200ms has a retained sample up to ~1s old; 3x200ms = 600ms would call it stale.
		const verdict = kernelVouchedAlive({ latest: sample({ receivedAt: T0, intervalMs: 200 }) }, T0 + 950);
		expect(verdict.state).toBe("fresh");
	});

	it("still judges a genuinely stalled fast kernel stale", () => {
		const verdict = kernelVouchedAlive({ latest: sample({ receivedAt: T0, intervalMs: 200 }) }, T0 + 2_000);
		expect(verdict.state).toBe("stale");
	});

	it("leaves the default 5s interval threshold unchanged", () => {
		expect(kernelVouchedAlive({ latest: sample({ receivedAt: T0, intervalMs: 5_000 }) }, T0 + 14_999).state).toBe(
			"fresh",
		);
		expect(kernelVouchedAlive({ latest: sample({ receivedAt: T0, intervalMs: 5_000 }) }, T0 + 15_001).state).toBe(
			"stale",
		);
	});
});
