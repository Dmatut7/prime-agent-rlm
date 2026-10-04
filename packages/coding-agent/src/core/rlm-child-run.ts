/**
 * RLM child-run cluster extracted from agent-session.ts: the run lifecycle record,
 * the streaming preview/label/derive-counter helpers it leans on, the child snapshot
 * builders the roster and collect paths share, and the spawn path itself. The moved
 * methods keep exactly the same bodies; they read the session through
 * {@link RlmChildRunHost} / {@link RlmChildSnapshotHost}, which `AgentSession`
 * satisfies structurally, so the move changes no runtime behavior.
 */
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	getLogger,
	getSupportedThinkingLevels,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	assertDirectAgentMessageTarget,
	formatAgentSessionNameReserved,
	isAgentSessionMessage,
	type QueuedParentReplyBackfills,
} from "./agent-messages.js";
import type {
	AgentSession,
	AgentSessionEvent,
	RetainedRlmChild,
	RlmChildAgentActivity,
	RlmChildAgentSnapshot,
	RlmChildAgentStatus,
	RlmChildStallState,
	RlmSubagentModelSelection,
} from "./agent-session.js";
import { type CustomMessage, createRlmChildFailureMessage, createRlmChildTerminalNoticeMessage } from "./messages.js";
import type { ClosedRlmChildCollectEntry } from "./rlm-child-collect.js";
import { notifyRlmChildStall, type RlmChildStallNoticeHost } from "./rlm-child-stall-notice.js";
import type { RlmChildStallAbortFacts, RlmChildTerminalOutcomeKind } from "./rlm-child-terminal.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	rlmCollectStallAbort,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import type { SemanticEdgeRecorder } from "./semantic-edges.js";
import type { SessionManager, SessionMessageEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { StallDiagnostics } from "./stall-diagnostics.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";

// Same logger name as agent-session.ts: the spawn path moved here verbatim and its
// log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

export interface AgentMessageDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

export function createAgentMessageDeferred(): AgentMessageDeferred {
	const deferred = {} as AgentMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

export interface RlmChildRun {
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	/**
	 * The parent's own assistant entry the child's usage is attributed to, resolved on first use.
	 * The lookup scans the whole transcript, so resolving it per child assistant message costs a
	 * copy-and-scan of every entry written so far; the answer cannot change while the run is live.
	 */
	parentUsageEntry?: SessionMessageEntry;
	model: Model<Api>;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount: number;
	activity?: RlmChildAgentActivity;
	/**
	 * Bounded ring of the child's latest progress notes (newest last). Optional:
	 * admission seeds it, but a lifecycle record built by hand (a test's minimal
	 * run literal, a restored registry row) carries no ring, and every reader
	 * treats "no ring" as "no note" rather than throwing.
	 */
	progressNotes?: string[];
	/**
	 * Wall-clock ms of the last tracked child activity; carried into snapshots.
	 * Seeded at admission so a child that never emits a tracked event still
	 * crosses the staleness threshold once running.
	 */
	lastActivityAt?: number;
	/**
	 * Monotonic counterpart of lastActivityAt (performance.now()), written by
	 * the same events. Staleness measures this so wall-clock jumps (a host
	 * sleep freezing the whole session) do not inflate it.
	 */
	lastActivityMonotonicAt?: number;
	error?: string;
	/**
	 * Stall-watchdog kill facts recorded while this run was in flight. Set by the
	 * parent's subscription when the child reports stall_abort/stall_unsettled and
	 * consumed by the terminal classifier, which must rank a kill above "it
	 * replied" instead of reporting the kill as a completed-without-reply.
	 */
	stallAbort?: RlmChildStallAbortFacts;
	/** Display/forensic stall state for the roster row; cleared by the next agent_start. */
	stall?: RlmChildStallState;
	/**
	 * Epoch ms of the last parent-facing "this child is still silent" notice. A rate
	 * limit only - the watchdog's warn stage is edge-triggered per silence episode -
	 * so a child that keeps re-arming the stage cannot flood the parent transcript.
	 */
	lastStallNoticeAt?: number;
	/**
	 * Re-check armed after an excused stall warning was held back from the parent. The child's
	 * watchdog warns once per silence episode, so if the excuse lapses while the child stays silent
	 * nothing else would ever tell the parent.
	 */
	stallRecheckTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Terminal classification recorded by the run's own terminal path, with the
	 * reason text that went with it. Read-only forensics for `collectRlmChildren`:
	 * a fan-in reader has to tell a watchdog kill from a child that finished
	 * without replying, and it cannot re-derive the classification later because
	 * the reply baseline lived in the run loop's closure. Undefined while the run
	 * is in flight, and for a child whose notice path never ran (suppressed after a
	 * parent abort, or explicitly deleted).
	 */
	terminalKind?: RlmChildTerminalOutcomeKind;
	terminalReason?: string;
	/**
	 * Replies this session still owed this child when the terminal verdict was
	 * recorded, i.e. replies the parent had accepted into its queue but not read.
	 * A `completed_without_reply` notice is provisional on them: the verdict is a
	 * snapshot taken when the child settled, while the notice is published when this
	 * session's queue drains - in production a median of 19 minutes later.
	 */
	provisionalNoReplyReplyIds?: readonly string[];
	/**
	 * The provisional reply that was delivered after the verdict. Set by the delivery
	 * credit, read by the publication gate, and never set for an id a later run
	 * boundary discarded, so an earlier run's notice cannot be suppressed by a reply
	 * that run never earned.
	 */
	noReplyVerdictSupersededBy?: string;
	/**
	 * Set when the publication gate actually withheld this run's no-reply notice, so a
	 * reader that sees `terminal_kind: "completed_without_reply"` but no notice in the
	 * parent's transcript can reconcile the two instead of guessing.
	 */
	noReplyNoticeSuperseded?: boolean;
	/**
	 * The child's own terminal-error report, still queued when this run's failure
	 * verdict was taken. Per run on purpose: a child session outlives the run that
	 * failed, so a session-wide flag would swallow the NEXT run's death report - the
	 * one case where the synthesized notice is the only record.
	 */
	provisionalFailureNoticeReplyId?: string;
	/** That report was delivered after the verdict, so the synthesized one is a duplicate. */
	failureVerdictSupersededBy?: string;
	abort: () => void;
	publication: AgentMessageDeferred;
	/** Resolves after terminal result publication and detached-run cleanup finish. */
	settlement: AgentMessageDeferred;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	settled: boolean;
	/** Do not inject a late terminal notice after the parent session is aborted. */
	suppressTerminalNotice?: boolean;
	/** Excluded from future strong barriers after an authoritative cancellation cut. */
	abandonedForQuiescence?: boolean;
	/** Selector snapshot for an admitted explicit delete. */
	detachedDeletion?: RlmSubagentRegistryEntry;
	/** Shared physical runtime cleanup owned by the explicit-delete path. */
	deletionCleanup?: Promise<void>;
	deletionCleanupObserver?: Promise<boolean>;
	/** Resolves when a deletion may release its selector reservation. */
	deletionReservation: AgentMessageDeferred;
	deletionCleanupFailed?: boolean;
	deletionRunFinished?: boolean;
	deletionNotice?: Promise<void>;
	deletionFailureNotice?: Promise<void>;
	deletionNeedsCompletionNotice?: boolean;
	completeDeletion?: () => Promise<void>;
	reportDeletionCleanupFailure?: (error: unknown) => Promise<void>;
	emitUpdate?: () => void;
	lastEmittedUpdate?: string;
	/**
	 * Cached rlmChildLabel(prompt): the prompt is a run-level constant, and the
	 * snapshot builder used to re-regex the whole brief on every streaming chunk.
	 */
	label?: string;
	/**
	 * Incremental preview accumulator for the child's in-flight assistant message.
	 * Keeps the per-chunk preview work O(delta) instead of O(text so far).
	 */
	streamPreview?: RlmChildStreamPreview;
	/**
	 * Volatile snapshot fields as last emitted, for the cheap unchanged check that
	 * keeps streaming chunks off the snapshot build and JSON.stringify.
	 */
	lastEmittedFields?: RlmChildEmitFields;
	unsubscribe?: () => void;
}

/**
 * The fields of {@link RlmChildAgentSnapshot} that can change while a run is live.
 * Equal fields (with reference equality for the model and stall objects) imply an
 * identical serialization, so an update whose fields all match the last emission
 * cannot carry anything new on the wire.
 */
export interface RlmChildEmitFields {
	model: Model<Api> | undefined;
	sessionName: string | undefined;
	status: RlmChildAgentStatus;
	durationMs: number | undefined;
	answerPreview: string | undefined;
	toolUseCount: number | undefined;
	tokenCount: number | undefined;
	recap: string | undefined;
	activityKind: RlmChildAgentActivity["kind"] | undefined;
	activityToolName: string | undefined;
	repliedSinceTask: boolean | undefined;
	error: string | undefined;
	stall: RlmChildStallState | undefined;
}

/**
 * Reference/strict equality over {@link RlmChildEmitFields}: every field is either a
 * primitive, an immutable model record, or an object that is replaced (never mutated
 * in place) when it changes. Equal fields serialize identically, so an update whose
 * fields all match the last emission cannot carry anything new on the wire.
 */
function rlmChildEmitFieldsEqual(fields: RlmChildEmitFields, last: RlmChildEmitFields | undefined): boolean {
	if (last === undefined) return false;
	return (
		fields.model === last.model &&
		fields.sessionName === last.sessionName &&
		fields.status === last.status &&
		fields.durationMs === last.durationMs &&
		fields.answerPreview === last.answerPreview &&
		fields.toolUseCount === last.toolUseCount &&
		fields.tokenCount === last.tokenCount &&
		fields.recap === last.recap &&
		fields.activityKind === last.activityKind &&
		fields.activityToolName === last.activityToolName &&
		fields.repliedSinceTask === last.repliedSinceTask &&
		fields.error === last.error &&
		fields.stall === last.stall
	);
}

/** Bounded ring of progress notes kept per child run; the snapshot exposes the newest. */
const RLM_CHILD_PROGRESS_NOTE_RING_MAX = 5;

export function noopRlmChildAbort(): void {}

export function noopRlmChildEventUnsubscribe(): void {}

/**
 * Derivation counters for the RLM child streaming-scaling needle: the invariant
 * "a streaming chunk pays O(delta), never a re-derive over the full text" is
 * asserted by counting the derivations one run pays instead of timing them, so
 * a loaded CI runner cannot flake the bound. Module-global on purpose: the
 * derivations are module-level functions, so every call site counts - the
 * streaming handler, the snapshot builder, or a regressed re-introduction of
 * the pre-fix per-chunk re-derive. Production never reads or resets these;
 * tests reset before a run and read after (StallFakeClock-style test seam).
 */
export interface RlmChildDeriveCounts {
	/** Full-text preview derivations: compactRlmText calls plus the streaming accumulator's structural full-text fallback. */
	fullTextPreview: number;
	/** Label derivations: rlmChildLabel calls over a run's task brief. */
	label: number;
	/** Snapshot builds that reached the serializer in the child-update emitter. */
	snapshotSerialize: number;
	/** Characters the streaming fold actually processed: the consumed-length tracking keeps the run total O(text), never text-per-chunk. */
	foldedChars: number;
}

export const rlmChildDeriveCounts: RlmChildDeriveCounts = {
	fullTextPreview: 0,
	label: 0,
	snapshotSerialize: 0,
	foldedChars: 0,
};

/** Reset {@link rlmChildDeriveCounts}. Test seam: production never resets it. */
export function resetRlmChildDeriveCounts(): void {
	rlmChildDeriveCounts.fullTextPreview = 0;
	rlmChildDeriveCounts.label = 0;
	rlmChildDeriveCounts.snapshotSerialize = 0;
	rlmChildDeriveCounts.foldedChars = 0;
}

export function compactRlmText(text: string, maxLength = 160): string {
	rlmChildDeriveCounts.fullTextPreview += 1;
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

// Child-agent label: collapse to one line but keep the full prompt — the TUI
// truncates to the visible width and elides shared prefixes, so capping here
// would only hide the divergence between near-identical sibling prompts.
export function rlmChildLabel(prompt: string): string {
	rlmChildDeriveCounts.label += 1;
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}

/** A running child with no tracked activity for this long reports activityStaleMs. */
const RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS = 10 * 60_000;

/**
 * Backstop recheck while a run waits out a child's quota park. Park lifts arrive
 * with child events (the wake's resume turn), but the teardowns that drop a park
 * without resuming - a spent wake budget, a user-cancelled wake - emit no session
 * event, so the wait re-checks on this interval too. Ungrounded waits would
 * otherwise notice only when the child's next event happens to come.
 */
const RLM_CHILD_QUOTA_PARK_LIFT_RECHECK_MS = 30_000;

/**
 * Lazily computed staleness for a running child: how long since the last
 * tracked activity, once past the threshold. Computed at snapshot build time
 * only — no background timers update it.
 *
 * A tool call in flight (activity "executing") is legitimately quiet for its
 * whole duration — a minutes-long bash() run emits no events while it works —
 * so an executing child never reports stale. Staleness measures active time:
 * the wall clock alone would mark every running child stale after a laptop
 * sleep, so the smaller of the wall and monotonic clock deltas bounds it to
 * time the host was actually awake.
 */
function rlmActivityStaleMs(
	status: RlmChildAgentStatus,
	activity: RlmChildAgentActivity | undefined,
	lastActivityAt: number | undefined,
	lastActivityMonotonicAt: number | undefined,
): number | undefined {
	if (status !== "running" || lastActivityAt === undefined) return undefined;
	if (activity?.kind === "executing") return undefined;
	const wallStaleMs = Date.now() - lastActivityAt;
	const monotonicStaleMs =
		lastActivityMonotonicAt === undefined ? wallStaleMs : performance.now() - lastActivityMonotonicAt;
	// Integer ms like every other roster wire field: performance.now() deltas
	// are fractional, and the kernel parser rejects non-int activity_stale_ms.
	const staleMs = Math.floor(Math.min(wallStaleMs, monotonicStaleMs));
	return staleMs >= RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS ? staleMs : undefined;
}

/**
 * The seam of `AgentSession` the child snapshot builders read: the parent node id
 * stamped on every snapshot, and the retained-child map a run's session falls back
 * to. `AgentSession` satisfies it structurally; the collect module's host extends it.
 */
export interface RlmChildSnapshotHost {
	readonly _rlmParentNodeId?: string;
	readonly _rlmChildSessions: Map<string, RetainedRlmChild>;
}

export function rlmChildSnapshotForRun(
	host: RlmChildSnapshotHost,
	run: RlmChildRun,
	child = run.session ?? host._rlmChildSessions.get(run.id)?.session,
): RlmChildAgentSnapshot {
	const model = child?.model ?? run.model;
	// The brief is a run-level constant; re-regexing it per streaming chunk
	// was pure per-chunk CPU on a string that never changes.
	run.label ??= rlmChildLabel(run.prompt);
	return {
		id: run.id,
		parentId: host._rlmParentNodeId,
		sessionName: child?.sessionName ?? run.sessionName,
		model: `${model.provider}/${model.id}`,
		label: run.label,
		status: run.status,
		durationMs: run.durationMs,
		answerPreview: run.answerPreview,
		toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
		tokenCount: child?._contextTokensForCurrentMessages(),
		recap: child?.getCurrentRecap(),
		sessionDir: run.sessionDir,
		activity: run.activity,
		repliedSinceTask: child?._repliedToParentSinceTask,
		progressNote: run.progressNotes?.at(-1),
		lastActivityAt: run.lastActivityAt,
		activityStaleMs: rlmActivityStaleMs(run.status, run.activity, run.lastActivityAt, run.lastActivityMonotonicAt),
		error: run.error,
		stall: run.stall,
	};
}

export function rlmChildSnapshotForSession(
	host: RlmChildSnapshotHost,
	childId: string,
	child: AgentSession,
): RlmChildAgentSnapshot {
	let answerPreview: string | undefined;
	let toolUseCount = 0;
	const messages =
		child.state.streamingMessage?.role === "assistant"
			? [...child.messages, child.state.streamingMessage]
			: child.messages;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const text = compactRlmText(readAssistantText(message));
		if (text) answerPreview = text;
		toolUseCount += message.content.filter((block) => block.type === "toolCall").length;
	}
	return {
		id: childId,
		parentId: host._rlmParentNodeId,
		sessionName: child.sessionName,
		model: child.model ? `${child.model.provider}/${child.model.id}` : undefined,
		label: child.sessionName ?? "child agent",
		status: "done",
		answerPreview,
		toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
		tokenCount: child._contextTokensForCurrentMessages(),
		recap: child.getCurrentRecap(),
		sessionDir: child._rlmSessionDir ?? child.sessionManager.getSessionDir(),
		// No run exists (e.g. a child rehydrated after daemon recovery), so live
		// session state is the only source for in-flight follow-up work. Mirror
		// the run projection's convention: status stays "done" (the recorded task
		// finished) and current work surfaces through activity.
		activity: child.isSessionActive ? { kind: child.isStreaming ? "writing" : "waiting" } : undefined,
		repliedSinceTask: child._repliedToParentSinceTask,
	};
}

/**
 * Streaming preview for a child's in-flight assistant message. The chunk handler
 * used to re-join and re-regex the whole message text per chunk - O(text so far)
 * per chunk, O(text^2) over a long answer - while the preview only depends on the
 * first collapsed characters; the incremental accumulator folds just the new text.
 */
export function rlmChildStreamingPreviewText(
	run: RlmChildRun,
	event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" }>,
): string {
	// The accumulator tracks one assistant message, not the run: a run folds
	// several assistant messages (tool-call rounds, agent_message continuation
	// rounds) and each starts from an empty text. Reading the previous message's
	// folded lengths as the new message's consumed prefix glued the old answer
	// onto a mid-word slice of the new one, or froze the preview at the old cap,
	// for the whole message. message_start is the per-message boundary; reset
	// there so only message_update folds incrementally.
	if (event.type === "message_start") run.streamPreview = undefined;
	run.streamPreview ??= new RlmChildStreamPreview();
	const preview = run.streamPreview;
	return preview.update(event.message as AssistantMessage);
}

/** The volatile snapshot fields as they stand right now. */
export function rlmChildEmitFields(run: RlmChildRun, child: AgentSession | undefined): RlmChildEmitFields {
	return {
		model: child?.model ?? run.model,
		sessionName: child?.sessionName ?? run.sessionName,
		status: run.status,
		durationMs: run.durationMs,
		answerPreview: run.answerPreview,
		toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
		tokenCount: child?._contextTokensForCurrentMessages(),
		recap: child?.getCurrentRecap(),
		activityKind: run.activity?.kind,
		activityToolName: run.activity?.toolName,
		repliedSinceTask: child?._repliedToParentSinceTask,
		error: run.error,
		stall: run.stall,
	};
}

/**
 * Incremental counterpart of {@link compactRlmText} for a streaming assistant
 * message. The preview only depends on the first ~maxLength collapsed characters, so
 * the window stays bounded and freezes once the cap is crossed; new text is folded in
 * by tracking how much of each text block has been consumed, which keeps the per-chunk
 * work at O(new characters + block count) instead of a full join and regex per chunk.
 * String lengths are O(1) in V8, so the tracking itself never touches the old text.
 * A block structure the length tracking cannot describe (a block shrinking, the text
 * count dropping) pays one exact full-text pass instead.
 *
 * At every point the folded text equals readAssistantText(message) as it stood at the
 * last update, so `update()` returns exactly `compactRlmText(textSoFar, maxLength)`.
 */
export class RlmChildStreamPreview {
	/** Consumed length per text block, aligned with the message's text-block order. */
	private foldedTextBlockLengths: number[] = [];
	private buf = "";
	private cappedResult: string | undefined;

	constructor(private readonly maxLength: number = 160) {}

	/** Fold the message's new text in and return the compacted preview. */
	update(message: AssistantMessage): string {
		const lengths: number[] = [];
		const deltas: string[] = [];
		let structural = false;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const consumed = this.foldedTextBlockLengths[lengths.length] ?? 0;
			if (block.text.length < consumed) {
				structural = true;
				break;
			}
			if (block.text.length > consumed) deltas.push(block.text.slice(consumed));
			lengths.push(block.text.length);
		}
		if (structural || lengths.length < this.foldedTextBlockLengths.length) {
			// One exact full-text pass: counted like a compactRlmText call, with its
			// length folded in, so a regression that pays this fallback per chunk
			// re-derives O(text so far) visibly.
			rlmChildDeriveCounts.fullTextPreview += 1;
			const fullText = readAssistantText(message);
			rlmChildDeriveCounts.foldedChars += fullText.length;
			this.foldedTextBlockLengths = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text.length : 0));
			this.buf = fullText.replace(/\s+/g, " ");
			this.cappedResult = undefined;
			this.applyCap();
			return this.preview();
		}
		this.foldedTextBlockLengths = lengths;
		if (this.cappedResult === undefined) {
			for (const delta of deltas) {
				if (delta.length === 0) continue;
				// Count the chars the fold processes: the needle bounds the total over a
				// run, so a regression that re-folds the accumulated text every chunk
				// (e.g. a per-chunk accumulator reset) is visible even without a
				// compactRlmText call.
				rlmChildDeriveCounts.foldedChars += delta.length;
				// The window may carry one trailing space so a delta that opens with
				// whitespace collapses against it, exactly like the full-text regex would.
				this.buf = `${this.buf}${delta}`.replace(/\s+/g, " ");
				this.applyCap();
				if (this.cappedResult !== undefined) break;
			}
		}
		return this.preview();
	}

	preview(): string {
		return this.cappedResult ?? this.buf.trim();
	}

	private applyCap(): void {
		// Same cap decision as compactRlmText: it caps on the trimmed length, so the
		// window's optional trailing space must not tip a text under the cap over it.
		const trimmed = this.buf.trim();
		if (trimmed.length > this.maxLength) {
			this.cappedResult = `${trimmed.slice(0, Math.max(0, this.maxLength - 3)).trimEnd()}...`;
			this.buf = "";
		}
	}
}

/**
 * Record a tracked child activity on both clocks: lastActivityAt stays
 * wall-clock ms for snapshots, and its monotonic twin bounds staleness so a
 * host sleep cannot inflate it.
 */
function touchRlmChildActivity(run: RlmChildRun): void {
	run.lastActivityAt = Date.now();
	run.lastActivityMonotonicAt = performance.now();
}

export function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function attributeChildUsage(parentUsage: Usage, childUsage: Usage): void {
	const parentContextTokens =
		parentUsage.totalTokens ||
		parentUsage.input + parentUsage.output + parentUsage.cacheRead + parentUsage.cacheWrite;
	// Recursive children are launched from an assistant tool call, so the parent assistant
	// message carries their billable usage for session-level cost totals.
	addAssistantUsage(parentUsage, childUsage);
	// Child work affects session-level billable totals, not the parent's model-facing context size.
	parentUsage.totalTokens = parentContextTokens;
}

/**
 * The seam of `AgentSession` the extracted child-run spawn path reads and mutates.
 * Member names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession._startRlmChildRun` delegates with `this`.
 * The stall-notice pump seam comes from {@link RlmChildStallNoticeHost}: the warn-stage
 * subscription below calls `notifyRlmChildStall` (rlm-child-stall-notice.ts) directly.
 */
export interface RlmChildRunHost extends RlmChildStallNoticeHost {
	readonly _semanticEdges: SemanticEdgeRecorder;
	readonly settingsManager: SettingsManager;
	readonly sessionManager: SessionManager;
	readonly _activeRlmChildRuns: Map<string, RlmChildRun>;
	readonly _unsettledRlmChildRuns: Set<RlmChildRun>;
	readonly _pendingRlmSubagentSessionNames: Set<string>;
	/**
	 * Cap slots held by spawns between the live-children check and the run's
	 * registration: the admission round-trip in between is async, so without the
	 * placeholder two parallel spawns both pass the check on the same count.
	 */
	readonly _pendingRlmChildAdmissions: Set<string>;
	readonly _rlmChildSessions: Map<string, RetainedRlmChild>;
	readonly _deletedRlmChildIds: Set<string>;
	readonly _rlmChildUnsubscribes: Map<string, () => void>;
	readonly _queuedChildReplyBackfills: QueuedParentReplyBackfills;
	readonly isStreaming: boolean;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly _rlmDepth: number;
	readonly _rlmMaxDepth: number;
	readonly _rlmMaxConcurrentChildren: number;
	readonly _rlmParentNodeId?: string;
	readonly _disposed: boolean;
	readonly _disposing: boolean;
	_subagentRuntimeHost?: SubagentRuntimeHost;
	_effectiveRlmMaxDepth(): number;
	_liveRlmChildRunCount(): number;
	_assertRlmSubagentSessionNameAvailable(name: string, ignorePendingReservation?: boolean): Promise<void>;
	_mintRlmSuccessorSessionName(requested: string | undefined): Promise<string | undefined>;
	_resolveRlmSubagentModel(reference: string | undefined, target?: string): Promise<RlmSubagentModelSelection>;
	_admitChildRlmSessionDir(
		requestedSessionName: string | undefined,
		prompt: string,
		signal: AbortSignal | undefined,
	): Promise<{ childSessionDir: string; childNodeId: string; sessionName: string }>;
	_rlmHistoricalChildNamesNow(): Set<string>;
	_findLastAssistantMessage(): AssistantMessage | undefined;
	_cancelRlmChildRun(run: RlmChildRun, reason: string): boolean;
	_emit(event: AgentSessionEvent): void;
	_abortRlmChildSessionOnPublish(run: RlmChildRun, child: AgentSession): void;
	_createRlmSubagentRuntimeOptions(options: {
		id: string;
		prompt: string;
		sessionName: string;
		spawnCode?: string;
		sessionDir: string;
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		spawnedByRequestId?: string;
	}): CreateRlmSubagentRuntimeOptions;
	_createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	_deferRlmTerminalNotice(message: CustomMessage): Promise<void>;
	_shareFallbackEpisodeWith(child: AgentSession): void;
	_deliverRlmChildTerminalOutcome(input: {
		run: RlmChildRun;
		child: AgentSession | undefined;
		sessionName: string;
		parentReplyCountBeforeRun: number;
		deliver: (message: CustomMessage) => Promise<void>;
	}): Promise<void>;
	_recordRlmChildStallEvent(
		run: RlmChildRun,
		child: AgentSession,
		stage: "warn" | "abort" | "unsettled",
		event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
	): void;
	_findAssistantEntryForMessage(message: AssistantMessage): SessionMessageEntry | undefined;
	_currentActiveSessionId(): Promise<string | undefined>;
	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean;
	_removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void;
	_rememberClosedRlmChild(childId: string, record: ClosedRlmChildCollectEntry): void;
	_ensureRlmRunDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void>;
	_observeRlmRunDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean>;
	_finishRlmRunDeletion(run: RlmChildRun): Promise<void>;
	_maybeResumeGoalContinuationAfterRlmWork(): void;
	_maybeResumeAutonomousContinuationAfterRlmWork(): void;
}

/**
 * The child-event subscription switch of a running child: maps the child's session
 * events onto the run record (activity, previews, usage attribution, stall
 * forensics) and forwards lifecycle events to the parent. Extracted from
 * `startRlmChildRun` verbatim; `runningToolCount` moved in with it because only
 * this switch ever reads it.
 */
function subscribeRlmChildRunEvents(input: {
	host: RlmChildRunHost;
	run: RlmChildRun;
	child: AgentSession;
	sessionName: string;
	parentAssistantForUsage: AssistantMessage | undefined;
	emitChildUpdate: () => void;
}): () => void {
	const { host, run, child, sessionName, parentAssistantForUsage, emitChildUpdate } = input;
	let runningToolCount = 0;
	return child.subscribe((event) => {
		if (event.type === "rlm_child_update") {
			host._emit(event);
			return;
		}
		if (event.type === "stall_warning") {
			host._recordRlmChildStallEvent(run, child, "warn", event);
			notifyRlmChildStall(host, run, child, sessionName, event);
			return;
		}
		if (event.type === "stall_abort") {
			host._recordRlmChildStallEvent(run, child, "abort", event);
			return;
		}
		if (event.type === "stall_unsettled") {
			// P1-6: "the abort fired but the run never settled" must leave a
			// mark on the parent side, or the kill is invisible and the
			// terminal classifier has nothing to rank above "no reply".
			run.error ??= "stall watchdog aborted the turn but it did not settle";
			host._recordRlmChildStallEvent(run, child, "unsettled", event);
			return;
		}
		if (event.type === "agent_start") {
			run.activity = { kind: "waiting" };
			// A recovered child is no longer stalled; the forensic record stays
			// so the terminal classification can still see an unsettled abort.
			run.stall = undefined;
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "agent_end") {
			run.activity = undefined;
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "rlm_progress_note") {
			// Guarded init instead of `??=` inside the call expression:
			// biome's noAssignInExpressions rejects an assignment used as
			// an expression, and a hand-built run record has no ring yet.
			if (!run.progressNotes) run.progressNotes = [];
			run.progressNotes.push(event.message);
			if (run.progressNotes.length > RLM_CHILD_PROGRESS_NOTE_RING_MAX) {
				run.progressNotes.shift();
			}
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const assistant = event.message as AssistantMessage;
			if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
				attributeChildUsage(parentAssistantForUsage?.usage ?? emptyUsage(), assistant.usage);
				if (parentAssistantForUsage) {
					// Resolved once per run: the parent message is a run-level constant, while
					// the lookup copies and scans every entry the session has ever written.
					// A long child run used to pay that scan for every assistant message it
					// emitted (a session with 56k attributed messages spent minutes here).
					run.parentUsageEntry ??= host._findAssistantEntryForMessage(parentAssistantForUsage);
					const parentEntry = run.parentUsageEntry;
					if (parentEntry) {
						const messages = child.messages;
						const assistantIndex = messages.lastIndexOf(assistant);
						const precedingPrompt = messages
							.slice(0, assistantIndex)
							.reverse()
							.find((message) => message.role === "user" || message.role === "custom");
						const origin =
							precedingPrompt?.role === "custom" && isAgentSessionMessage(precedingPrompt)
								? precedingPrompt.details.id.startsWith("spawn:")
									? "spawn_task"
									: "agent_message"
								: "direct_user";
						host.sessionManager.appendChildUsageAttribution(
							parentEntry.id,
							assistant.usage,
							parentAssistantForUsage.usage,
							origin,
						);
					}
				}
			}
			const text = compactRlmText(readAssistantText(assistant));
			if (text) run.answerPreview = text;
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "message_start" || event.type === "message_update") {
			if (event.message.role === "assistant") {
				const text = rlmChildStreamingPreviewText(run, event);
				if (text) run.answerPreview = text;
				run.activity = { kind: "writing" };
				touchRlmChildActivity(run);
				emitChildUpdate();
			}
		} else if (event.type === "tool_execution_start") {
			run.toolUseCount += 1;
			runningToolCount += 1;
			run.activity = { kind: "executing", toolName: event.toolName };
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "tool_execution_end") {
			runningToolCount = Math.max(0, runningToolCount - 1);
			if (runningToolCount === 0) run.activity = { kind: "waiting" };
			touchRlmChildActivity(run);
			emitChildUpdate();
		} else if (event.type === "session_info_changed" || event.type === "recap_update") {
			emitChildUpdate();
		}
	});
}

/**
 * The run's terminal bookkeeping from the detached task's finally: releases the
 * host-abort listener, flushes the coalesced usage ledger, finishes a detached
 * deletion (or hands it the cleanup), removes the run from the active map across
 * the four retention branches, and wakes the goal/autonomous continuation passes.
 * Extracted from `startRlmChildRun` verbatim.
 */
async function settleRlmChildRun(input: {
	host: RlmChildRunHost;
	run: RlmChildRun;
	childRuntime: RlmSubagentRuntime | undefined;
	signal: AbortSignal | undefined;
	abortFromHost: () => void;
}): Promise<void> {
	const { host, run, childRuntime, signal, abortFromHost } = input;
	signal?.removeEventListener("abort", abortFromHost);
	try {
		// LAT-3: settle the coalesced child usage ledger so the file
		// matches what a reload folds once the run is over, instead of
		// holding deltas back for the next window flush.
		host.sessionManager.flushChildUsageAttributions();
	} catch {
		// Best-effort: the deltas stay in memory and the next persist
		// rewrites the whole transcript, backfilling them.
	}
	if (run.detachedDeletion) {
		run.deletionRunFinished = true;
		if (!run.settled) {
			let cleanupSucceeded = !run.deletionCleanupFailed;
			if (childRuntime && cleanupSucceeded) {
				const cleanup = run.deletionCleanup ?? host._ensureRlmRunDeletionCleanup(run, childRuntime.session);
				cleanupSucceeded = await host._observeRlmRunDeletionCleanup(
					run,
					run.detachedDeletion,
					childRuntime.session,
					cleanup,
				);
			}
			if (cleanupSucceeded) await host._finishRlmRunDeletion(run);
		}
	} else {
		if (host._activeRlmChildRuns.get(run.id) === run) {
			if (host._rlmChildSessions.has(run.id)) {
				host._activeRlmChildRuns.delete(run.id);
				if (run.unsubscribe) host._rlmChildUnsubscribes.set(run.id, run.unsubscribe);
				run.abort = noopRlmChildAbort;
				run.unsubscribe = undefined;
				run.session = undefined;
			} else if (run.status !== "error") {
				host._removeRlmSubagentTracking(run.id, run);
			} else if (run.session === undefined) {
				// A failed run that never bound a session holds no resident work,
				// so no idle passivation will ever come for it: left in the active
				// map it would nail its name down forever and grow the map without
				// bound. It settles into the bounded closed records instead - the
				// collect/roster audit surfaces keep the failure, and the name is
				// free for a re-spawn (numbered by the historical-name rule). The
				// record is re-added after the removal because the removal deletes
				// closed records. Entry shape mirrors rlmCollectEntryForRun, with
				// settled forced: the record is written as part of settling.
				const snapshot = rlmChildSnapshotForRun(host, run);
				const record: ClosedRlmChildCollectEntry = {
					entry: {
						rlm_child_id: snapshot.id,
						session_name: snapshot.sessionName,
						session_dir: snapshot.sessionDir,
						status: snapshot.status,
						settled: true,
						answer_preview: snapshot.answerPreview,
						error: snapshot.error,
						duration_ms: snapshot.durationMs,
						tool_use_count: snapshot.toolUseCount,
						replied_since_task: snapshot.repliedSinceTask,
						activity_kind: undefined,
						terminal_kind: run.terminalKind,
						terminal_reason: run.terminalReason,
						no_reply_notice_superseded: run.noReplyNoticeSuperseded,
						stall_abort: rlmCollectStallAbort(run.stallAbort),
					},
				};
				host._removeRlmSubagentTracking(run.id, run);
				host._rememberClosedRlmChild(run.id, record);
			} else {
				run.unsubscribe?.();
				run.abort = noopRlmChildAbort;
				run.unsubscribe = undefined;
			}
		}
		run.settled = true;
		run.settlement.resolve();
		host._unsettledRlmChildRuns.delete(run);
		host._maybeResumeGoalContinuationAfterRlmWork();
		host._maybeResumeAutonomousContinuationAfterRlmWork();
	}
}

export async function startRlmChildRun(
	host: RlmChildRunHost,
	prompt: string,
	kwargs: Record<string, unknown> = {},
	spawnCode?: string,
	signal?: AbortSignal,
): Promise<RlmSpawnHandle> {
	signal?.throwIfAborted();
	// Snapshot before any await: the spawning request is the turn whose tool call is
	// executing now. A spawn arriving outside an active run (a detached kernel task
	// firing while the parent is idle) has no such turn; an absent edge beats a wrong one.
	const spawnedByRequestId = host.isStreaming ? host._semanticEdges.lastTurnRequestId : undefined;
	const { name: rawName, model: rawModel, thinking: rawThinking, ...unsupported } = kwargs;
	const unsupportedKwargs = Object.keys(unsupported);
	if (unsupportedKwargs.length > 0) {
		throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
	}
	const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
	const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
	const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking);
	if (requestedSessionName) assertDirectAgentMessageTarget(requestedSessionName);
	// The gate reads the *effective* cap, not the value this session resolved for itself:
	// an ancestor that lowered its max depth after this session was admitted pushes a
	// ceiling, and a spawn under that ceiling must be refused now (SC-2).
	const grantedMaxDepth = host._effectiveRlmMaxDepth();
	if (host._rlmDepth >= grantedMaxDepth) {
		const ceilingNote =
			grantedMaxDepth < host._rlmMaxDepth
				? `; an ancestor session lowered this subtree's cap to ${grantedMaxDepth} after this session was admitted`
				: "";
		throw new Error(
			`RLM recursion depth limit reached (RLM_DEPTH=${host._rlmDepth}, RLM_MAX_DEPTH=${host._rlmMaxDepth}${ceilingNote})`,
		);
	}
	// Depth bounds how deep the tree goes, never how wide one session fans out: without
	// this gate a single turn could admit children without limit into an unbounded map.
	// Refusing loudly (instead of queueing) keeps the fleet observable: a queued spawn
	// looks identical to a running one from the parent's side.
	if (host._rlmMaxConcurrentChildren > 0) {
		// Admissions in flight hold a slot: the run joins the live count only after
		// the async admission round-trip below, and counting only the registered
		// runs let two parallel spawns both pass this check on the same count.
		const liveChildren = host._liveRlmChildRunCount() + host._pendingRlmChildAdmissions.size;
		if (liveChildren >= host._rlmMaxConcurrentChildren) {
			throw new Error(
				`RLM subagent limit reached: this session already has ${liveChildren} live children and the concurrency cap is ${host._rlmMaxConcurrentChildren}. ` +
					"Fan-out is refused rather than queued, so the family stays observable: wait for one to settle with `await rlm.collect()`, " +
					'stop one with `await rlm.delete_subagent("<name-or-id>")`, or raise the cap with RLM_MAX_CHILDREN (or the rlmMaxChildren session config); 0 disables the cap.',
			);
		}
	}
	if (requestedSessionName) {
		if (host._pendingRlmSubagentSessionNames.has(requestedSessionName)) {
			throw new Error(formatAgentSessionNameReserved(requestedSessionName, host._rlmDepth + 1));
		}
		host._pendingRlmSubagentSessionNames.add(requestedSessionName);
	}
	// The name stays reserved until the spawn admission settles: the detached
	// runtime task releases it when admission completes (success or failure),
	// and every pre-admission failure path releases it here. Nothing durable
	// records the checked name in between - the child run is not registered yet
	// and the ledger spawn edge only lands at daemon admission - so releasing
	// earlier lets two parallel same-name spawns both pass availability and both
	// append a durable edge, leaving delete/agent_message selectors ambiguous.
	// A minted successor name is reserved the same way.
	let mintedSessionName: string | undefined;
	const releaseReservedSessionName = () => {
		if (requestedSessionName) host._pendingRlmSubagentSessionNames.delete(requestedSessionName);
		if (mintedSessionName) host._pendingRlmSubagentSessionNames.delete(mintedSessionName);
	};
	// Hold the cap slot from here (still synchronous with the check above) until
	// the run registers; the admission round-trip in between is where a parallel
	// spawn would otherwise see a count this spawn never joined.
	const admissionSlot = randomUUID();
	host._pendingRlmChildAdmissions.add(admissionSlot);
	let modelSelection: RlmSubagentModelSelection;
	let childSessionDir = "";
	let childNodeId = "";
	let sessionName = "";
	try {
		if (requestedSessionName) await host._assertRlmSubagentSessionNameAvailable(requestedSessionName, true);
		// The requested name is free, but a child of this session may have worn it
		// before (deleted or idle-closed since): the timeline keys a child's
		// dispatch row, lane and return rows by name, and an exactly recycled
		// name would merge the new child into the old one's rows. The successor
		// takes a numbered name instead.
		mintedSessionName = await host._mintRlmSuccessorSessionName(requestedSessionName);
		// An unpinned spawn model resolves against the persisted subagent
		// default; an unavailable default fails the spawn instead of silently
		// inheriting the parent model.
		modelSelection = await host._resolveRlmSubagentModel(
			requestedModel ?? host.settingsManager.getSubagentDefaultModel(),
		);
		signal?.throwIfAborted();
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		if (host._disposed || host._disposing) {
			throw new Error("Cannot spawn a subagent after its parent was disposed");
		}
		const admitted = await host._admitChildRlmSessionDir(mintedSessionName ?? requestedSessionName, prompt, signal);
		childSessionDir = admitted.childSessionDir;
		childNodeId = admitted.childNodeId;
		sessionName = admitted.sessionName;
		host._rlmHistoricalChildNamesNow().add(sessionName);
	} catch (error) {
		host._pendingRlmChildAdmissions.delete(admissionSlot);
		releaseReservedSessionName();
		throw error;
	}
	const startedAt = Date.now();
	const parentAssistantForUsage = host._findLastAssistantMessage();
	let childSession: AgentSession | undefined;
	const startedMonotonicAt = performance.now();
	const run: RlmChildRun = {
		id: childNodeId,
		prompt,
		sessionName,
		sessionDir: childSessionDir,
		model: modelSelection.model,
		status: "queued",
		toolUseCount: 0,
		progressNotes: [],
		// Seed the staleness clock at admission: a child hung before its
		// first tracked event still crosses the threshold once running.
		lastActivityAt: startedAt,
		lastActivityMonotonicAt: startedMonotonicAt,
		settled: false,
		abort: noopRlmChildAbort,
		publication: createAgentMessageDeferred(),
		settlement: createAgentMessageDeferred(),
		deletionReservation: createAgentMessageDeferred(),
	};
	const throwIfCancelled = () => {
		if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
	};
	// Read through a closure: `_cancelRlmChildRun` mutates `run.status`
	// asynchronously, and an inlined comparison would type-narrow to the status
	// this flow last assigned.
	const isRunCancelled = () => run.status === "cancelled";
	host._activeRlmChildRuns.set(run.id, run);
	// The run itself counts as live from here; the admission placeholder releases.
	host._pendingRlmChildAdmissions.delete(admissionSlot);
	host._unsettledRlmChildRuns.add(run);
	// The kernel host aborts its in-flight requests on teardown; cancel the
	// admitted run with it so a disposed host never leaves a live child behind.
	const abortFromHost = () => {
		const reason = signal?.reason;
		host._cancelRlmChildRun(run, reason instanceof Error ? reason.message : "IPython kernel host request aborted");
	};
	if (signal?.aborted) {
		abortFromHost();
	} else {
		signal?.addEventListener("abort", abortFromHost, { once: true });
	}
	// Waiters blocked on the child's quota park lifting. Nudged from
	// emitChildUpdate: every child event funnels through it, and so does
	// `_cancelRlmChildRun` (it calls `run.emitUpdate`), which is how a delete or
	// a parent teardown wakes the wait instead of riding out the park.
	const quotaParkLiftWaiters = new Set<() => void>();
	const nudgeQuotaParkLiftWaiters = () => {
		if (quotaParkLiftWaiters.size === 0) return;
		for (const waiter of [...quotaParkLiftWaiters]) waiter();
	};
	const waitForQuotaParkLift = (): Promise<void> =>
		new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				quotaParkLiftWaiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, RLM_CHILD_QUOTA_PARK_LIFT_RECHECK_MS);
			timer.unref?.();
			quotaParkLiftWaiters.add(done);
		});
	const emitChildUpdate = () => {
		// The park-lift nudge precedes the unchanged-fields early return on purpose:
		// a cancellation changes no volatile field before it must wake the wait.
		nudgeQuotaParkLiftWaiters();
		// Streaming chunks mostly change nothing the wire can see: the preview is
		// capped after the first ~160 characters and the label is a run-level
		// constant. Comparing the volatile fields first keeps the per-chunk cost
		// off the snapshot build and the JSON.stringify of the full brief.
		const child = run.session ?? host._rlmChildSessions.get(run.id)?.session;
		const fields = rlmChildEmitFields(run, child);
		if (rlmChildEmitFieldsEqual(fields, run.lastEmittedFields)) return;
		const snapshot = rlmChildSnapshotForRun(host, run, child);
		const serialized = JSON.stringify(snapshot);
		rlmChildDeriveCounts.snapshotSerialize += 1;
		run.lastEmittedFields = fields;
		if (serialized === run.lastEmittedUpdate) return;
		run.lastEmittedUpdate = serialized;
		host._emit({ type: "rlm_child_update", child: snapshot });
	};
	run.emitUpdate = emitChildUpdate;
	emitChildUpdate();

	const publishChildSession = (child: AgentSession) => {
		childSession = child;
		// The child was granted the cap in force at admission. If an ancestor tightened it
		// while this run was still starting up, the child must not keep the wider grant
		// (SC-2); an unchanged cap pushes nothing, so a child that later raises its own
		// cap is still only limited by whatever its parent actually imposes.
		const currentCap = host._effectiveRlmMaxDepth();
		if (currentCap < grantedMaxDepth) child._applyRlmMaxDepthCeiling(currentCap);
		const tracked = host._activeRlmChildRuns.get(run.id) === run;
		// Cancellation admitted while runtime construction was blocked must stop
		// the child even when the run already left _activeRlmChildRuns (a cascade
		// that settled it, or an abort race): map membership is not evidence that
		// anything ever reached this child. The wiring below stays behind the
		// tracked guard, so a late publication cannot revive a settled run's
		// accounting (session/abort/unsubscribe) and hide a live child session
		// from its parent.
		if (run.status === "cancelled") host._abortRlmChildSessionOnPublish(run, child);
		if (!tracked) return;
		run.session = child;
		run.abort = () => void child.abort();
		run.publication.resolve();
	};
	const subagentOptions: CreateRlmSubagentRuntimeOptions = {
		...host._createRlmSubagentRuntimeOptions({
			id: childNodeId,
			prompt,
			sessionName,
			spawnCode,
			sessionDir: childSessionDir,
			model: modelSelection.model,
			thinkingLevel: requestedThinkingLevel,
			spawnedByRequestId,
		}),
		onSessionPublished: publishChildSession,
	};

	const deliverTerminalMessageToParent = async (message: CustomMessage): Promise<void> => {
		// Synthesized lifecycle notices always use the parent's private durable
		// path. Explicit child replies continue through agent_message separately.
		await host._deferRlmTerminalNotice(message);
	};

	run.completeDeletion = () => {
		if (!run.deletionNeedsCompletionNotice || run.suppressTerminalNotice || host._disposed || host._disposing) {
			return Promise.resolve();
		}
		if (run.deletionNotice) return run.deletionNotice;
		const notice = deliverTerminalMessageToParent(
			createRlmChildTerminalNoticeMessage({
				kind: "cancelled",
				childId: run.id,
				sessionName,
				reason: run.error ?? "Deleted by parent orchestrator",
			}),
		);
		run.deletionNotice = notice;
		return notice;
	};

	run.reportDeletionCleanupFailure = (error) => {
		if (run.suppressTerminalNotice || host._disposed || host._disposing) return Promise.resolve();
		if (run.deletionFailureNotice) return run.deletionFailureNotice;
		const cleanupError = error instanceof Error ? error.message : String(error);
		const notice = deliverTerminalMessageToParent(
			createRlmChildFailureMessage({
				childId: run.id,
				sessionName,
				error: `Deletion cleanup failed; retry rlm.delete_subagent("${run.id}") before completion: ${cleanupError}`,
			}),
		);
		run.deletionFailureNotice = notice;
		return notice;
	};

	// Runtime startup and the task run are deliberately detached. The public
	// spawn resolves at admission, while this task owns live tracking, usage,
	// retention, cancellation, and late-startup cleanup.
	void (async () => {
		let childRuntime: RlmSubagentRuntime | undefined;
		// Hoisted out of the try: the terminal classification runs in both the
		// success and the failure branch and needs the reply baseline either way.
		let parentReplyCountBeforeRun = 0;
		try {
			try {
				childRuntime = await host._createRlmSubagentRuntime(subagentOptions);
			} finally {
				// Admission settled: in daemon mode the spawn edge is now
				// durable, so the name transfers from the pending reservation
				// to the admitted run. A failed admission frees the name.
				releaseReservedSessionName();
			}
			const child = childRuntime.session;
			if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
			if (child.sessionName !== sessionName) child.setSessionName(sessionName);
			host._shareFallbackEpisodeWith(child);
			publishChildSession(child);
			throwIfCancelled();
			run.status = "running";
			emitChildUpdate();
			const unsubscribeChildEvents = subscribeRlmChildRunEvents({
				host,
				run,
				child,
				sessionName,
				parentAssistantForUsage,
				emitChildUpdate,
			});
			run.unsubscribe = unsubscribeChildEvents;
			const content = `[task from parent]\n\n${prompt}`;
			const spawnMessage: AgentSessionMessage = {
				role: "custom",
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				content,
				display: true,
				details: {
					id: `spawn:${run.id}`,
					message: prompt,
					from: {
						sessionId: host.sessionId,
						sessionName: host.sessionName,
						activeSessionId: await host._currentActiveSessionId(),
					},
					fromRelationship: "parent",
				},
				timestamp: Date.now(),
			};
			throwIfCancelled();
			parentReplyCountBeforeRun = child._parentReplyCount;
			// The baseline and the credits owed have to describe the same run: a
			// reply this child left in my queue during an earlier run belongs to
			// that run's verdict (already delivered), so it must not credit this one.
			const staleReplyCredits = host._queuedChildReplyBackfills.discardForSender(child.sessionId);
			if (staleReplyCredits > 0) {
				sessionLog.info("dropped queued reply credits left over from an earlier run", {
					sessionId: host.sessionId,
					childId: run.id,
					childSessionId: child.sessionId,
					dropped: staleReplyCredits,
				});
			}
			await child.promptAndWait(content, {
				expandPromptTemplates: false,
				source: "extension",
				customMessage: spawnMessage,
			});
			await child.waitForRlmQuiescence();
			// A quota park ends the turn, not the task: the child parked until the
			// provider's usage reset and its own wake resumes it. Settling here would
			// read the parked turn's error stop as the child's death, hand the parent a
			// failure notice for work that is about to continue, and the resumed child
			// would deliver the same result a second time. A parked child is still
			// running: wait out the park and the resumed episode before settling.
			while (!isRunCancelled() && child.isQuotaParked) {
				await waitForQuotaParkLift();
				if (!isRunCancelled()) await child.waitForRlmQuiescence();
			}
			if (run.error) throw new Error(run.error);
			run.status = "done";
			// Only successful completions return; the edge lands on the parent's next commit.
			const childLastCommitted = child.semanticEdges.lastCommittedRequestId;
			if (childLastCommitted !== undefined) {
				host._semanticEdges.recordChildReturned(child.sessionId, childLastCommitted);
			}
			run.durationMs = Date.now() - startedAt;
			run.activity = undefined;
			emitChildUpdate();
			// A turn that ends with a graceful error message resolves promptAndWait,
			// and so does a turn the stall watchdog aborted: both must be classified
			// here or the parent never learns the task failed.
			await host._deliverRlmChildTerminalOutcome({
				run,
				child,
				sessionName,
				parentReplyCountBeforeRun,
				deliver: deliverTerminalMessageToParent,
			});
			if (!host.registerRlmChildSession(run.id, child) && !run.detachedDeletion) {
				if (childRuntime && host._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
					await host._subagentRuntimeHost
						.releaseRlmSubagentRuntime(childRuntime, subagentOptions, "error")
						.catch(() => void child.disposeAsync().catch(() => undefined));
				} else {
					await child.disposeAsync().catch(() => undefined);
				}
			}
		} catch (error) {
			const runError = error instanceof Error ? error : new Error(String(error));
			run.publication.reject(runError);
			if (run.status !== "cancelled") {
				run.status = "error";
				run.error = runError.message;
			}
			// A failed child still returns an error outcome the parent consumes;
			// cancelled runs and zero-commit children return nothing.
			const failedChild = childSession ?? childRuntime?.session;
			const failedLastCommitted = failedChild?.semanticEdges.lastCommittedRequestId;
			if (run.status === "error" && failedChild && failedLastCommitted !== undefined) {
				host._semanticEdges.recordChildReturned(failedChild.sessionId, failedLastCommitted);
			}
			run.durationMs = Date.now() - startedAt;
			run.activity = undefined;
			if (run.status === "error" && childSession === undefined) {
				// A pre-bind failure leaves no row: "cancelled" is the wire's removal signal.
				host._emit({
					type: "rlm_child_update",
					child: { ...rlmChildSnapshotForRun(host, run), status: "cancelled" },
				});
			} else {
				emitChildUpdate();
			}
			await host._deliverRlmChildTerminalOutcome({
				run,
				child: childSession ?? childRuntime?.session,
				sessionName,
				parentReplyCountBeforeRun,
				deliver: deliverTerminalMessageToParent,
			});
			if (!run.detachedDeletion && childSession && host._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
				try {
					await host._subagentRuntimeHost.releaseRlmSubagentRuntime(
						childRuntime ?? { session: childSession },
						subagentOptions,
						run.status === "cancelled" ? "cancelled" : "error",
					);
					if (run.status === "cancelled" && !host._disposed && !host._disposing) {
						host._deletedRlmChildIds.add(run.id);
						host._removeRlmSubagentTracking(run.id);
					}
				} catch {
					await childSession?.disposeAsync().catch(() => undefined);
				}
			} else if (!run.detachedDeletion) {
				try {
					if (childRuntime && host._subagentRuntimeHost) {
						await host._subagentRuntimeHost.deleteRlmSubagentRuntime(run.id, childRuntime.session);
					} else if (childSession) {
						await childSession.disposeAsync();
					}
					if (run.status === "cancelled" && !host._disposed && !host._disposing) {
						host._deletedRlmChildIds.add(run.id);
						host._removeRlmSubagentTracking(run.id);
					}
				} catch {
					// A failed best-effort retry remains available through the retained cleanup maps.
				}
			}
		} finally {
			await settleRlmChildRun({ host, run, childRuntime, signal, abortFromHost });
		}
	})().catch(() => undefined);

	return {
		rlm_child_id: childNodeId,
		name: sessionName,
		session_dir: childSessionDir,
		model: `${modelSelection.model.provider}/${modelSelection.model.id}`,
	};
}
