/**
 * The verdict a session's last turn can carry - and the single source of the enum that crosses the
 * daemon wire as `agentStatus.taskState`.
 *
 * Both faces derive from this array: the `AgentTaskState` type (re-exported by
 * `core/session-manager.ts`, which owns the `AgentStatus` record the value lands in) and the
 * receive-side guard `isAgentTaskState` that `modes/daemon/daemon-client.ts` validates an incoming
 * saved-session row with. The receive side used to carry its own hand-written literal list, so a
 * verdict added to the producer's domain crossed the wire and was dropped row and all: a progress
 * frame that fails validation never reaches `onProgress`, and nothing logs (final-review seat B,
 * B3-09'). Deriving both faces makes "new value on one side only" unrepresentable, and
 * `test/daemon-client.test.ts` pins the derivation itself so it cannot be hand-written back.
 *
 * Two honest limits of that guarantee:
 *   - this array is not inside any `DAEMON_SCHEMA_ID` digest slice, so adding a value here moves no
 *     identity by itself. It is still a wire change: a client older than this build validates the
 *     new value away and silently loses the row, so a new value belongs in a protocol schema
 *     revision, and `test/daemon-client.test.ts` is what notices if one side moves alone.
 *   - the guard is total over the array, not over the wire: an unknown value still has to be
 *     refused, because a lenient receive side is how a corrupted row reaches the UI.
 */
export const AGENT_TASK_STATES = ["needs_input", "completed", "error"] as const;

export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];

/** Receive-side guard for the enum above: derived from AGENT_TASK_STATES, never a second list. */
export function isAgentTaskState(value: unknown): value is AgentTaskState {
	return typeof value === "string" && (AGENT_TASK_STATES as readonly string[]).includes(value);
}
