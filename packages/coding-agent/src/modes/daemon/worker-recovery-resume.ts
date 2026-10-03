import { AUTO_CONTINUE_CUSTOM_TYPE, EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE } from "../../core/messages.js";
import { PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE } from "../../core/self-recovery.js";
import type { CustomMessageEntry, SessionEntry } from "../../core/session-manager.js";

/**
 * 中断-6: when a session worker dies with in-flight work, the supervisor reads
 * the dead worker's recovery journal (busy records) and appends a
 * prime-agent.worker_recovery custom message to the session transcript via the
 * catalog (daemon-catalog-process.ts "mark_interrupted"). Nothing consumed that
 * marker: the session reopened clean and the interrupted turn was simply never
 * resumed. On bind, a marker that is still the transcript tail (no message
 * answered it since) queues one resume prompt - the durable resume marker
 * pattern the quota park established (core/quota-park.ts QUOTA_RESUME_MARKER_TEXT).
 * The queued prompt lands as a user message, which consumes the marker, so the
 * resume fires once per worker death. A continuation whose prompt landed as a
 * custom message (self-recovery continues, the failure-recovery turns) consumes
 * it too: the session already moved past the interruption.
 */

// Written by the supervisor's catalog (daemon-catalog-process.ts). The source
// pin in test/daemon-worker-recovery-resume.test.ts fails if either side moves.
export const WORKER_RECOVERY_MARKER_CUSTOM_TYPE = "prime-agent.worker_recovery";

/**
 * Self-contained resume prompt: the transcript's worker-interruption marker is
 * display-only, so the model is told the whole situation here rather than
 * relying on that marker reaching its context.
 */
export const WORKER_RECOVERY_RESUME_PROMPT =
	"<prime_agent_worker_resumed>\n" +
	"The session worker that was running this session stopped during in-flight work; a fresh worker re-opened the session and this resume is automatic. " +
	"The saved transcript was recovered, but the interrupted turn was not replayed: uncertain model, tool, bash, or child-agent work may be half-done. " +
	"Inspect external side effects before redoing them, then continue the interrupted task from where it stopped.\n" +
	"</prime_agent_worker_resumed>";

/**
 * Custom-message types that ARE a continuation prompt the session drove a turn
 * with: the self-recovery continues (auto_continue covers the announced-next-step,
 * finish-gate, output-truncation and child-reply nudges) and the one-shot
 * failure-recovery turns. They land as custom messages - the recovery turns through
 * the prepared action's message override, the continues at message_end - so a
 * transcript that continued past the interruption can tail one without any
 * intervening message entry. Finding one newer than the marker means the
 * interruption was already answered; queueing the recovery resume then would
 * double-continue the same work. Notice-type custom messages (ipython_state,
 * session_context_loss, finish_gate_released, the bind-time writes) never
 * consume: they record state and no turn answered them.
 */
const CONTINUATION_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	AUTO_CONTINUE_CUSTOM_TYPE,
	EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE,
	PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE,
]);

/**
 * The newest worker-interruption marker still waiting for an answer: scanning
 * from the tail, any message entry means a turn (user or assistant) already
 * continued past the interruption, so nothing is owed, and a continuation custom
 * message (CONTINUATION_CUSTOM_TYPES) says the same for turns whose prompt landed
 * as a custom message. Non-message entries appended after the marker
 * (session_state on bind, labels, model changes, notices) do not consume it.
 */
export function findUnconsumedWorkerRecoveryMarker(branch: readonly SessionEntry[]): CustomMessageEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "custom_message" && entry.customType === WORKER_RECOVERY_MARKER_CUSTOM_TYPE) {
			return entry;
		}
		if (
			entry.type === "message" ||
			(entry.type === "custom_message" && CONTINUATION_CUSTOM_TYPES.has(entry.customType))
		) {
			return undefined;
		}
	}
	return undefined;
}
