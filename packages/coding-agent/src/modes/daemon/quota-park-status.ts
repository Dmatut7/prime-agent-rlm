import type { AgentSession } from "../../core/agent-session.js";
import type { DaemonSessionSnapshotQuotaPark } from "./daemon-protocol.js";

/**
 * 中断-10: a quota-parked session (retry.provider.waitForUsage.pauseUntilReset)
 * can sit idle for up to 24h with no user-visible signal. The daemon reads the
 * park out of the live session and broadcasts quota_park_status heartbeats so a
 * client can render a countdown. The park facts live in the persisted
 * provider_quota_park branch entry: every park, re-park and wake re-arm appends
 * one (core/quota-park.ts parkForQuotaReset / recoverQuotaParkWake /
 * restoreQuotaPark), so the newest entry ahead of any provider_quota_resume is
 * the active park - the same walk restoreQuotaPark does after a restart.
 */

// Mirrors QUOTA_PARK_CUSTOM_ENTRY_TYPE / QUOTA_RESUME_CUSTOM_ENTRY_TYPE in
// core/quota-park.ts, which are module-private there. The source pin in
// test/daemon-quota-park-status.test.ts fails if either side is renamed.
const QUOTA_PARK_CUSTOM_ENTRY_TYPE = "provider_quota_park";
const QUOTA_RESUME_CUSTOM_ENTRY_TYPE = "provider_quota_resume";

export interface QuotaParkStatus {
	/**
	 * Absolute wake time the client should count down to: the provider's real
	 * quota reset when the park entry knows it (quotaResumeAt), otherwise the
	 * next probe wake (resumeAt). Absent only for a parked session with no
	 * persisted entry (in-memory sessions).
	 */
	resumeAtMs?: number;
	parkCount?: number;
	provider?: string;
}

/**
 * The live park of a bound session, or undefined when the session is not
 * parked. `isQuotaParked` (the in-memory flag) is the authority for "parked";
 * the branch walk supplies the wake facts. A provider_quota_resume entry newer
 * than every park entry means the park was spent - report none even if the
 * in-memory flag has not caught up.
 */
export function readQuotaParkStatus(session: AgentSession): QuotaParkStatus | undefined {
	if (!session.isQuotaParked) {
		return undefined;
	}
	const branch = session.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom") {
			continue;
		}
		if (entry.customType === QUOTA_RESUME_CUSTOM_ENTRY_TYPE) {
			return undefined;
		}
		if (entry.customType !== QUOTA_PARK_CUSTOM_ENTRY_TYPE) {
			continue;
		}
		const data = entry.data as
			| { quotaResumeAt?: unknown; resumeAt?: unknown; parkCount?: unknown; provider?: unknown }
			| undefined;
		// quotaResumeAt is the provider's real reset the park waits on; resumeAt is
		// only the next probe wake. Counting down to the probe would show a wake that
		// does not actually restore quota, so the real reset wins when both are known.
		const quotaResumeAtMs = typeof data?.quotaResumeAt === "string" ? Date.parse(data.quotaResumeAt) : Number.NaN;
		const resumeAtMs = Number.isFinite(quotaResumeAtMs)
			? quotaResumeAtMs
			: typeof data?.resumeAt === "string"
				? Date.parse(data.resumeAt)
				: Number.NaN;
		return {
			...(Number.isFinite(resumeAtMs) ? { resumeAtMs } : {}),
			...(typeof data?.parkCount === "number" && Number.isFinite(data.parkCount)
				? { parkCount: data.parkCount }
				: {}),
			...(typeof data?.provider === "string" ? { provider: data.provider } : {}),
		};
	}
	// Parked in memory without a persisted entry (in-memory session): still
	// reportable, just without a countdown.
	return {};
}

/**
 * The wire shape both park surfaces share: the quota_park_status event's
 * parked:true payload and the attach snapshot's quotaPark field. remainingMs is
 * point-in-time (computed against `now`); consumers that outlive the frame
 * should count down from the absolute resumeAt instead. Clamped at 0: a wake
 * firing right now is "resuming", not overdue.
 */
export function quotaParkWireFacts(status: QuotaParkStatus, now = Date.now()): DaemonSessionSnapshotQuotaPark {
	return {
		parked: true,
		...(status.resumeAtMs !== undefined
			? {
					resumeAt: new Date(status.resumeAtMs).toISOString(),
					remainingMs: Math.max(0, status.resumeAtMs - now),
				}
			: {}),
		...(status.parkCount !== undefined ? { parkCount: status.parkCount } : {}),
		...(status.provider !== undefined ? { provider: status.provider } : {}),
	};
}
