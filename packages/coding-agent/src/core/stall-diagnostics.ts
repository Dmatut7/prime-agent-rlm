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
}
