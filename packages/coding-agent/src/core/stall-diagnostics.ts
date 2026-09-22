import type { StallExemptionDiagnostics, StallKernelDiagnostics } from "./stall-watchdog.js";

/**
 * Forensic snapshot taken when the stall watchdog fires. All timestamps are
 * epoch milliseconds; elapsed fields are derived against `Date.now()` at
 * collection time.
 */
export interface StallDiagnostics {
	/** Milliseconds without any observed session activity. */
	silentMs: number;
	busy: {
		streaming: boolean;
		compacting: boolean;
		retrying: boolean;
		bashRunning: boolean;
	};
	lastEvent: { type: string; at: number; ageMs: number } | undefined;
	inFlightToolCalls: Array<{ toolCallId: string; toolName: string; startedAt: number; elapsedMs: number }>;
	pump: { suspended: boolean; requested: boolean; epoch: number };
	/** Unfinished session actions (queued/in-flight turns, commands, dispatches). */
	unfinishedActions: number;
	/**
	 * Exemption budget segment: why silence is being excused, which tier of evidence backs it,
	 * and how much budget is left. Absent when no exemption was ever claimed this arm cycle.
	 * Additive and optional on the wire: an older client renders the fields it knows.
	 */
	exemption?: StallExemptionDiagnostics;
	/**
	 * Kernel liveness segment (protocol-4 heartbeat facts plus the reasons silence is *not*
	 * excused, e.g. `loop_stalled`). Absent when the session has no kernel. `busy.bashRunning`
	 * keeps meaning the host's own bash tool: a kernel handle is a different owner.
	 */
	kernel?: StallKernelDiagnostics;
}

/**
 * The actions a stall event offers to whoever is watching (r4 recovery-shell).
 * Optional and additive on the wire: an older emitter sends the stall events
 * without it, and every renderer degrades to its existing plain-text behavior
 * instead of showing actions that are not actually available.
 *
 * The emitter that fills this field is the daemon, once its stall-recovery sweep
 * has the session under observation; the in-process interactive host resolves
 * the same question locally from its own keybindings, so it never depends on
 * the field. Terminal stall stages (`stall_abort`/`stall_unsettled`) never
 * carry it: the turn is already dead and there is nothing left to act on.
 */
export interface StallEventActions {
	/** The current turn can still be interrupted (abort command / host interrupt key). */
	canAbort: boolean;
	/** Stall diagnostics can be shown for the current turn. */
	canDiagnose: boolean;
	/** True once an auto-recovery executor has this session under observation. */
	autoRecoveryArmed: boolean;
	/** Who performs the auto action when the wait window closes. */
	executor: "daemon" | "in-process";
	/** Epoch ms when the auto action is expected (firstSeen + wait window), when armed. */
	autoRecoveryAtMs?: number;
}
