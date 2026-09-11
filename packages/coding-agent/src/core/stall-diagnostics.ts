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
