import { AUTO_CONTINUE_CUSTOM_TYPE, EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE } from "../../core/messages.js";
import { PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE } from "../../core/self-recovery.js";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../../core/session-manager.js";

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
 *
 * Two guards keep the resume from becoming the incident (wave-40): the verdict
 * stops auto-resuming once the transcript shows
 * WORKER_RECOVERY_MAX_CONSECUTIVE_AUTO_RESUMES back-to-back crash-resume cycles
 * (a resume whose turn crashes again would otherwise loop unattended, burning a
 * turn per cycle), and it skips interruptions older than
 * WORKER_RECOVERY_AUTO_RESUME_MAX_AGE_MS. And a marker that carries the queued
 * inputs the dead worker never delivered (details.queuedInputs) has them
 * replayed ahead of the resume prompt, so the user's queued work is not lost
 * with the crash.
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

/**
 * Consecutive auto-resume cycles one session may go through on its own (中断-6
 * follow-up, wave-40): a resume whose turn crashes the worker again leaves a
 * fresh marker, which used to queue another resume - an unattended
 * crash->resume->crash loop burning a full turn per cycle. The count is derived
 * from the transcript (marker + resume-prompt pairs since the last real user
 * message), not trusted from the marker: the transcript is the one store both
 * the marker writer and the resumer share.
 */
export const WORKER_RECOVERY_MAX_CONSECUTIVE_AUTO_RESUMES = 2;
/**
 * An interruption this old is news, not work: nobody auto-resumes a day-old
 * crash into a session whose context has moved on. The marker stays for the
 * resume briefing either way.
 */
export const WORKER_RECOVERY_AUTO_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The token every automatic resume prompt carries; matched against user messages, not equality. */
const WORKER_RECOVERY_RESUME_TOKEN = "<prime_agent_worker_resumed>";

export type WorkerRecoveryResumeVerdict =
	| { kind: "resume"; marker: CustomMessageEntry; queuedInputs: string[] }
	| { kind: "skip"; reason: "no-marker" | "resume-loop" | "stale" };

/** Queued-but-never-delivered input texts the crash marker carries (defensively parsed). */
export function queuedInputsOfWorkerRecoveryMarker(marker: CustomMessageEntry | undefined): string[] {
	const details = marker?.details;
	if (!details || typeof details !== "object") return [];
	const queued = (details as Record<string, unknown>).queuedInputs;
	if (!Array.isArray(queued)) return [];
	return queued.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function userMessageText(message: SessionMessageEntry["message"]): string {
	// Only user messages reach this (the caller filters by role); read the
	// content defensively anyway since transcript shapes predate the types.
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Auto-resume cycles since the last real user input, walking back from `beforeIndex`.
 * A replayed queued input (a user message whose text a marker recorded) is the
 * resume's own cargo, not attendance: it neither counts as a cycle nor breaks the
 * chain. Assistant messages ride between cycles without breaking it either.
 */
function countConsecutiveAutoResumes(branch: readonly SessionEntry[], beforeIndex: number): number {
	const replayedTexts = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "custom_message" && entry.customType === WORKER_RECOVERY_MARKER_CUSTOM_TYPE) {
			for (const text of queuedInputsOfWorkerRecoveryMarker(entry)) replayedTexts.add(text);
		}
	}
	let count = 0;
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = userMessageText(entry.message);
		if (text.includes(WORKER_RECOVERY_RESUME_TOKEN)) {
			count++;
			continue;
		}
		if (replayedTexts.has(text)) continue;
		break;
	}
	return count;
}

/**
 * Whether a freshly bound session owes its interruption marker an automatic
 * resume, and with what cargo. A marker that is still the transcript tail
 * resumes - unless the transcript shows the loop-guard count already spent
 * (crash->resume->crash), or the interruption is too old to be anyone's current
 * work. The marker is left unconsumed either way: the resume briefing still
 * reports it, and a real user message answers it.
 */
export function workerRecoveryResumeVerdict(
	branch: readonly SessionEntry[],
	now: number = Date.now(),
): WorkerRecoveryResumeVerdict {
	const marker = findUnconsumedWorkerRecoveryMarker(branch);
	if (marker === undefined) return { kind: "skip", reason: "no-marker" };
	const markerIndex = branch.indexOf(marker);
	const markerAt = Date.parse(marker.timestamp);
	if (Number.isFinite(markerAt) && now - markerAt > WORKER_RECOVERY_AUTO_RESUME_MAX_AGE_MS) {
		return { kind: "skip", reason: "stale" };
	}
	if (countConsecutiveAutoResumes(branch, markerIndex) >= WORKER_RECOVERY_MAX_CONSECUTIVE_AUTO_RESUMES) {
		return { kind: "skip", reason: "resume-loop" };
	}
	return { kind: "resume", marker, queuedInputs: queuedInputsOfWorkerRecoveryMarker(marker) };
}
