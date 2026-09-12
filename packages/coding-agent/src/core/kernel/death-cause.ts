/**
 * Kernel death attribution (B6/I-1).
 *
 * The exit callback is the only place that knows a kernel process ended, and three of the four
 * ways it can end are the host's own doing: a graceful `shutdown()`, a `kill()`, a synchronous
 * `disposeSync()`, and - the one that is easy to miss - the protocol-repair family
 * (`killChildToIdle`), which discards a corrupt kernel and re-bootstraps a replacement. Counting
 * a repair kill as a crash would burn the restart budget of a session that is actually healing
 * itself, and would write a death cause that blames the wrong thing on the first day a new
 * forensic surface exists.
 *
 * So the origin is an explicit marker set *before* the kill, not a state inferred afterwards.
 * `state` cannot be used: `killChildToIdle` sets `"shutdown"` and then back to `"idle"` before it
 * returns, so by the time the exit event is delivered the transient value is gone. The graceful
 * generation comparison is kept as an auxiliary term only, and it is only sound for a path that
 * has not run `cleanupResources` yet (that call bumps `startGeneration`).
 */

/** Every path that ends the kernel on purpose, tagged immediately before the kill. */
export type KernelIntentionalExitOrigin =
	| "shutdown"
	| "kill"
	| "dispose_sync"
	| "repair_kill"
	| "bootstrap_fail_kill"
	| "abort_timeout_kill";

/**
 * Attribution vocabulary for one kernel exit.
 *
 * `repair_kill`, `bootstrap_fail_kill` and `abort_timeout_kill` only ever appear on an
 * *intentional* verdict: a death cause handed to `onUnexpectedExit` is by definition not one the
 * host ordered, so it carries `oom_suspect` or `unknown`. They are in the same enum because the
 * diagnostic line names the origin either way, and a host-ordered kill that ever showed up as
 * unexpected would be a predicate leak worth reading in the log.
 */
export type KernelDeathOrigin = KernelIntentionalExitOrigin | "oom_suspect" | "unknown";

/** Why an unexpected kernel exit is not attributed to OOM without evidence. */
const OOM_EVIDENCE_PATTERN =
	/memoryerror|out of memory|cannot allocate memory|oom[-_ ]?kill|killed process|std::bad_alloc|not enough memory/i;

export interface KernelDeathCause {
	/** Process exit code, or null when a signal ended it. */
	code: number | null;
	/** Terminating signal, or null when the process exited on its own. */
	signal: NodeJS.Signals | null;
	/** Epoch ms of the host's exit callback. */
	at: number;
	/** This spawn's stderr window tail at the moment of the exit (may be empty). */
	stderrTail: string;
	origin: KernelDeathOrigin;
}

/** What the exit callback decided: an unowned death, or one of the intentional paths. */
export type KernelExitVerdict =
	| { unexpected: true; cause: KernelDeathCause }
	| { unexpected: false; origin: KernelDeathOrigin | "graceful_shutdown" | "teardown_state" };

export interface KernelExitFacts {
	/** Marker set before an intentional kill; undefined when nobody claimed this exit. */
	intentionalOrigin: KernelIntentionalExitOrigin | undefined;
	/** A graceful `shutdown()` owns this generation and runs the teardown itself. */
	gracefulShutdownOwned: boolean;
	/** Manager state at the moment of the callback. Auxiliary only - see the module comment. */
	state: "idle" | "starting" | "running" | "shutdown";
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
	at: number;
}

/**
 * Classify one kernel exit. Pure, so both timings of the same kill can be pinned without
 * reaching into the manager: with the child reference already cleared the callback never runs at
 * all, and with it still set the marker below is what keeps the verdict intentional.
 *
 * `oom_suspect` needs both an unowned SIGKILL and a memory-shaped trace in the kernel's own
 * stderr. Anything less provable stays `unknown` - a guessed cause is worse than an admitted one,
 * and the share of `unknown` is itself the signature that says attribution needs more evidence.
 */
export function classifyKernelExit(facts: KernelExitFacts): KernelExitVerdict {
	if (facts.intentionalOrigin !== undefined) {
		return { unexpected: false, origin: facts.intentionalOrigin };
	}
	if (facts.gracefulShutdownOwned) {
		return { unexpected: false, origin: "graceful_shutdown" };
	}
	if (facts.state === "shutdown") {
		// A teardown owns this exit even when its marker was already consumed (a second cleanup
		// pass, or a crash that landed inside a shutdown window): never a revival candidate.
		return { unexpected: false, origin: "teardown_state" };
	}
	const oomSuspect = facts.signal === "SIGKILL" && OOM_EVIDENCE_PATTERN.test(facts.stderrTail);
	return {
		unexpected: true,
		cause: {
			code: facts.code,
			signal: facts.signal,
			at: facts.at,
			stderrTail: facts.stderrTail,
			origin: oomSuspect ? "oom_suspect" : "unknown",
		},
	};
}

/** One host request that was still in flight when the kernel died. */
export interface KernelHostRequestFact {
	/** Request type as the kernel sent it (e.g. `rlm.run`). */
	type: string;
	/** Target read off the payload when the type carries one (a child name, a receiver). */
	label?: string;
	/**
	 * True when the work may already have happened, so repeating the request is not safe. The
	 * answer is deliberately conservative: a reply that never arrived is not evidence that
	 * nothing was done.
	 */
	mayHaveTakenEffect: boolean;
}

/** What the host did about one unexpected exit. */
export interface KernelRestartDecision {
	/** True when the manager settled at idle to be revived by the next cell. */
	revive: boolean;
	/** Unexpected exits inside the budget window, this one included. */
	restartCount: number;
	/** Rolling budget window the count is measured over. */
	windowMs: number;
	/** Restarts still allowed inside the window; 0 once the budget is exhausted. */
	budgetRemaining: number;
	/** True when this death exhausted the budget and the session failed closed. */
	exhausted: boolean;
	/** Gap to the previous unexpected exit inside the window; absent for the first one. */
	sincePreviousMs?: number;
}

/** Everything the owner needs to log one death: the cause, the decision, and the loose ends. */
export interface KernelUnexpectedExitFacts {
	decision: KernelRestartDecision;
	unresolvedHostRequests: KernelHostRequestFact[];
}
