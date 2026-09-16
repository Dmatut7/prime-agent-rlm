/**
 * The model-facing reset notice for a kernel that died and was revived (T2-2 / M10).
 *
 * Automatic revival removes a natural brake. Before it, a dead kernel answered every cell with
 * "Kernel has been shut down", so the model knew the environment was gone and did not re-run
 * anything. After it, the next cell simply works - on a namespace rolled back to the last
 * snapshot, in a process that did not do the side effects the model is about to repeat. So the
 * notice states three facts, and the third one is the reason this module exists:
 *
 *  1. which point in time the namespace was rolled back to, and what failed to come back or was
 *     never saved;
 *  2. that everything defined after that point is gone and must be recreated;
 *  3. that side effects are *not* rolled back - file writes, commits, sent messages, and spawned
 *     subagents all still exist, and the model's natural reaction to a lost kernel (re-run the
 *     last cell) would repeat them.
 *
 * It travels in the tool result head, never through a deferred next-turn message: the sweeper that
 * empties the next-turn queue can drop a message, and this one has to reach the model attached to
 * the first cell it runs after the revival (I-16).
 */

import type { KernelDeathCause, KernelHostRequestFact } from "./death-cause.js";
import type { RestoreResult } from "./state-snapshot.js";

/** Tag the notice is wrapped in; asserted by tests and recognisable to a model that saw it before. */
export const KERNEL_RESET_NOTICE_TAG = "<ipython_kernel_reset>";

export interface KernelResetNoticeFacts {
	cause: KernelDeathCause;
	/** 1-based index of this revival. */
	restartCount: number;
	/** Restarts allowed inside the window; undefined until the budget is enforced (T2-3). */
	maxRestarts?: number;
	windowMinutes?: number;
	/** Whether this session persists its namespace at all. */
	snapshotConfigured: boolean;
	/** The revival's restore result, when a restore ran. */
	restore?: RestoreResult | null;
	/** The restore timed out instead of failing: the payload is intact but still owed (B5). */
	restoreTimedOut?: boolean;
	/** A first attempt timed out and the longer retry window was used. */
	restoreRetriedAfterTimeout?: boolean;
	hostRequests: readonly KernelHostRequestFact[];
	/** The first cell after the revival repeats the cell that was running when the kernel died. */
	repeatedCell?: boolean;
	/**
	 * How long before the death the payload that is being restored was written, measured when the
	 * death was recorded. Absent when the host cannot tell (no snapshot target, nothing on disk).
	 *
	 * This replaced a fixed "about 1.5s" that only ever held when the last cell succeeded: the
	 * snapshot debounce is an upper bound on how long after a cell the write starts, not a bound
	 * on the age of the payload, and the model reasons from this number about what it still has.
	 */
	snapshotWrittenBeforeDeathMs?: number;
}

/** Seconds with enough precision to matter, and no false precision beyond that. */
function formatAgeSeconds(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1);
}

/**
 * Where the restored namespace came from in time. Both branches end with the one bound that is
 * always true: only the cells that ended before that write are in the payload.
 */
function snapshotAgeClause(facts: KernelResetNoticeFacts): string {
	const clause = "anything a cell changed after that write is not in it";
	const age = facts.snapshotWrittenBeforeDeathMs;
	if (age === undefined) return `this host cannot tell when that write happened, so ${clause}`;
	return `written about ${formatAgeSeconds(age)}s before the death, so ${clause}`;
}

function formatCause(cause: KernelDeathCause): string {
	return `code=${cause.code}, signal=${cause.signal ?? "null"}, origin=${cause.origin}`;
}

function rollbackLine(facts: KernelResetNoticeFacts): string {
	if (!facts.snapshotConfigured) {
		return "1. This session does not persist its Python namespace, so the replacement kernel started empty.";
	}
	if (facts.restoreTimedOut) {
		return (
			"1. State was not rolled back to a snapshot: reading the saved snapshot timed out, so the payload was " +
			"kept untouched and will be retried on the next kernel start. The namespace is older than your last " +
			"cell - assume nothing in it survived."
		);
	}
	const restore = facts.restore;
	if (!restore) {
		return (
			`1. State was rolled back to the most recent snapshot (${snapshotAgeClause(facts)}); ` +
			"the saved namespace could not be revived, so treat this kernel as empty."
		);
	}
	const retried = facts.restoreRetriedAfterTimeout
		? " The first restore attempt timed out and a retry with a longer window succeeded, so this snapshot is expensive to read cold."
		: "";
	const failed = restore.failed.map((failure) => failure.name);
	const revived =
		restore.restored.length > 0
			? `These names came back: ${restore.restored.join(", ")}.`
			: "No saved name could be revived.";
	const missing = failed.length > 0 ? ` These could not be restored and must be rebuilt: ${failed.join(", ")}.` : "";
	// The reduced-semantics tier: revived, callable, but reading values frozen at save
	// time. Naming them here keeps the restart notice consistent with the resume notice.
	const degraded =
		restore.degraded && restore.degraded.length > 0
			? ` These came back with reduced semantics (frozen save-time values, not the live namespace) and can silently misbehave: ${restore.degraded.map((entry) => entry.name).join(", ")}.`
			: "";
	// A name the snapshot never saved cannot fail to restore, so it would otherwise be absent from
	// both this line and "must be rebuilt" - the exact silence this notice exists to break.
	const notSaved =
		restore.notSaved && restore.notSaved.length > 0
			? ` These were live when that snapshot was written but were never saved into it, so they are gone and must be rebuilt: ${restore.notSaved.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}.`
			: "";
	return `1. State was rolled back to the most recent snapshot (${snapshotAgeClause(facts)}). ${revived}${missing}${notSaved}${degraded}${retried}`;
}

function hostRequestLines(requests: readonly KernelHostRequestFact[]): string[] {
	if (requests.length === 0) return [];
	const described = requests.map((request) => {
		const target = request.label ? ` (${request.label})` : "";
		const risk = request.mayHaveTakenEffect
			? "may already have taken effect - verify before repeating it"
			: "read-only, so repeating it is safe";
		return `${request.type}${target} - ${risk}`;
	});
	return [
		`${requests.length} host request${requests.length === 1 ? "" : "s"} still in flight when the kernel died, ` +
			`so ${requests.length === 1 ? "its reply was" : "their replies were"} dropped: ${described.join("; ")}.`,
	];
}

/** Render the notice. Pure, so the wording is assertable without spawning a kernel. */
export function formatKernelResetNotice(facts: KernelResetNoticeFacts): string {
	const budget =
		facts.maxRestarts === undefined || facts.windowMinutes === undefined
			? `Restart ${facts.restartCount}.`
			: `Restart ${facts.restartCount} of at most ${facts.maxRestarts} allowed in ${facts.windowMinutes} minutes.`;
	const lines = [
		KERNEL_RESET_NOTICE_TAG,
		`The Python kernel process died unexpectedly (${formatCause(facts.cause)}) and a replacement kernel ran this cell. ${budget}`,
		rollbackLine(facts),
		"2. Everything defined after that snapshot point is gone: variables, imports, loaded data, async tasks, " +
			"open files and sockets, and bash() handles. Recreate what you need before using it.",
		"3. Side effects were not rolled back. File writes, git commits, messages already sent, and subagents " +
			"already spawned after the snapshot point all still exist. Before re-running a cell that had side " +
			"effects, check what the earlier run already did; before spawning work again, call " +
			"`await rlm.list_subagents()` and only spawn what is genuinely missing.",
		...hostRequestLines(facts.hostRequests),
	];
	if (facts.repeatedCell) {
		lines.push(
			"This cell's source is identical to the cell that was running when the kernel died, so any side effect " +
				"in it may have happened twice.",
		);
	}
	lines.push("</ipython_kernel_reset>");
	return lines.join("\n");
}
