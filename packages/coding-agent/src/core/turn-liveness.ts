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
import type { KernelLivenessSample } from "./kernel/shared.js";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "./orphan-process-journal.js";
import { STALL_KERNEL_REASONS, STALL_VOUCH_REASONS } from "./stall-watchdog.js";

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
} as const;

/** A host request older than this stops vouching: a wedged handler must not excuse silence forever. */
export const DEFAULT_HOST_REQUEST_MAX_AGE_MS = 15 * 60 * 1000;
/**
 * A degraded journal read is only trusted for this long; after that it must be re-read.
 *
 * Fifteen minutes, i.e. about the pre-exemption rescue window: the fallback exists so a kernel
 * that stopped reporting does not lose the vouch entirely, not so a file read from long ago can
 * keep excusing silence indefinitely. It has to outlive one abort re-check interval (a warn
 * window), or it expires exactly between the two samplings that matter - the warn stage that read
 * it and the abort check that would have used it.
 */
export const DEFAULT_DEGRADED_FACTS_MAX_AGE_MS = 15 * 60 * 1000;
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
	/** Lifetime of one degraded read. Default {@link DEFAULT_DEGRADED_FACTS_MAX_AGE_MS}. */
	degradedFactsMaxAgeMs?: number | (() => number);
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
	/** The kernel says a cell is in flight. */
	cellAwaiting: boolean;
	/** Something observably moved: streamed bytes, pipe backlog, buffered output, a finished cell. */
	progress: boolean;
	/** Bash-side movement only, which is what a live-handle vouch may upgrade its tier with. */
	bashProgress: boolean;
}

export interface TurnLivenessFacts {
	/** True when externally owned work is verifiably in flight. */
	vouched: boolean;
	/** Vouch sub-reasons, from stall-watchdog's vocabulary. */
	reasons: string[];
	/** True when the vouch is backed by movement rather than by existence alone. */
	progress: boolean;
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
		return { state: "absent", loopAlive: false, cellAwaiting: false, progress: false, bashProgress: false };
	}
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
		cellAwaiting: latest.cellId !== undefined,
		progress: bashProgress || cellsDelta > 0,
		bashProgress,
	};
}

/**
 * Journaled bash children of one kernel: the degraded fact source for when the heartbeat is stale
 * or absent (B4 - the fallback must exist and must not fail silently).
 *
 * One bounded file read, no per-record process probes, so it is safe once per stall stage. Pid
 * reuse is deliberately not checked here (that costs a process query per record); the caller
 * bounds the result's lifetime instead, and the fact only ever buys the shorter budget tier.
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
		const records = readActiveOrphanProcesses(path, process.pid);
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
	const degradedFactsMaxAgeMs = (): number => {
		const configured = options.degradedFactsMaxAgeMs ?? DEFAULT_DEGRADED_FACTS_MAX_AGE_MS;
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

	let degraded: { liveBashHandles: number; readAt: number } | undefined;
	let degradedReads = 0;
	let degradedEngagements = 0;

	function refreshDegradedFacts(): void {
		const at = now();
		// Bounded by lifetime, not only by call site: a read whose result is still inside its TTL
		// would add nothing, so the session can afford to refresh on a tool start as well as on a
		// stall stage without turning the fallback into a polling loop.
		if (degraded && at - degraded.readAt <= degradedFactsMaxAgeMs()) return;
		const kernel = options.kernel();
		const kernelPid = kernel?.kernelPid;
		const result = readJournal(kernelPid);
		degradedReads++;
		if (result === undefined) {
			// Nothing to read (no journal configured, no kernel pid yet). Not a failure, and not
			// a fact: the previous read, if any, stays until it expires.
			return;
		}
		if ("error" in result) {
			// B4: the fallback must not fail silently, or a stale heartbeat plus a broken journal
			// reads exactly like "nothing is running".
			degraded = undefined;
			emit({
				kind: "degraded_read_failed",
				...(kernelPid === undefined ? {} : { kernelPid }),
				reason: result.error,
				at: now(),
			});
			return;
		}
		degraded = { liveBashHandles: result.liveBashHandles, readAt: at };
		emit({
			kind: "degraded_read",
			...(kernelPid === undefined ? {} : { kernelPid }),
			liveBashHandles: result.liveBashHandles,
			at: degraded.readAt,
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
		const agedOut = hostRequestCount > 0 && oldestAgeMs !== undefined && oldestAgeMs > hostRequestMaxAgeMs;
		if (hostRequestCount > 0 && !agedOut) {
			reasons.push(STALL_VOUCH_REASONS.hostRequestInFlight);
			// An in-flight host request is work in motion by definition: the host is executing it.
			progress = true;
		} else if (agedOut) {
			kernelReasons.push(TURN_LIVENESS_REASONS.hostRequestAgedOut);
		}

		let liveBashHandles: number | undefined;
		let degradedUsed = false;
		if (verdict.state === "fresh") {
			liveBashHandles = kernel?.latest?.bashHandles;
			if ((liveBashHandles ?? 0) > 0) {
				reasons.push(STALL_VOUCH_REASONS.liveBashHandles);
				// Existence of a handle is liveness; only movement upgrades the tier.
				if (verdict.bashProgress) progress = true;
			}
			if (verdict.loopAlive && verdict.cellAwaiting) {
				reasons.push(STALL_VOUCH_REASONS.kernelLoopAwaitingCell);
			}
			if (!verdict.loopAlive && verdict.cellAwaiting) {
				// Frames arrive but the tick is frozen: a synchronous cell is monopolizing the
				// loop. This is the genuine-deadlock shape, and nothing about it excuses silence.
				kernelReasons.push(TURN_LIVENESS_REASONS.loopStalled);
			}
		} else {
			if (verdict.state === "stale") {
				kernelReasons.push(TURN_LIVENESS_REASONS.heartbeatStale);
			} else {
				kernelReasons.push(TURN_LIVENESS_REASONS.noKernelFacts);
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
			...(kernel?.protocol === undefined ? {} : { protocol: kernel.protocol }),
			...(verdict.ageMs === undefined ? {} : { livenessAgeMs: verdict.ageMs }),
			...(liveBashHandles === undefined ? {} : { liveBashHandles }),
			...(kernel?.kernelPid === undefined ? {} : { kernelPid: kernel.kernelPid }),
			...(kernel?.rejectedFrames === undefined ? {} : { rejectedFrames: kernel.rejectedFrames }),
			hostRequestCount,
		};
	}

	return {
		sample,
		refreshDegradedFacts,
		reset(): void {
			degraded = undefined;
		},
		get degradedReads() {
			return degradedReads;
		},
		get degradedEngagements() {
			return degradedEngagements;
		},
	};
}
