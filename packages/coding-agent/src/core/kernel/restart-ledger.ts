/**
 * The kernel revival budget's ledger (C8), scoped to a *session* rather than to one kernel manager.
 *
 * The budget exists so one broken environment cannot become an infinite respawn loop. Keeping its
 * books inside `ReplKernelManager` quietly defeated it for the most common broken shape - a kernel
 * that dies before it is ready:
 *
 *  1. the death lands during startup, so the manager arms a revival and tears the child down;
 *  2. the start that was awaiting `ready` then fails, and the provisioner's failure path calls
 *     `shutdown()` on that manager, which is a host verdict: `isDefunct` becomes true;
 *  3. the next cell sees a defunct client and provisions a *replacement manager*;
 *  4. a ledger that lived in the replaced instance counted exactly one death, forever.
 *
 * Every cell then answered "Kernel exited before ready" and spawned one more doomed kernel: no
 * fail-closed `KernelUnavailableError`, no death chain, no reset notice, and no "restarts came too
 * dense" warning (which needs a gap between two deaths). The ledger therefore outlives the manager
 * that fills it: the owner that replaces managers (the provisioner) holds one and hands it to each
 * of them, so a death counted by a discarded instance is still counted.
 *
 * The pending reset notice rides along for the same reason. It is written by the instance that saw
 * the death and read by whichever instance serves the next cell that reaches the model - and after
 * a startup-phase death those are not the same object.
 */

import type { KernelDeathCause } from "./death-cause.js";
import type { KernelResetNoticeFacts } from "./reset-notice.js";
import type { KernelRestartPolicy } from "./shared.js";

/** A kernel revival that has not been reported to the model yet. */
export interface PendingRestartNotice
	extends Omit<KernelResetNoticeFacts, "restore" | "restoreTimedOut" | "repeatedCell"> {
	/** Source of the cell that was running when the kernel died, for the repeat check. */
	repeatedCellCode?: string;
}

/** What one recorded death did to the budget. */
export interface KernelRestartLedgerEntry {
	/** Deaths inside the window after this one, i.e. this death's 1-based index. */
	restartCount: number;
	/** The death before this one inside the window; absent for the window's first. */
	previous?: KernelDeathCause;
}

export class KernelRestartLedger {
	private readonly deaths: KernelDeathCause[] = [];
	private notice?: PendingRestartNotice;

	/**
	 * Count one unexpected death against the budget. Prunes against the window first, so a crash a
	 * session survived hours ago cannot fail it closed today (L3).
	 */
	record(cause: KernelDeathCause, policy: KernelRestartPolicy): KernelRestartLedgerEntry {
		this.prune(policy, cause.at);
		const previous = this.deaths[this.deaths.length - 1];
		this.deaths.push(cause);
		return { restartCount: this.deaths.length, ...(previous === undefined ? {} : { previous }) };
	}

	/** Drop the deaths that fell out of the sliding window. */
	prune(policy: KernelRestartPolicy, at: number): void {
		const windowStart = at - policy.windowMs;
		while (this.deaths.length > 0 && (this.deaths[0]?.at ?? 0) < windowStart) {
			this.deaths.shift();
		}
	}

	/** Deaths inside the window, oldest first, pruned against `now`. */
	exitsInWindow(policy: KernelRestartPolicy, now: number): readonly KernelDeathCause[] {
		this.prune(policy, now);
		return this.deaths;
	}

	/** Whether the budget is spent right now. Live, because the window slides (L3). */
	exhausted(policy: KernelRestartPolicy, now: number): boolean {
		this.prune(policy, now);
		return this.deaths.length > policy.maxRestarts;
	}

	/** Deaths recorded, unpruned: "has this session ever died" for the re-arm check. */
	get count(): number {
		return this.deaths.length;
	}

	/** Arm the notice the next model-reaching cell owes. Overwrites an unconsumed one. */
	setPendingRestartNotice(notice: PendingRestartNotice): void {
		this.notice = notice;
	}

	/** The pending notice, or undefined when nothing is owed. Does not consume it. */
	pendingRestartNotice(): PendingRestartNotice | undefined {
		return this.notice;
	}

	/**
	 * Hand over the pending notice. Consuming it is the caller's commitment that the result reaches
	 * the model: an error path must not consume it (I-16).
	 */
	takePendingRestartNotice(): PendingRestartNotice | undefined {
		const notice = this.notice;
		this.notice = undefined;
		return notice;
	}
}
