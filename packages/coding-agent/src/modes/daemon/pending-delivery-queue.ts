/**
 * P1-7c: the supervisor's pending agent-message deliveries.
 *
 * A `send_message` whose target is not reachable yet is not a failure and not a
 * mutation the update-restart drain may wait on: it is an entry here. The entry
 * is admitted before the first attempt, so every delivery the supervisor owns is
 * accounted for, and it is removed only with a terminal outcome.
 *
 * B10/F10 — "where is the queue after a restart?" It is not persisted, and it
 * does not need to be, because it never holds a message the sender was told was
 * accepted: the sender's request stays open for the whole delivery, so the
 * restart drain answers every entry with an explicit terminal receipt
 * (`drain("update_restart")`) and logs the ones nobody is waiting for any more.
 * A "queued" receipt in this codebase only ever comes from the target worker's
 * own session queue, which is the queue that has persistence. Nothing here can
 * evaporate silently: an entry leaves through `complete`, `drop` or `drain`.
 */

export type PendingDeliveryAbortReason = "update_restart" | "shutdown" | "supervisor_stopping";

export interface PendingDeliveryEntry {
	readonly deliveryId: string;
	readonly targetActiveSessionId: string;
	readonly senderKey: string;
	readonly enqueuedAt: number;
	/** Wall-clock deadline of the whole delivery, i.e. the preserved 24h budget (C20). */
	readonly deadlineAt: number;
	attempts: number;
	/** When the last retry was scheduled; diagnostic, so a stuck entry is attributable. */
	lastRequeuedAt?: number;
	/** Settled once, by drain(): the delivery loop races it against the worker request. */
	readonly aborted: Promise<PendingDeliveryAbortReason>;
}

export type PendingDeliveryAdmission =
	| { ok: true; entry: PendingDeliveryEntry; queueDepth: number }
	| { ok: false; reason: "capacity"; queueDepth: number; capacity: number };

export interface PendingDeliveryCounters {
	admitted: number;
	requeued: number;
	completed: number;
	dropped: number;
	overflow: number;
	drained: number;
}

interface InternalEntry extends PendingDeliveryEntry {
	abort: (reason: PendingDeliveryAbortReason) => void;
	abortedReason?: PendingDeliveryAbortReason;
}

export class PendingDeliveryCapacityError extends Error {
	constructor(
		readonly targetActiveSessionId: string,
		readonly queueDepth: number,
		readonly capacity: number,
		/** How long the caller should wait before re-issuing (P1-7a channel). */
		readonly retryAfterMs: number,
	) {
		super(
			`Agent message delivery to ${targetActiveSessionId} was rejected: ${queueDepth} deliveries are already pending for that session (capacity ${capacity}). Nothing was queued; retry after ${retryAfterMs}ms.`,
		);
		this.name = "PendingDeliveryCapacityError";
	}
}

export interface PendingDeliveryQueueOptions {
	/** Entries per target session (fix-plan appendix A: 100, provisional). */
	capacity?: number;
	/** One requeue log line per target per this window; the rest are counted into the next one. */
	requeueLogThrottleMs?: number;
	/** Total delivery budget per entry; the C20 compromise keeps the 24h semantics. */
	deliveryBudgetMs?: number;
	now?: () => number;
	idFactory?: () => string;
}

export const DEFAULT_PENDING_DELIVERY_CAPACITY = 100;
/**
 * One `deliver message requeued` line per target per window. A full queue retries
 * every 5s per entry, so without this a 100-entry target writes 20 lines a
 * second; the swallowed count rides along on the next line, exactly like the
 * client catch-up retry's own throttle (`logThrottleMs`, same 60s).
 */
export const PENDING_DELIVERY_REQUEUE_LOG_THROTTLE_MS = 60_000;
/** How long a caller should wait before re-issuing a capacity rejection. */
export const PENDING_DELIVERY_CAPACITY_RETRY_AFTER_MS = 5_000;

export class PendingDeliveryQueue {
	private readonly byTarget = new Map<string, Set<InternalEntry>>();
	private readonly capacity: number;
	private readonly deliveryBudgetMs: number;
	private readonly requeueLogThrottleMs: number;
	private readonly requeueLogState = new Map<string, { lastLoggedAt?: number; suppressed: number }>();
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private idCounter = 0;
	readonly counters: PendingDeliveryCounters = {
		admitted: 0,
		requeued: 0,
		completed: 0,
		dropped: 0,
		overflow: 0,
		drained: 0,
	};

	constructor(options: PendingDeliveryQueueOptions = {}) {
		this.capacity = options.capacity ?? DEFAULT_PENDING_DELIVERY_CAPACITY;
		this.deliveryBudgetMs = options.deliveryBudgetMs ?? 24 * 60 * 60 * 1000;
		this.requeueLogThrottleMs = options.requeueLogThrottleMs ?? PENDING_DELIVERY_REQUEUE_LOG_THROTTLE_MS;
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? (() => `deliver_${++this.idCounter}`);
	}

	depth(targetActiveSessionId: string): number {
		return this.byTarget.get(targetActiveSessionId)?.size ?? 0;
	}

	size(): number {
		let total = 0;
		for (const entries of this.byTarget.values()) total += entries.size;
		return total;
	}

	admit(targetActiveSessionId: string, senderKey: string): PendingDeliveryAdmission {
		const entries = this.byTarget.get(targetActiveSessionId) ?? new Set<InternalEntry>();
		if (entries.size >= this.capacity) {
			this.counters.overflow++;
			return { ok: false, reason: "capacity", queueDepth: entries.size, capacity: this.capacity };
		}
		let abortEntry!: (reason: PendingDeliveryAbortReason) => void;
		const aborted = new Promise<PendingDeliveryAbortReason>((resolveAbort) => {
			abortEntry = resolveAbort;
		});
		// The abort promise is raced, never awaited to completion on its own.
		void aborted.catch(() => undefined);
		const entry: InternalEntry = {
			deliveryId: this.idFactory(),
			targetActiveSessionId,
			senderKey,
			enqueuedAt: this.now(),
			deadlineAt: this.now() + this.deliveryBudgetMs,
			attempts: 0,
			aborted,
			abort: (reason) => {
				if (entry.abortedReason === undefined) {
					entry.abortedReason = reason;
					abortEntry(reason);
				}
			},
		};
		entries.add(entry);
		this.byTarget.set(targetActiveSessionId, entries);
		this.counters.admitted++;
		return { ok: true, entry, queueDepth: entries.size };
	}

	/** The entry stays, but a retry is due: counted so `deliver message requeued` is observable. */
	requeue(entry: PendingDeliveryEntry): void {
		entry.lastRequeuedAt = this.now();
		this.counters.requeued++;
	}

	/**
	 * Whether this requeue may be written out, and how many lines were swallowed
	 * for this target since the last one written. The counter in `counters.requeued`
	 * stays exact either way, so throttling the log does not throttle the metric.
	 */
	noteRequeueForLog(targetActiveSessionId: string): { emit: boolean; suppressed: number } {
		const now = this.now();
		const state = this.requeueLogState.get(targetActiveSessionId) ?? { suppressed: 0 };
		this.requeueLogState.set(targetActiveSessionId, state);
		if (state.lastLoggedAt !== undefined && now - state.lastLoggedAt < this.requeueLogThrottleMs) {
			state.suppressed++;
			return { emit: false, suppressed: state.suppressed };
		}
		const suppressed = state.suppressed;
		state.suppressed = 0;
		state.lastLoggedAt = now;
		return { emit: true, suppressed };
	}

	/** The throttle window, so a suppressed count can name the window it covers. */
	get requeueLogWindowMs(): number {
		return this.requeueLogThrottleMs;
	}

	/** Live throttle rows; bounded by the number of targets with pending deliveries. */
	throttleStateSize(): number {
		return this.requeueLogState.size;
	}

	complete(entry: PendingDeliveryEntry): void {
		if (this.remove(entry)) {
			this.counters.completed++;
		}
	}

	drop(entry: PendingDeliveryEntry): void {
		if (this.remove(entry)) {
			this.counters.dropped++;
		}
	}

	/**
	 * Terminal drain: every entry is aborted with the reason, so each waiting
	 * sender gets an explicit receipt instead of a message that evaporates.
	 * Returns the entries that were drained, for the caller to log.
	 */
	drain(reason: PendingDeliveryAbortReason): PendingDeliveryEntry[] {
		const drained: PendingDeliveryEntry[] = [];
		for (const entries of this.byTarget.values()) {
			for (const entry of entries) {
				entry.abort(reason);
				drained.push(entry);
			}
		}
		this.byTarget.clear();
		this.counters.drained += drained.length;
		return drained;
	}

	private remove(entry: PendingDeliveryEntry): boolean {
		const entries = this.byTarget.get(entry.targetActiveSessionId);
		if (!entries || !entries.has(entry as InternalEntry)) {
			return false;
		}
		entries.delete(entry as InternalEntry);
		if (entries.size === 0) {
			this.byTarget.delete(entry.targetActiveSessionId);
			// A long-lived supervisor keeps no row per historical target.
			this.requeueLogState.delete(entry.targetActiveSessionId);
		}
		return true;
	}
}

/** Thrown inside the delivery loop when a drain aborted the entry. */
export class PendingDeliveryAbortedError extends Error {
	constructor(
		readonly deliveryId: string,
		readonly reason: PendingDeliveryAbortReason,
	) {
		super(`Agent message delivery ${deliveryId} was abandoned: ${reason.replace("_", " ")}`);
		this.name = "PendingDeliveryAbortedError";
	}
}
