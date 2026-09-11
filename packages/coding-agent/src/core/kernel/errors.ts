import type { KernelDeathCause } from "./death-cause.js";

/**
 * The fail-closed end of the kernel restart budget (C8).
 *
 * Revival is bounded on purpose: an unbounded lazy retry turns one broken environment into an
 * infinite respawn loop that burns a venv rebuild, a snapshot restore and a bootstrap per cell.
 * Once a session dies too often inside the window, every later cell gets this error instead of a
 * kernel - loud, terminal, and carrying the death chain so the reason is not lost with the ring
 * buffer that recorded it.
 *
 * Two paths re-arm it, and the message names both: the sliding window expiring on its own, and
 * `/reload`, which rebuilds the session (and therefore the budget) explicitly.
 */
export class KernelUnavailableError extends Error {
	/** Unexpected exits counted inside the window, including the one that exhausted it. */
	readonly restartCount: number;
	/** Restart budget that was exceeded. */
	readonly maxRestarts: number;
	/** Rolling budget window in ms. */
	readonly windowMs: number;
	/** The deaths behind the decision, oldest first. */
	readonly causes: readonly KernelDeathCause[];

	constructor(input: {
		restartCount: number;
		maxRestarts: number;
		windowMs: number;
		causes: readonly KernelDeathCause[];
	}) {
		super(formatKernelUnavailableMessage(input));
		this.name = "KernelUnavailableError";
		this.restartCount = input.restartCount;
		this.maxRestarts = input.maxRestarts;
		this.windowMs = input.windowMs;
		this.causes = [...input.causes];
	}
}

function formatCause(index: number, cause: KernelDeathCause): string {
	const at = new Date(cause.at).toISOString();
	const tail = cause.stderrTail.trim().split("\n").pop()?.trim();
	return `${index + 1}) code=${cause.code} signal=${cause.signal ?? "null"} origin=${cause.origin} at ${at}${
		tail ? ` stderr="${tail.slice(-200)}"` : ""
	}`;
}

/** The model- and log-facing text of a fail-closed kernel. Pure, so the wording is assertable. */
export function formatKernelUnavailableMessage(input: {
	restartCount: number;
	maxRestarts: number;
	windowMs: number;
	causes: readonly KernelDeathCause[];
}): string {
	const windowMinutes = Math.round(input.windowMs / 60_000);
	const budget = Number.isFinite(input.maxRestarts)
		? `${input.maxRestarts} restarts per ${windowMinutes} minutes (${input.maxRestarts}/${windowMinutes}m)`
		: "unlimited restarts";
	const chain =
		input.causes.length > 0
			? ` Death chain: ${input.causes.map((cause, index) => formatCause(index, cause)).join("; ")}.`
			: "";
	return (
		`The Python kernel died ${input.restartCount} times in the last ${windowMinutes} minutes, which exhausts the ` +
		`restart budget of ${budget}, so this session stopped starting replacement kernels instead of looping. ` +
		`Every cell will fail with this error until the budget re-arms.${chain} ` +
		"Recovery: run /reload to rebuild the session (which resets the budget), or wait for the sliding window to " +
		"expire and try again. Whatever the last snapshot held is still on disk."
	);
}
