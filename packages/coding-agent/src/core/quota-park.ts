/**
 * Quota-park cluster extracted from agent-session.ts: the lifecycle a
 * quota-blocked session lives through when the provider-reported usage reset is
 * beyond the bounded wait - park (end the turn cleanly, record the parked
 * transition, arm the wake), the durable one-shot resume job plus in-process
 * wake timer, the wake and its bounded re-arms, and the branch/restart restore
 * that rebuilds the park. The moved methods keep exactly the same bodies; they
 * read the session through {@link QuotaParkHost}, which `AgentSession`
 * satisfies structurally, so the move changes no runtime behavior.
 * `normalizeMessageContent` and `primaryDeliveryRecord` moved here with the
 * cluster (the queued-marker scan uses them): agent-session.ts imports them
 * back, and this module never imports an agent-session value, so the layering
 * stays acyclic.
 */

import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession, QueuedSessionAction } from "./agent-session.js";
import type { AuthSourceToken } from "./auth-storage.js";
import {
	type AgentCronJob,
	type AgentCronJobCancelOrigin,
	AgentCronJobStore,
	QUOTA_WAKE_TIMER_CANCEL_ORIGIN,
} from "./cron-jobs.js";
import {
	type ProviderWaitPolicy,
	parseProviderResetMs,
	providerParkDecision,
	providerStreamFailureRetryAfterMs,
	providerWaitDecision,
} from "./provider-retry.js";
import type { DeliveryRecord } from "./session-action-store.js";

// Same logger name as agent-session.ts: the quota-park paths moved here
// verbatim and their log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/** Session-log entry recorded when a quota-blocked session parks until the provider reset. */
const QUOTA_PARK_CUSTOM_ENTRY_TYPE = "provider_quota_park";
/** Session-log entry recorded when a parked session resumes, or when its wake could not resume it. */
const QUOTA_RESUME_CUSTOM_ENTRY_TYPE = "provider_quota_resume";
/** Label for the durable one-shot wake that resumes a parked session. */
const QUOTA_RESUME_CRON_LABEL = "quota-resume";
/**
 * In-context marker delivered on resume: tells the model the pause happened and
 * that it should continue the interrupted task. The same text is the prompt of
 * the durable wake job, so daemon-delivered resumes read identically.
 */
const QUOTA_RESUME_MARKER_TEXT =
	"<provider_quota_resumed>\n" +
	"The provider usage limit that paused this session has been reported as reset; this resume is automatic (retry.provider.waitForUsage.pauseUntilReset). Continue the interrupted task from where it stopped.\n" +
	"</provider_quota_resumed>";
/** Node caps timers at 2^31-1 ms; longer delays overflow setTimeout and fire after ~1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Retry delay for a wake that was consumed without resuming (refused admission, aborted probe). */
const QUOTA_WAKE_RETRY_DELAY_MS = 60_000;
/** Cap on those retries: a park that can never wake is dropped instead of parked forever. */
const QUOTA_WAKE_MAX_RETRIES = 3;

/** Data carried by a persisted provider_quota_park entry, used to restore a park after a restart. */
interface PersistedQuotaParkData {
	resumeAt: string;
	/**
	 * Provider-reported quota reset time. Absent on the initial park entry (where
	 * resumeAt IS the reset); present on wake re-arm entries, whose resumeAt is the
	 * retry wake time instead. Read by the quota-park status side for the countdown.
	 */
	quotaResumeAt?: string;
	parkCount: number;
	jobId?: string;
	/** Provider whose quota reset the park waits on; kept on re-arm/rebuild entries too. */
	provider?: string;
	/**
	 * Wake re-arms consumed without a resume, carried on re-arm entries so a
	 * restart does not reset the QUOTA_WAKE_MAX_RETRIES budget (the same
	 * restart-safety parkCount already had).
	 */
	wakeRetries?: number;
}

function isPersistedQuotaParkData(value: unknown): value is PersistedQuotaParkData {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.resumeAt === "string" &&
		typeof record.parkCount === "number" &&
		Number.isFinite(record.parkCount) &&
		(record.quotaResumeAt === undefined || typeof record.quotaResumeAt === "string") &&
		(record.jobId === undefined || typeof record.jobId === "string") &&
		(record.provider === undefined || typeof record.provider === "string") &&
		(record.wakeRetries === undefined ||
			(typeof record.wakeRetries === "number" && Number.isFinite(record.wakeRetries)))
	);
}

export function primaryDeliveryRecord(action: QueuedSessionAction): DeliveryRecord {
	if (action.payload.kind !== "turn") throw new Error(`Session action ${action.id} is not a turn`);
	const record = action.payload.records.find((candidate) => candidate.role === "primary");
	if (!record) throw new Error(`Turn action ${action.id} has no primary delivery record`);
	return record;
}

export function normalizeMessageContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images?: ImageContent[];
} {
	if (typeof content === "string") return { text: content };
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 ? { images } : {}) };
}

/**
 * The seam of `AgentSession` the extracted quota-park lifecycle reads and
 * mutates. Member names mirror the class's own members so the extraction stays
 * a textual `this.` -> `host.` rename; members whose signatures are wide are
 * indexed access types so they stay single-sourced on the class.
 * `AgentSession._handleProviderWait`, `_createQuotaResumeJob`,
 * `_resolveQuotaResumeJob`, `_handleAbortedQuotaPark`,
 * `_handleErroredQuotaParkProbe`, `_reloadQuotaParkFromBranch`,
 * `_restoreQuotaPark` and `_completeQuotaParkResume` keep one-line shells that
 * delegate with `this` (the retry path, the fallback long wait, the constructor
 * restore, the message_end terminal handling and branch navigation all call
 * them there); `resumeFromQuotaPark` has no shell left: its one outside caller
 * (a quota-park test) calls the module function directly, and the wake timer
 * fires it in-module. The cluster-internal helpers have no shells.
 */
export interface QuotaParkHost {
	readonly sessionId: AgentSession["sessionId"];
	readonly sessionFile: AgentSession["sessionFile"];
	readonly sessionManager: AgentSession["sessionManager"];
	readonly _rlmDepth: AgentSession["_rlmDepth"];
	_providerWait: AgentSession["_providerWait"];
	_quotaPark: AgentSession["_quotaPark"];
	_quotaResumeJobStore: AgentSession["_quotaResumeJobStore"];
	readonly _navigationCancelledWakeJobs: AgentSession["_navigationCancelledWakeJobs"];
	_providerFailureRecoveryPending: AgentSession["_providerFailureRecoveryPending"];
	_terminalFailureAttemptCount: AgentSession["_terminalFailureAttemptCount"];
	_retryAttempt: AgentSession["_retryAttempt"];
	_retryAuthFailureSources: AgentSession["_retryAuthFailureSources"];
	readonly _actionStore: AgentSession["_actionStore"];
	readonly _lastTurnAbortReason: AgentSession["_lastTurnAbortReason"];
	_canFallbackLongWait(): boolean;
	_handleFallbackLongWait: AgentSession["_handleFallbackLongWait"];
	_markProviderAuthStaleForRetryFailure: AgentSession["_markProviderAuthStaleForRetryFailure"];
	_restorePrimaryModelAfterBackup(): string | undefined;
	_emit: AgentSession["_emit"];
	_resolveRetry(): void;
	_startFreshRequestLadder(): void;
	_retryAfterDelay: AgentSession["_retryAfterDelay"];
	_queuePreparedPrompt: AgentSession["_queuePreparedPrompt"];
	_reportSessionPersistFailure(error: unknown): void;
}

/**
 * One bounded wait-for-recovery ping: exponential backoff with jitter, a
 * scheduled resume when the provider reports a reset time, and hard abort
 * bounds so the wait can never hang.
 */
export async function handleProviderWait(
	host: QuotaParkHost,
	message: AssistantMessage,
	options:
		| {
				markAuthStaleOnFailure?: boolean;
				authSourceTokens?: readonly AuthSourceToken[];
		  }
		| undefined,
	policy: ProviderWaitPolicy,
	reason: "usage" | "unavailable",
): Promise<boolean> {
	const wait = host._providerWait;
	const startedAtMs = wait?.startedAtMs ?? Date.now();
	const pingAttempt = (wait?.attempts ?? 0) + 1;
	host._providerWait = { attempts: pingAttempt, startedAtMs };

	const resetMs = providerStreamFailureRetryAfterMs(message) ?? parseProviderResetMs(message.errorMessage);
	const decision = providerWaitDecision(pingAttempt, Date.now() - startedAtMs, resetMs, policy);
	if (decision.kind === "abort" && reason === "unavailable" && host._canFallbackLongWait()) {
		return host._handleFallbackLongWait(message, options);
	}
	if (decision.kind === "abort") {
		// A quota reset beyond the bounded wait parks the session instead of
		// dying mid-task: end the turn cleanly and resume at the reset time.
		if (reason === "usage" && decision.reason === "reset-too-far") {
			const park = providerParkDecision(host._quotaPark?.parkCount ?? 0, resetMs, policy);
			if (park.kind === "park") {
				return parkForQuotaReset(host, message, options, park.delayMs, decision.message, pingAttempt - 1);
			}
		}
		// A quota wait that gives up ends the episode's park: its wake has
		// already fired (or was never armed), so nothing else would resume it.
		// Future-scheduled parks survive; only stale post-wake parks clear.
		const stalePark = host._quotaPark;
		if (reason === "usage" && stalePark !== undefined && stalePark.resumeAtMs <= Date.now()) {
			cancelQuotaParkWake(host, stalePark);
			host._quotaPark = undefined;
		}
		// Same terminal shape as a spent ladder: agent_end hands the failure
		// back to the model as one recovery turn before the episode is
		// terminal. The wait ran the longest of any failure path; it should
		// not be the one that ends silently.
		host._providerFailureRecoveryPending = true;
		host._markProviderAuthStaleForRetryFailure(message, options);
		const restoredModel = host._restorePrimaryModelAfterBackup();
		host._emit({
			type: "auto_retry_end",
			success: false,
			attempt: pingAttempt - 1,
			finalError: `${decision.message}: ${message.errorMessage || "unknown error"}`,
			...(restoredModel ? { restoredModel } : {}),
		});
		// The pings that just ran are this episode's attempts: a later terminal
		// notice reports them instead of the "no retries attempted" misreport.
		host._terminalFailureAttemptCount = pingAttempt - 1;
		host._retryAttempt = 0;
		host._providerWait = undefined;
		host._retryAuthFailureSources = [];
		host._resolveRetry();
		return false;
	}

	// Each recovery ping after a wait is a fresh probe, bounded by the wait's own
	// attempt and duration limits; counting pings into the failed ladder's pool
	// ended the wait long before either limit.
	host._startFreshRequestLadder();
	return host._retryAfterDelay(
		message,
		options,
		{
			type: "auto_retry_start",
			attempt: pingAttempt,
			maxAttempts: policy.maxAttempts,
			delayMs: decision.delayMs,
			errorMessage: message.errorMessage || "Unknown error",
			reason,
		},
		decision.delayMs,
	);
}

/**
 * Park a quota-blocked session: end the failed turn cleanly, record the
 * parked transition in the session log, and schedule one wake (a durable
 * one-shot scheduled job plus an in-process timer) at the provider-reported
 * reset time. While parked the session makes no model calls; the wake
 * delivers the resume marker, whose first model call probes the quota.
 */
function parkForQuotaReset(
	host: QuotaParkHost,
	message: AssistantMessage,
	options:
		| {
				markAuthStaleOnFailure?: boolean;
				authSourceTokens?: readonly AuthSourceToken[];
		  }
		| undefined,
	pauseMs: number,
	abortMessage: string,
	parkedAttempt: number,
): boolean {
	const existing = host._quotaPark;
	if (existing !== undefined && existing.resumeAtMs > Date.now()) {
		// Already parked for this window (e.g. a heartbeat turn failed while
		// parked): keep the scheduled wake, consume no park, end the turn.
		finishQuotaParkedTurn(
			host,
			message,
			options,
			parkedAttempt,
			`Session is parked until ${new Date(existing.resumeAtMs).toISOString()} waiting for the provider usage reset; this turn ended without a retry: ${message.errorMessage || "unknown error"}`,
		);
		return false;
	}
	cancelQuotaParkWake(host, existing);
	const parkCount = (existing?.parkCount ?? 0) + 1;
	const resumeAtMs = Date.now() + pauseMs;
	const jobId = createQuotaResumeJob(host, resumeAtMs);
	const timer = scheduleQuotaResumeTimer(host, resumeAtMs);
	host._quotaPark = {
		parkCount,
		resumeAtMs,
		quotaResumeAtMs: resumeAtMs,
		...(jobId !== undefined ? { jobId } : {}),
		...(timer !== undefined ? { timer } : {}),
		...(message.provider === undefined ? {} : { provider: message.provider }),
	};
	ensureQuotaParkClockCheck(host);
	try {
		host.sessionManager.appendCustomEntry(QUOTA_PARK_CUSTOM_ENTRY_TYPE, {
			resumeAt: new Date(resumeAtMs).toISOString(),
			parkCount,
			...(jobId !== undefined ? { jobId } : {}),
			provider: message.provider,
		});
	} catch (error) {
		// A failed persist must not swallow the park: without the catch the throw
		// escapes before finishQuotaParkedTurn, _resolveRetry never runs, and the
		// session sits in "retrying" forever with the wake already armed.
		host._reportSessionPersistFailure(error);
	}
	finishQuotaParkedTurn(
		host,
		message,
		options,
		parkedAttempt,
		`${abortMessage}. Session parked until ${new Date(resumeAtMs).toISOString()} and will resume automatically (retry.provider.waitForUsage.pauseUntilReset): ${message.errorMessage || "unknown error"}`,
	);
	return false;
}

/** Shared park tail: mark auth stale, surface the parked status, end the retry and the turn. */
function finishQuotaParkedTurn(
	host: QuotaParkHost,
	message: AssistantMessage,
	options:
		| {
				markAuthStaleOnFailure?: boolean;
				authSourceTokens?: readonly AuthSourceToken[];
		  }
		| undefined,
	parkedAttempt: number,
	finalError: string,
): void {
	host._markProviderAuthStaleForRetryFailure(message, options);
	host._emit({ type: "auto_retry_end", success: false, attempt: parkedAttempt, finalError });
	// The parked turn's pings are real attempts: a terminal notice after the
	// park ends (wake budget spent, probe failing) must not report "no retries
	// attempted". A successful resume resets this at the next message_end.
	host._terminalFailureAttemptCount = parkedAttempt;
	host._retryAttempt = 0;
	host._providerWait = undefined;
	host._retryAuthFailureSources = [];
	host._resolveRetry();
}

/**
 * Durable wake: a one-shot scheduled job in this session's artifacts, so a
 * restart or closed worker still restores the session and delivers the
 * resume marker at the reset time. Best-effort: the in-process timer covers
 * live sessions when this cannot be persisted (e.g. in-memory sessions).
 */
export function createQuotaResumeJob(
	host: QuotaParkHost,
	resumeAtMs: number,
	label = QUOTA_RESUME_CRON_LABEL,
	prompt = QUOTA_RESUME_MARKER_TEXT,
): string | undefined {
	const sessionFile = host.sessionFile;
	const store = quotaResumeStore(host);
	if (!sessionFile || !store) {
		return undefined;
	}
	try {
		const job = store.create({
			activeSessionId: host.sessionId,
			sessionId: host.sessionId,
			sessionFile,
			cwd: host.sessionManager.getCwd(),
			label,
			prompt,
			scheduleText: `at ${new Date(resumeAtMs).toISOString()}`,
			runtimeKind: host._rlmDepth > 0 ? "subagent" : "top-level",
		});
		return job.id;
	} catch {
		return undefined;
	}
}

/** In-process wake for live sessions; unref'd so a parked session never holds the process open. */
function scheduleQuotaResumeTimer(host: QuotaParkHost, resumeAtMs: number): ReturnType<typeof setTimeout> | undefined {
	const delayMs = Math.min(Math.max(resumeAtMs - Date.now(), 0), MAX_TIMER_DELAY_MS);
	const timer = setTimeout(() => {
		void resumeFromQuotaPark(host);
	}, delayMs);
	timer.unref();
	return timer;
}

/**
 * Wall-clock check cadence behind the wake timer. A host sleep pauses the
 * timer's countdown, so after the machine wakes the timer still waits out the
 * full original delay; this interval is what notices the wake is overdue and
 * drives it. One per parked session, unref'd, self-clearing once the park is
 * gone: a session that is not parked has nothing to check.
 */
const QUOTA_WAKE_CLOCK_CHECK_MS = 60_000;
const quotaParkClockChecks = new WeakMap<QuotaParkHost, ReturnType<typeof setInterval>>();

function ensureQuotaParkClockCheck(host: QuotaParkHost): void {
	if (quotaParkClockChecks.has(host)) return;
	const interval = setInterval(() => {
		const park = host._quotaPark;
		if (!park) {
			clearInterval(interval);
			quotaParkClockChecks.delete(host);
			return;
		}
		if (park.waking === true || park.resumeAtMs > Date.now()) return;
		void resumeFromQuotaPark(host);
	}, QUOTA_WAKE_CLOCK_CHECK_MS);
	interval.unref();
	quotaParkClockChecks.set(host, interval);
}

/** Store over this session's artifact file; undefined for in-memory sessions. */
function quotaResumeStore(host: QuotaParkHost): AgentCronJobStore | undefined {
	if (host._quotaResumeJobStore) {
		return host._quotaResumeJobStore;
	}
	const artifactDir = host.sessionManager.getSessionArtifactDir();
	if (!host.sessionFile || !artifactDir) {
		return undefined;
	}
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact(host.sessionId, artifactDir);
	host._quotaResumeJobStore = store;
	return store;
}

/**
 * Settle a park's durable wake: report a job the daemon already ran as
 * delivered (its prompt drives the resume) and leave it alone — rewriting a
 * completed job to cancelled would hide that the wake landed — cancel one
 * that has not run, and report a user cancellation as such. Anything else is
 * gone, leaving the in-process timer as the wake.
 *
 * `cancelOrigin` stamps the cancel the call itself performs. Only the wake
 * timer's takeover (resumeFromQuotaPark) stamps itself: a restart must read
 * that cancel as "the timer owns the resume", not as a user cancellation.
 * Teardown cancels (cancelQuotaParkWake) stamp nothing, so a park dropped or
 * replaced while the session was up stays dropped across a restart.
 */
export function resolveQuotaResumeJob(
	host: QuotaParkHost,
	jobId: string,
	options?: { cancelOrigin?: AgentCronJobCancelOrigin },
): "delivered" | "user-cancelled" | "cancelled" | "gone" {
	const job = findQuotaResumeJob(host, jobId);
	if (job?.status === "completed") {
		// Only a run that actually executed without error delivered the wake: a
		// skipped dispatch is stamped completed without the prompt ever running
		// (runCount stays 0), and an errored run means the marker never landed
		// (lastError is set). Both read as "gone" so the in-process wake owns the
		// resume; the record itself is left untouched, since it is the history of
		// what actually happened.
		if (job.lastError === undefined && job.runCount > 0) {
			return "delivered";
		}
		return "gone";
	}
	if (job?.status === "cancelled") {
		// A wake the in-process timer cancelled is a takeover, not a user
		// cancellation: the timer owns the resume. Only a cancel without that
		// origin is the user's (/cron, the daemon's cron_cancel, session
		// teardown - none of them stamp an origin).
		return job.cancelledBy === QUOTA_WAKE_TIMER_CANCEL_ORIGIN ? "cancelled" : "user-cancelled";
	}
	const store = quotaResumeStore(host);
	if (!store) {
		return "gone";
	}
	try {
		return store.cancel(jobId, undefined, options?.cancelOrigin ? { origin: options.cancelOrigin } : undefined) ===
			undefined
			? "gone"
			: "cancelled";
	} catch {
		return "gone";
	}
}

/** Cancel a park's pending wake: the in-process timer and the durable job. */
function cancelQuotaParkWake(
	host: QuotaParkHost,
	park: { resumeAtMs: number; jobId?: string; timer?: ReturnType<typeof setTimeout> } | undefined,
): void {
	if (!park) return;
	if (park.timer) {
		clearTimeout(park.timer);
		park.timer = undefined;
	}
	if (park.jobId !== undefined) {
		resolveQuotaResumeJob(host, park.jobId);
	}
	park.jobId = undefined;
}

/**
 * Wake a parked session and deliver the resume marker: its first model call
 * probes the quota, resumes the interrupted task on success, and re-parks
 * with the newly reported reset on failure. The durable wake job and this
 * timer race for live sessions; whoever lands first owns the resume — the
 * job's prompt is the same marker text, so both paths read identically.
 */
export async function resumeFromQuotaPark(host: QuotaParkHost): Promise<void> {
	const park = host._quotaPark;
	if (!park || park.waking) {
		return;
	}
	if (park.resumeAtMs > Date.now()) {
		// The wake fired early (the wall clock stepped back after the timer was
		// armed, e.g. an NTP correction). The fire consumed the timer, so re-arm
		// for the remainder: returning without one leaves a live park with no
		// in-process wake at all.
		if (park.timer) clearTimeout(park.timer);
		park.timer = scheduleQuotaResumeTimer(host, park.resumeAtMs);
		return;
	}
	if (park.jobId !== undefined) {
		// The timer cancelling the still-pending job IS the takeover: stamp it, so
		// a restart while the probe below is queued or in flight reads the cancel
		// as "the timer owns the resume" and re-drives the wake instead of ending
		// the episode as a user cancellation.
		const resolved = resolveQuotaResumeJob(host, park.jobId, { cancelOrigin: QUOTA_WAKE_TIMER_CANCEL_ORIGIN });
		if (resolved === "delivered") {
			// The daemon dispatched the durable wake; its prompt drives the resume.
			park.waking = true;
			return;
		}
		if (resolved === "user-cancelled") {
			// The user cancelled the wake: honor it and drop the park.
			host._quotaPark = undefined;
			return;
		}
		// Cancelled by this timer or gone: the timer owns the resume.
	}
	park.waking = true;
	try {
		await host._queuePreparedPrompt("followUp", QUOTA_RESUME_MARKER_TEXT, undefined, {
			source: "internal",
			priority: "background",
			resumeIfIdle: true,
		});
	} catch {
		// A refused admission must not leave a park whose wake is gone: re-arm
		// it (bounded) so the session still resumes, or drop the park.
		park.waking = false;
		recoverQuotaParkWake(host, "wake-failed");
	}
}

/**
 * An aborted turn is not evidence the quota is back. A wake whose resume
 * marker is still queued owns the resume, so an abort of some other turn must
 * not re-arm the wake under it; a wake this turn consumed re-arms instead.
 *
 * One exception: a user abort is the user taking the session back. Re-arming
 * the wake under it auto-resumed the task 60s after the user pressed Esc, so a
 * user-aborted turn cancels the park outright and records the cancellation —
 * but only when the aborted turn is the wake's own probe (the park is waking)
 * or the wake is already due. A user abort of any other turn leaves a
 * future-scheduled park alone: the wake hours from now is not that turn's to
 * cancel.
 */
export function handleAbortedQuotaPark(host: QuotaParkHost): void {
	const park = host._quotaPark;
	if (!park || (park.waking === true && hasQueuedQuotaResumeMarker(host))) {
		return;
	}
	if (host._lastTurnAbortReason === "user" && (park.waking === true || park.resumeAtMs <= Date.now())) {
		cancelQuotaParkWake(host, park);
		host._quotaPark = undefined;
		try {
			host.sessionManager.appendCustomEntry(QUOTA_RESUME_CUSTOM_ENTRY_TYPE, { outcome: "user-aborted" });
		} catch (error) {
			host._reportSessionPersistFailure(error);
		}
		return;
	}
	park.waking = false;
	recoverQuotaParkWake(host, "wake-aborted");
}

/** Whether the park wake's resume marker is still waiting in the session input queue. */
function hasQueuedQuotaResumeMarker(host: QuotaParkHost): boolean {
	return host._actionStore.unfinishedActions().some((action) => {
		if (action.payload.kind !== "turn" || action.lifecycle.state !== "queued") {
			return false;
		}
		const { text } = normalizeMessageContent(primaryDeliveryRecord(action).message.content);
		return text.includes(QUOTA_RESUME_MARKER_TEXT);
	});
}

/**
 * A turn that ended in a plain error after the wake's probe consumed the
 * marker is neither a resume nor a re-park: the park would sit `waking` with
 * no timer or job left, never resuming. Re-arm the wake (bounded) instead,
 * or drop the park once the retries are spent. A marker still queued owns
 * the resume, so an error from another turn must not re-arm under it.
 */
export function handleErroredQuotaParkProbe(host: QuotaParkHost, message: AssistantMessage): void {
	const park = host._quotaPark;
	if (message.stopReason !== "error" || park?.waking !== true || hasQueuedQuotaResumeMarker(host)) {
		return;
	}
	park.waking = false;
	recoverQuotaParkWake(host, "wake-error");
}

/**
 * Wake re-arm for a park whose wake was consumed without resuming (refused
 * admission, aborted or errored probe turn). Bounded so a park that can
 * never wake ends instead of staying parked with no wake and no way to
 * resume.
 */
function recoverQuotaParkWake(host: QuotaParkHost, outcome: "wake-failed" | "wake-aborted" | "wake-error"): void {
	const park = host._quotaPark;
	if (!park || park.waking || park.resumeAtMs > Date.now()) {
		return;
	}
	const retries = (park.wakeRetries ?? 0) + 1;
	if (retries > QUOTA_WAKE_MAX_RETRIES) {
		cancelQuotaParkWake(host, park);
		host._quotaPark = undefined;
		try {
			host.sessionManager.appendCustomEntry(QUOTA_RESUME_CUSTOM_ENTRY_TYPE, { outcome });
		} catch (error) {
			host._reportSessionPersistFailure(error);
		}
		return;
	}
	park.wakeRetries = retries;
	// The wake schedule moves to the retry delay; the provider-reported reset the
	// park waits on does not. Carry it onto the entry as quotaResumeAt so the
	// status read side still shows the real reset instead of the retry time.
	const quotaResumeAtMs = park.quotaResumeAtMs ?? park.resumeAtMs;
	park.quotaResumeAtMs = quotaResumeAtMs;
	park.resumeAtMs = Date.now() + QUOTA_WAKE_RETRY_DELAY_MS;
	park.jobId = createQuotaResumeJob(host, park.resumeAtMs);
	park.timer = scheduleQuotaResumeTimer(host, park.resumeAtMs);
	ensureQuotaParkClockCheck(host);
	// Record the replacement wake, or a restart reads the spent park entry,
	// drops the park, and leaves this retry job armed with no owner to cancel.
	// The provider rides along so readQuotaParkStatus keeps it after the re-arm,
	// and wakeRetries rides along so a restart cannot reset the retry budget.
	// A failed record must not swallow the re-arm: the in-memory park and its
	// timers are already the live truth.
	try {
		host.sessionManager.appendCustomEntry(QUOTA_PARK_CUSTOM_ENTRY_TYPE, {
			resumeAt: new Date(park.resumeAtMs).toISOString(),
			quotaResumeAt: new Date(quotaResumeAtMs).toISOString(),
			parkCount: park.parkCount,
			wakeRetries: retries,
			...(park.jobId !== undefined ? { jobId: park.jobId } : {}),
			...(park.provider !== undefined ? { provider: park.provider } : {}),
		});
	} catch (error) {
		host._reportSessionPersistFailure(error);
	}
}

function findQuotaResumeJob(host: QuotaParkHost, jobId: string): AgentCronJob | undefined {
	const store = quotaResumeStore(host);
	if (!store) {
		return undefined;
	}
	try {
		return store.list().find((job) => job.id === jobId);
	} catch {
		return undefined;
	}
}

/**
 * Durable wake for a restored park: reuse a job that can still fire and
 * recreate one that was cancelled (a navigation cancels the left-behind
 * leaf's wake) or removed, so a restored park never waits on a dead job.
 *
 * A cancelled future wake stays a user cancellation even when it carries the
 * timer's takeover stamp: on a future-scheduled entry the stamp only survives
 * when the branch was rewound past the takeover (the stamp's episode continued
 * on the branch that was left), and there the user cancel of the successor
 * wake is the intent to honor. The takeover stamp is honored on the due-past
 * branch instead, where a restart after the takeover is the only way a
 * cancelled job can sit under an overdue entry (see restoreQuotaPark).
 */
function restoreQuotaWakeJob(
	host: QuotaParkHost,
	jobId: string | undefined,
	resumeAtMs: number,
): string | undefined | "user-cancelled" {
	if (jobId === undefined) {
		return createQuotaResumeJob(host, resumeAtMs);
	}
	const job = findQuotaResumeJob(host, jobId);
	if (job === undefined || job.status !== "cancelled") {
		// Not cancelled: still scheduled, or already delivered by the daemon.
		return jobId;
	}
	// A cancelled wake stays cancelled unless navigation cancelled it, which
	// frees the wake so returning to the parked branch can rebuild it.
	if (host._navigationCancelledWakeJobs.has(jobId)) {
		return createQuotaResumeJob(host, resumeAtMs);
	}
	return "user-cancelled";
}

/**
 * Rebuild the park for the branch this navigation selected. The old leaf's
 * wake is cancelled with it, so a parked leaf that was left behind cannot
 * resume its task on the selected branch.
 */
export function reloadQuotaParkFromBranch(host: QuotaParkHost): void {
	const previous = host._quotaPark;
	host._quotaPark = undefined;
	if (previous?.timer) {
		clearTimeout(previous.timer);
		previous.timer = undefined;
	}
	if (previous?.jobId !== undefined) {
		// Only a wake this navigation actually cancels may be rebuilt on the way
		// back; a wake the user cancelled in /cron stays cancelled.
		if (resolveQuotaResumeJob(host, previous.jobId) === "cancelled") {
			host._navigationCancelledWakeJobs.add(previous.jobId);
		}
	}
	restoreQuotaPark(host);
}

/**
 * Restore the park this branch ended on: a restart (daemon or worker) leaves
 * waitForUsage.maxParks unbounded otherwise, because the park count would
 * start over at 1 each time. Parks recorded before the branch's last resume
 * entry are spent, and a park whose wake time has passed is left to the
 * durable wake job — only one that is still ahead re-arms the timer.
 */
export function restoreQuotaPark(host: QuotaParkHost): void {
	const branch = host.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom") {
			continue;
		}
		if (entry.customType === QUOTA_RESUME_CUSTOM_ENTRY_TYPE) {
			return;
		}
		if (entry.customType !== QUOTA_PARK_CUSTOM_ENTRY_TYPE || !isPersistedQuotaParkData(entry.data)) {
			continue;
		}
		const resumeAtMs = Date.parse(entry.data.resumeAt);
		if (!Number.isFinite(resumeAtMs) || resumeAtMs <= Date.now()) {
			// The wake time passed while the session was down. The durable wake
			// job normally still covers it (the daemon claims due jobs on
			// sight), so only a wake that is definitely gone - never persisted,
			// or lost with the job store - leaves the parked task with no
			// resume path at all. Record that loss instead of dropping it
			// silently; a wake the user cancelled is their choice and stays
			// quiet, exactly like the live user-cancelled path below.
			const job = entry.data.jobId === undefined ? undefined : findQuotaResumeJob(host, entry.data.jobId);
			if (entry.data.jobId === undefined || job === undefined) {
				sessionLog.warn(
					"quota park's wake time passed and its durable wake job is gone; the parked task will not resume",
					{
						sessionId: host.sessionId,
						resumeAt: entry.data.resumeAt,
						parkCount: entry.data.parkCount,
						jobId: entry.data.jobId ?? null,
					},
				);
				try {
					host.sessionManager.appendCustomEntry(QUOTA_RESUME_CUSTOM_ENTRY_TYPE, {
						outcome: "wake-lost",
						resumeAt: entry.data.resumeAt,
						parkCount: entry.data.parkCount,
						...(entry.data.provider !== undefined ? { provider: entry.data.provider } : {}),
					});
				} catch (error) {
					host._reportSessionPersistFailure(error);
				}
				return;
			}
			// The user cancelled the wake while the session was down: their choice
			// stands, and the episode ends here. A cancellation the in-process wake
			// timer stamped is a takeover, not a choice - the probe it queued died
			// with the process, so the park is restored below and its wake re-fires.
			if (job.status === "cancelled" && job.cancelledBy !== QUOTA_WAKE_TIMER_CANCEL_ORIGIN) {
				return;
			}
			// The job survived: restore the park WITH its count, or every restart
			// during a quota episode reset parkCount to 1 and waitForUsage.maxParks
			// never bounded anything. The wake is already due, so the in-process
			// timer drives it immediately and races the daemon's claim of the
			// durable job - the same race a live park always runs.
			host._quotaPark = {
				parkCount: entry.data.parkCount,
				resumeAtMs,
				...(entry.data.quotaResumeAt !== undefined && Number.isFinite(Date.parse(entry.data.quotaResumeAt))
					? { quotaResumeAtMs: Date.parse(entry.data.quotaResumeAt) }
					: {}),
				...(entry.data.jobId !== undefined ? { jobId: entry.data.jobId } : {}),
				timer: scheduleQuotaResumeTimer(host, resumeAtMs),
				...(entry.data.provider !== undefined ? { provider: entry.data.provider } : {}),
				...(entry.data.wakeRetries !== undefined ? { wakeRetries: entry.data.wakeRetries } : {}),
			};
			ensureQuotaParkClockCheck(host);
			return;
		}
		const quotaResumeAtMs = entry.data.quotaResumeAt === undefined ? undefined : Date.parse(entry.data.quotaResumeAt);
		const jobId = restoreQuotaWakeJob(host, entry.data.jobId, resumeAtMs);
		if (jobId === "user-cancelled") {
			return;
		}
		if (jobId !== undefined && jobId !== entry.data.jobId) {
			// A rebuilt wake replaces the cancelled one: record it, so the next
			// restore reuses this job instead of arming another one beside it.
			// The provider rides along so readQuotaParkStatus keeps it after the rebuild.
			try {
				host.sessionManager.appendCustomEntry(QUOTA_PARK_CUSTOM_ENTRY_TYPE, {
					resumeAt: entry.data.resumeAt,
					parkCount: entry.data.parkCount,
					jobId,
					...(entry.data.quotaResumeAt !== undefined ? { quotaResumeAt: entry.data.quotaResumeAt } : {}),
					...(entry.data.provider !== undefined ? { provider: entry.data.provider } : {}),
					...(entry.data.wakeRetries !== undefined ? { wakeRetries: entry.data.wakeRetries } : {}),
				});
			} catch (error) {
				host._reportSessionPersistFailure(error);
			}
		}
		host._quotaPark = {
			parkCount: entry.data.parkCount,
			resumeAtMs,
			...(quotaResumeAtMs !== undefined && Number.isFinite(quotaResumeAtMs) ? { quotaResumeAtMs } : {}),
			...(jobId !== undefined ? { jobId } : {}),
			timer: scheduleQuotaResumeTimer(host, resumeAtMs),
			...(entry.data.provider !== undefined ? { provider: entry.data.provider } : {}),
			...(entry.data.wakeRetries !== undefined ? { wakeRetries: entry.data.wakeRetries } : {}),
		};
		ensureQuotaParkClockCheck(host);
		return;
	}
}

/**
 * A parked session completed a model call successfully: the quota is back.
 * Clear the park (cancelling any pending wake), record the resumed
 * transition, and — unless this success WAS the wake probe — deliver the
 * resume marker so the interrupted task continues right away.
 */
export function completeQuotaParkResume(host: QuotaParkHost): void {
	const park = host._quotaPark;
	if (!park) return;
	// A wake the daemon already delivered owns the resume even when the timer
	// never observed it: the job's marker prompt is the continuation, so this
	// success must not queue a second one.
	const delivered = park.jobId !== undefined && resolveQuotaResumeJob(host, park.jobId) === "delivered";
	cancelQuotaParkWake(host, park);
	const wasWaking = park.waking === true || delivered;
	const restoredModel = host._restorePrimaryModelAfterBackup();
	host._quotaPark = undefined;
	try {
		host.sessionManager.appendCustomEntry(QUOTA_RESUME_CUSTOM_ENTRY_TYPE, {
			outcome: wasWaking ? "wake" : "early",
			...(restoredModel ? { restoredModel } : {}),
		});
	} catch (error) {
		host._reportSessionPersistFailure(error);
	}
	if (!wasWaking) {
		void host
			._queuePreparedPrompt("followUp", QUOTA_RESUME_MARKER_TEXT, undefined, {
				source: "internal",
				priority: "background",
				resumeIfIdle: true,
			})
			.catch(() => {
				// The early-resume marker could not be queued; the park is cleared,
				// so a later quota failure parks again with a fresh schedule.
			});
	}
}
