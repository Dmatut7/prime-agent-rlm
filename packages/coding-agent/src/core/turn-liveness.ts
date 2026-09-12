/**
 * Turn liveness: the aggregate that decides whether kernel and host facts vouch for externally
 * owned work while a turn has gone silent.
 *
 * The stall watchdog aborts a silent turn. Silence is not always a stall: a 40-minute
 * `await bash(...)`, a redirected build, or a cell waiting on a host request all produce silence
 * while real work is happening somewhere the session events cannot see. This module turns the
 * facts the kernel reports (protocol-4 heartbeat frames) and the facts the host already has
 * (in-flight host requests, journaled bash children) into one verdict the watchdog can vouch on.
 *
 * Three rules shape it, and each one is a deliberate failure direction:
 *
 * - Two evidence tiers. A fact that something *exists* (a live handle, a live loop) buys a short
 *   budget near the pre-exemption abort threshold; only a fact that something *moved* (streamed
 *   bytes, pipe backlog, buffered output, a finished request, a host request in flight) buys the
 *   full budget. A command wedged on stdin looks exactly like a long job on existence alone, so
 *   the short tier keeps its rescue close to today's window instead of tripling it.
 * - A loop tick is liveness, not progress. A tick proves the kernel can still be interrupted, and
 *   nothing more: `await asyncio.Event().wait()` ticks happily forever. Treating it as progress
 *   would hand the full budget to a deadlock, which is the one shape this verdict must not excuse.
 * - Absent facts are not dead facts. A kernel that negotiated protocol 3 sends no frames at all;
 *   that is "no evidence either way", so the host falls back to its own two facts (in-flight host
 *   requests and the journaled bash children) instead of either giving up or guessing.
 *
 * Sampling is O(1) and side-effect free - the watchdog samples it on every touch and every timer
 * fire. The one bounded side effect (re-reading the orphan-process journal when the heartbeat
 * went stale) is behind `refreshDegradedFacts()`, which the session calls at most once per stall
 * stage.
 */

import { getLogger } from "@earendil-works/pi-ai";
import type { KernelLivenessSample, KernelRevivalVouch } from "./kernel/shared.js";
import {
	DEGRADED_READ_MAX_BYTES,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
} from "./orphan-process-journal.js";
import { STALL_KERNEL_REASONS, STALL_VOUCH_LIVENESS_BUDGET_MS, STALL_VOUCH_REASONS } from "./stall-watchdog.js";

const livenessLog = getLogger("coding-agent.turn-liveness");

/**
 * Kernel-side reasons outside stall-watchdog's frozen vocabulary. They ride the same
 * `readonly string[]` channel, and the copy humanizer renders an unknown token by replacing
 * underscores, so both read correctly without touching that module.
 */
export const TURN_LIVENESS_REASONS = {
	/** The newest heartbeat is older than three of its own intervals. */
	heartbeatStale: STALL_KERNEL_REASONS.heartbeatStale,
	/** The kernel reports no heartbeat at all (protocol 3, no kernel, or every frame rejected). */
	noKernelFacts: STALL_KERNEL_REASONS.noKernelFacts,
	/** The kernel's loop stopped advancing while a cell was in flight. */
	loopStalled: STALL_KERNEL_REASONS.loopStalled,
	/** Heartbeat frames arrived but failed validation, so there are no usable facts. */
	heartbeatRejected: "heartbeat_rejected",
	/** A host request is in flight but older than the age bound, so it no longer vouches. */
	hostRequestAgedOut: "host_request_aged_out",
	/** The vouch rests on the degraded journal read rather than on a live heartbeat. */
	degradedJournal: "degraded_journal",
	/** A replacement kernel is being spawned, restored and bootstrapped after a death. */
	kernelReviving: "kernel_reviving",
	/** A revival vouch outlived its age bound, so it stopped excusing silence (B7). */
	revivalAgedOut: "kernel_revival_aged_out",
	/**
	 * The kernel is past the cell body and is serializing/draining that cell's result. Existence
	 * only: the phase blocks the loop by design, so nothing about it demonstrates movement.
	 */
	kernelFinishingResult: "kernel_finishing_result",
} as const;

/** A host request older than this stops vouching: a wedged handler must not excuse silence forever. */
export const DEFAULT_HOST_REQUEST_MAX_AGE_MS = 15 * 60 * 1000;
/**
 * A kernel revival older than this stops vouching (B7).
 *
 * Ten minutes covers the whole revival sequence with room to spare - a cold `uv` bootstrap holds
 * the shared lock for up to five minutes, the spawn handshake is bounded at 30s, and a large
 * snapshot read gets its 30s budget plus the longer retry. Without the bound a `run(uv)` that
 * never returns would vouch forever, which is the "50 minutes of silent hang" shape this exists
 * to prevent. Deliberately shorter than {@link DEFAULT_HOST_REQUEST_MAX_AGE_MS}: a revival is
 * host-driven work with known bounds, so it has no business outliving them by much.
 */
export const DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS = 10 * 60 * 1000;
/**
 * Protocol that introduced the heartbeat, mirroring the runtime's own gate. Below it a kernel
 * sends no frames by design, so "no facts" is the expected state and not a finding worth putting
 * in every stall report; at or above it, silence from the sender is evidence (the thread died, or
 * every frame failed validation).
 */
export const KERNEL_HEARTBEAT_MIN_PROTOCOL = 4;
/**
 * A degraded journal read is trusted until this long after the **first** read of the arm cycle.
 *
 * Two invariants, both load bearing (A1):
 *
 * - It must exceed the budget the degraded vouch can buy. The lifetime is a hard deadline, not a
 *   rolling one - a re-read never extends it - so the budget is what ends the deferral and the kill
 *   reports "the exemption was spent" rather than "the evidence blinked". A lifetime shorter than
 *   the budget makes the evidence blink first, and a blink observed by a touch releases the accrued
 *   budget, which is how a renewed exemption ran forever.
 * - It must outlive one abort re-check interval (a warn window), or it expires exactly between the
 *   two samplings that matter: the warn stage that read it and the abort check that would use it.
 *
 * Two liveness budgets (40 minutes) satisfies both with room for any touch cadence below the abort
 * threshold to observe the exhaustion while the facts are still valid.
 */
export const DEFAULT_DEGRADED_FACTS_MAX_AGE_MS = 2 * STALL_VOUCH_LIVENESS_BUDGET_MS;
/**
 * Minimum gap between two journal reads. A re-read exists so a dead orphan stops vouching
 * (a downgrade), not to refresh anything, so the gap is a cost bound rather than a semantic one.
 */
export const DEFAULT_DEGRADED_REFRESH_MIN_GAP_MS = 60 * 1000;
/** Heartbeat staleness, in units of the kernel's own reported interval. */
export const DEFAULT_STALE_AFTER_INTERVALS = 3;
/** Fallback interval when a sample carries none (it always does; this only keeps the math total). */
export const FALLBACK_HEARTBEAT_INTERVAL_MS = 5_000;

/** The kernel facts this aggregate needs, adapted from the session's kernel client. */
export interface TurnLivenessKernelFacts {
	/** Negotiated protocol; absent before the kernel's ready frame. */
	protocol?: number;
	/** Newest retained heartbeat sample; absent when the kernel sent none. */
	latest?: KernelLivenessSample;
	/** Sample before the newest; absent until two are retained. */
	previous?: KernelLivenessSample;
	/** Heartbeat frames rejected for a bad shape since the kernel started. */
	rejectedFrames?: number;
	/** Rejections since the last accepted frame. */
	consecutiveRejectedFrames?: number;
	/** Host requests in flight for this kernel (the host's own authoritative count). */
	hostRequestCount?: number;
	/** Age of the oldest in-flight host request in ms. */
	hostRequestOldestAgeMs?: number;
	/** Kernel process id; scopes the degraded journal read to this kernel's children. */
	kernelPid?: number;
	/** Whether a cell is executing, from the host side of the request. */
	hasActiveExecution?: boolean;
	/**
	 * Present while a replacement kernel is being brought up after a death. The same flag that
	 * blocks snapshot writes gates it, so the two predicates cannot disagree (L10.4).
	 */
	revival?: KernelRevivalVouch;
}

/** Result of the degraded journal read: a count, a failure to report, or "not applicable". */
export type JournaledBashFacts = { liveBashHandles: number } | { error: string };

/** Forensic events; the session routes them to its own log so a degraded path is never silent. */
export type TurnLivenessEvent =
	| { kind: "degraded_read"; kernelPid?: number; liveBashHandles: number; at: number }
	| { kind: "degraded_read_failed"; kernelPid?: number; reason: string; at: number }
	| { kind: "degraded_expired"; liveBashHandles: number; at: number };

export interface TurnLivenessOptions {
	/** Kernel facts; undefined when the session has no kernel. Must be O(1). */
	kernel: () => TurnLivenessKernelFacts | undefined;
	/** Degraded journal reader; defaults to {@link readJournaledBashHandles}. */
	readJournaledBashHandles?: (kernelPid: number | undefined) => JournaledBashFacts | undefined;
	now?: () => number;
	/** Age bound on a vouching host request. Default {@link DEFAULT_HOST_REQUEST_MAX_AGE_MS}. */
	hostRequestMaxAgeMs?: number;
	/**
	 * Age bound on a revival vouch. Default {@link DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS}; `Infinity`
	 * (the settings rollback lever) makes it unbounded again.
	 */
	revivalVouchMaxAgeMs?: number | (() => number);
	/**
	 * Lifetime of the degraded facts, measured from the first read of the arm cycle.
	 * Default {@link DEFAULT_DEGRADED_FACTS_MAX_AGE_MS}; must not be shorter than the budget the
	 * degraded vouch buys (see that constant).
	 */
	degradedFactsMaxAgeMs?: number | (() => number);
	/** Minimum gap between two journal reads. Default {@link DEFAULT_DEGRADED_REFRESH_MIN_GAP_MS}. */
	degradedRefreshMinGapMs?: number | (() => number);
	/** Staleness threshold in heartbeat intervals. Default {@link DEFAULT_STALE_AFTER_INTERVALS}. */
	staleAfterIntervals?: number;
	onEvent?: (event: TurnLivenessEvent) => void;
}

/** Verdict on the kernel's own heartbeat. */
export type KernelLivenessState = "fresh" | "stale" | "absent";

export interface KernelLivenessVerdict {
	state: KernelLivenessState;
	/** Age of the newest sample in ms; absent when there is none. */
	ageMs?: number;
	/** The event-loop tick advanced between the two retained samples. */
	loopAlive: boolean;
	/**
	 * The tick had a delta to be judged against and did not move. False whenever only one sample is
	 * retained: with no previous frame there is no evidence either way, and reporting a stall on a
	 * guess would poison the one reason a residual abort is supposed to carry.
	 */
	loopStalled: boolean;
	/** The kernel says a cell is in flight. */
	cellAwaiting: boolean;
	/**
	 * The in-flight cell is in its post-run finishing phase (repr/drain) rather than executing its
	 * body. That phase is synchronous, so a frozen tick alongside it is the expected shape and not
	 * the deadlock `loopStalled` reports (K-P2-2).
	 */
	cellFinishing: boolean;
	/** Something observably moved: streamed bytes, pipe backlog, buffered output, a finished cell. */
	progress: boolean;
	/** Bash-side movement only, which is what a live-handle vouch may upgrade its tier with. */
	bashProgress: boolean;
	/**
	 * Identity of the movement the newest frame reports, derived from the kernel's cumulative
	 * counters. Two samples carrying the same token saw nothing move between them, however firmly
	 * each of them claims `progress`: a frozen counter reports the same claim forever, so a caller
	 * that must tell "moved since I last looked" from "says it is moving" needs the token, not the
	 * boolean. Absent when there is no frame. Deliberately excludes `tick` (a tick is liveness, not
	 * progress) and `cpuMs` (whether CPU counts as activity is a pending product decision - see
	 * `treatKernelCpuProgressAsActivity`).
	 */
	movementToken?: string;
}

export interface TurnLivenessFacts {
	/** True when externally owned work is verifiably in flight. */
	vouched: boolean;
	/** Vouch sub-reasons, from stall-watchdog's vocabulary. */
	reasons: string[];
	/** True when the vouch is backed by movement rather than by existence alone. */
	progress: boolean;
	/**
	 * Identity of the movement the newest *usable* frame reports; absent when there is no frame or
	 * the heartbeat is unusable. A caller that has to tell "moved since I last looked" apart from
	 * "says it is moving" compares two of these. The degraded journal path never carries one: it
	 * proves existence, and existence must not buy movement.
	 */
	movementToken?: string;
	/** Kernel-side reasons, populated whether or not the verdict vouches. */
	kernelReasons: string[];
	/** Heartbeat verdict behind the kernel part of this sample. */
	state: KernelLivenessState;
	/** True when the vouch (or its absence) rests on the degraded journal read. */
	degraded: boolean;
	protocol?: number;
	livenessAgeMs?: number;
	liveBashHandles?: number;
	hostRequestCount?: number;
	kernelPid?: number;
	rejectedFrames?: number;
	/** Age of the revival window in ms; absent when no revival is in flight. */
	revivalAgeMs?: number;
}

export interface TurnLiveness {
	/** O(1), side-effect free: the verdict for right now. */
	sample(): TurnLivenessFacts;
	/**
	 * Re-read the degraded facts. The session calls this at most once per stall stage, and only
	 * while a tool is in flight, so the bounded journal read stays bounded.
	 */
	refreshDegradedFacts(): void;
	/** Drop per-turn state; a new turn must not inherit the previous turn's degraded read. */
	reset(): void;
	/** How many degraded reads happened (diagnostics and tests). */
	readonly degradedReads: number;
	/** How many samples were vouched by a degraded read rather than by a heartbeat. */
	readonly degradedEngagements: number;
}

/**
 * Classify the kernel's heartbeat.
 *
 * `absent` covers three different situations that all mean "no evidence": a kernel that
 * negotiated protocol 3 and sends nothing, a kernel that has not sent its first frame yet, and a
 * kernel whose frames all failed validation. None of them is proof of death, and none of them
 * vouches either - the caller falls back to the host's own facts.
 */
export function kernelVouchedAlive(
	samples: { latest?: KernelLivenessSample; previous?: KernelLivenessSample },
	now: number,
	options: { staleAfterIntervals?: number } = {},
): KernelLivenessVerdict {
	const latest = samples.latest;
	if (!latest) {
		return {
			state: "absent",
			loopAlive: false,
			loopStalled: false,
			cellAwaiting: false,
			cellFinishing: false,
			progress: false,
			bashProgress: false,
		};
	}
	// Level and counter facts about output only: this is what "the job moved" is made of. A counter
	// reset (a replacement kernel) changes it too, which is correct - that is not the same job.
	const movementToken = `${latest.streamBytes}|${latest.bashBufferedBytes}|${latest.bashPipePending}|${latest.cellsDone}`;
	const staleAfterIntervals = options.staleAfterIntervals ?? DEFAULT_STALE_AFTER_INTERVALS;
	const intervalMs = latest.intervalMs > 0 ? latest.intervalMs : FALLBACK_HEARTBEAT_INTERVAL_MS;
	const ageMs = Math.max(0, now - latest.receivedAt);
	const state: KernelLivenessState = ageMs > staleAfterIntervals * intervalMs ? "stale" : "fresh";
	const previous = samples.previous;
	// Deltas, not rates: a frame the host never saw cannot make the next one lie.
	const streamDelta = previous ? Math.max(0, latest.streamBytes - previous.streamBytes) : 0;
	const bufferedDelta = previous ? Math.max(0, latest.bashBufferedBytes - previous.bashBufferedBytes) : 0;
	const cellsDelta = previous ? Math.max(0, latest.cellsDone - previous.cellsDone) : 0;
	// A pipe backlog is a level rather than a delta: bytes waiting to be read right now are
	// output the command already produced, so they count on a single sample too.
	const bashProgress = latest.bashPipePending > 0 || bufferedDelta > 0 || streamDelta > 0;
	return {
		state,
		ageMs,
		loopAlive: previous !== undefined && latest.tick > previous.tick,
		loopStalled: previous !== undefined && latest.tick <= previous.tick,
		cellAwaiting: latest.cellId !== undefined,
		// A phase marker with no cell to attribute it to proves nothing about this turn.
		cellFinishing: latest.finishing === true && latest.cellId !== undefined,
		progress: bashProgress || cellsDelta > 0,
		bashProgress,
		movementToken,
	};
}

/**
 * Journaled bash children of one kernel: the degraded fact source for when the heartbeat is stale
 * or absent (B4 - the fallback must exist and must not fail silently).
 *
 * One bounded file read, no per-record process probes, so it is safe once per stall stage: the
 * journal is compacted at 4096 records / 4MB and this read never parses more than its newest
 * DEGRADED_READ_MAX_BYTES, so a legacy or non-compacting journal cannot turn the degraded check
 * into an unbounded synchronous scan. Past that window the count is a lower bound, which costs a
 * vouch it cannot prove rather than blocking the caller. Pid reuse is deliberately not checked
 * here (that costs a process query per record); the caller bounds the result's lifetime instead,
 * and the fact only ever buys the shorter budget tier.
 * Returns undefined when there is nothing to read (no journal configured, no kernel pid).
 */
export function readJournaledBashHandles(
	kernelPid: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): JournaledBashFacts | undefined {
	const path = env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || kernelPid === undefined || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return undefined;
	}
	try {
		// The journal is shared by the host and its kernels; records written by a kernel carry the
		// host's pid as owner and the kernel's pid as kernelPid.
		const records = readActiveOrphanProcesses(path, process.pid, { maxBytes: DEGRADED_READ_MAX_BYTES });
		return {
			liveBashHandles: records.filter((record) => record.kernelPid === kernelPid && record.pid !== kernelPid).length,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Build the aggregate. Every injected function is called at most once per sample. */
export function createTurnLiveness(options: TurnLivenessOptions): TurnLiveness {
	const now = options.now ?? (() => Date.now());
	const readJournal = options.readJournaledBashHandles ?? readJournaledBashHandles;
	const hostRequestMaxAgeMs = options.hostRequestMaxAgeMs ?? DEFAULT_HOST_REQUEST_MAX_AGE_MS;
	const revivalVouchMaxAgeMs = (): number => {
		const configured = options.revivalVouchMaxAgeMs ?? DEFAULT_REVIVAL_VOUCH_MAX_AGE_MS;
		return typeof configured === "function" ? configured() : configured;
	};
	const degradedFactsMaxAgeMs = (): number => {
		const configured = options.degradedFactsMaxAgeMs ?? DEFAULT_DEGRADED_FACTS_MAX_AGE_MS;
		return typeof configured === "function" ? configured() : configured;
	};
	const degradedRefreshMinGapMs = (): number => {
		const configured = options.degradedRefreshMinGapMs ?? DEFAULT_DEGRADED_REFRESH_MIN_GAP_MS;
		return typeof configured === "function" ? configured() : configured;
	};
	const staleAfterIntervals = options.staleAfterIntervals ?? DEFAULT_STALE_AFTER_INTERVALS;
	const emit = (event: TurnLivenessEvent): void => {
		if (options.onEvent) {
			options.onEvent(event);
			return;
		}
		livenessLog.info(`turn liveness: ${event.kind}`, { ...event });
	};

	let degraded: { liveBashHandles: number; readAt: number; lastAttemptAt: number } | undefined;
	/**
	 * When the degraded facts of this arm cycle became trustworthy, i.e. the deadline anchor. Set by
	 * the first successful read and cleared only by `reset()`: no later read, and no failed one,
	 * may move it, because a renewable deadline is no deadline at all (A1).
	 */
	let degradedFirstReadAt: number | undefined;
	let degradedReads = 0;
	let degradedEngagements = 0;

	function refreshDegradedFacts(): void {
		const at = now();
		// Past the deadline nothing can revive the facts this arm cycle, so do not even pay for the
		// read: the deadline is anchored to the first successful read and never moves.
		if (degradedFirstReadAt !== undefined && at - degradedFirstReadAt > degradedFactsMaxAgeMs()) return;
		// Rate bound, not a usefulness bound: a re-read may *downgrade* the facts (an orphan that
		// died must stop vouching), so it is skipped only for being too soon after the last attempt.
		if (degraded && at - degraded.lastAttemptAt < degradedRefreshMinGapMs()) return;
		const kernel = options.kernel();
		const kernelPid = kernel?.kernelPid;
		const result = readJournal(kernelPid);
		degradedReads++;
		if (result === undefined) {
			// Nothing to read (no journal configured, no kernel pid yet). Not a failure and not a
			// fact; whatever was read before keeps its original deadline.
			if (degraded) degraded = { ...degraded, lastAttemptAt: at };
			return;
		}
		if ("error" in result) {
			// B4: the fallback must not fail silently, or a stale heartbeat plus a broken journal
			// reads exactly like "nothing is running". The deadline anchor survives the failure, so
			// a later successful read cannot use the error to buy a fresh lifetime.
			degraded = undefined;
			emit({
				kind: "degraded_read_failed",
				...(kernelPid === undefined ? {} : { kernelPid }),
				reason: result.error,
				at,
			});
			return;
		}
		const readAt = degradedFirstReadAt ?? at;
		degradedFirstReadAt = readAt;
		degraded = { liveBashHandles: result.liveBashHandles, readAt, lastAttemptAt: at };
		emit({
			kind: "degraded_read",
			...(kernelPid === undefined ? {} : { kernelPid }),
			liveBashHandles: result.liveBashHandles,
			at: readAt,
		});
	}

	function sample(): TurnLivenessFacts {
		const at = now();
		const kernel = options.kernel();
		const verdict = kernelVouchedAlive(kernel ?? {}, at, { staleAfterIntervals });
		const reasons: string[] = [];
		const kernelReasons: string[] = [];
		let progress = false;

		const hostRequestCount = kernel?.hostRequestCount ?? 0;
		const oldestAgeMs = kernel?.hostRequestOldestAgeMs;
		// The host's own fact, and the strongest one: this process is busy on the kernel's behalf.
		// Bounded by age (B7) - a handler that wedged must stop excusing silence, which is what
		// keeps the registered "900s becomes 50min" downgrade from being real.
		// A count with no measurable age is treated as aged out: the real client derives both from
		// one map so this cannot happen today, but a client that implemented only half of the
		// optional API must not end up vouching with no bound at all.
		const agedOut = hostRequestCount > 0 && (oldestAgeMs === undefined || oldestAgeMs > hostRequestMaxAgeMs);
		if (hostRequestCount > 0 && !agedOut) {
			reasons.push(STALL_VOUCH_REASONS.hostRequestInFlight);
			// An in-flight host request is work in motion by definition: the host is executing it.
			progress = true;
		} else if (agedOut) {
			kernelReasons.push(TURN_LIVENESS_REASONS.hostRequestAgedOut);
		}

		// A revival in flight is the host's own work - spawn, restore, bootstrap - while the cell
		// that triggered it waits. Age-bounded like every other vouch (B7), and impossible once
		// the restart budget is spent: a fail-closed kernel has no revival to vouch for, so the
		// watchdog cannot end up exempting a turn that can never produce a cell again.
		const revival = kernel?.revival;
		// Aged against this aggregate's own clock rather than the reported age, so a caller that
		// handed over a stale number cannot extend its own vouch.
		const revivalAgeMs = revival === undefined ? undefined : Math.max(0, at - revival.since);
		const revivalAgedOut = revivalAgeMs !== undefined && revivalAgeMs > revivalVouchMaxAgeMs();
		if (revivalAgeMs !== undefined && !revivalAgedOut) {
			reasons.push(TURN_LIVENESS_REASONS.kernelReviving);
			progress = true;
		} else if (revivalAgedOut) {
			kernelReasons.push(TURN_LIVENESS_REASONS.revivalAgedOut);
		}

		let liveBashHandles: number | undefined;
		let degradedUsed = false;
		// Only a usable heartbeat can attest movement; the degraded path below is existence alone.
		let movementToken: string | undefined;
		if (verdict.state === "fresh") {
			movementToken = verdict.movementToken;
			liveBashHandles = kernel?.latest?.bashHandles;
			if ((liveBashHandles ?? 0) > 0) {
				reasons.push(STALL_VOUCH_REASONS.liveBashHandles);
				// Existence of a handle is liveness; only movement upgrades the tier.
				if (verdict.bashProgress) progress = true;
			}
			if (verdict.loopAlive && verdict.cellAwaiting) {
				reasons.push(STALL_VOUCH_REASONS.kernelLoopAwaitingCell);
				// A tick on its own is liveness, but requests finishing while it ticks are movement
				// the kernel demonstrably made, so a provably-moving cell workload earns the full
				// tier. The live-handle vouch above stays on bash-side evidence alone: a handle that
				// produces nothing must keep its short rescue even if some other cell just finished.
				if (verdict.progress) progress = true;
			}
			if (verdict.cellFinishing) {
				// The kernel finished the cell body and is now serializing or draining its result.
				// That work is synchronous, so the frames keep arriving with a frozen tick and no
				// observable movement: existence alone, which buys the short tier and no more. A
				// `__repr__` that waits on a lock is indistinguishable from a huge one, and the
				// short budget is what keeps that case dying near the pre-exemption threshold.
				reasons.push(TURN_LIVENESS_REASONS.kernelFinishingResult);
			}
			if (verdict.loopStalled && verdict.cellAwaiting && !verdict.cellFinishing) {
				// Frames arrive but the tick is frozen: a synchronous cell is monopolizing the
				// loop. This is the genuine-deadlock shape, and nothing about it excuses silence.
				// The finishing phase is excluded above: there the frozen tick is the point.
				kernelReasons.push(TURN_LIVENESS_REASONS.loopStalled);
			}
		} else {
			if (verdict.state === "stale") {
				kernelReasons.push(TURN_LIVENESS_REASONS.heartbeatStale);
			} else {
				// Only a kernel that negotiated the heartbeat and then sent nothing is a finding;
				// an older kernel is doing what it was told, and saying otherwise in every stall
				// report would drown the reasons that do carry information.
				if ((kernel?.protocol ?? 0) >= KERNEL_HEARTBEAT_MIN_PROTOCOL) {
					kernelReasons.push(TURN_LIVENESS_REASONS.noKernelFacts);
				}
				if ((kernel?.consecutiveRejectedFrames ?? 0) > 0) {
					kernelReasons.push(TURN_LIVENESS_REASONS.heartbeatRejected);
				}
			}
			// Degraded path (B4): no usable heartbeat, so fall back to the journaled children of
			// this kernel. Existence only, so it can never buy the progress tier.
			if (degraded) {
				const age = at - degraded.readAt;
				if (age > degradedFactsMaxAgeMs()) {
					emit({ kind: "degraded_expired", liveBashHandles: degraded.liveBashHandles, at });
					degraded = undefined;
				} else if (degraded.liveBashHandles > 0) {
					liveBashHandles = degraded.liveBashHandles;
					reasons.push(STALL_VOUCH_REASONS.liveBashHandles, TURN_LIVENESS_REASONS.degradedJournal);
					degradedUsed = true;
					degradedEngagements++;
				}
			}
		}

		return {
			vouched: reasons.length > 0,
			reasons,
			progress,
			kernelReasons,
			state: verdict.state,
			degraded: degradedUsed,
			...(movementToken === undefined ? {} : { movementToken }),
			...(kernel?.protocol === undefined ? {} : { protocol: kernel.protocol }),
			...(verdict.ageMs === undefined ? {} : { livenessAgeMs: verdict.ageMs }),
			...(liveBashHandles === undefined ? {} : { liveBashHandles }),
			...(kernel?.kernelPid === undefined ? {} : { kernelPid: kernel.kernelPid }),
			...(kernel?.rejectedFrames === undefined ? {} : { rejectedFrames: kernel.rejectedFrames }),
			...(revivalAgeMs === undefined ? {} : { revivalAgeMs }),
			hostRequestCount,
		};
	}

	return {
		sample,
		refreshDegradedFacts,
		reset(): void {
			degraded = undefined;
			// A new turn gets a new deadline: the previous turn's degraded facts must not excuse
			// this one, and this one must not start already expired.
			degradedFirstReadAt = undefined;
		},
		get degradedReads() {
			return degradedReads;
		},
		get degradedEngagements() {
			return degradedEngagements;
		},
	};
}
