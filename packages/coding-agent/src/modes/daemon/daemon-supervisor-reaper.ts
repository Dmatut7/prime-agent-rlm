/**
 * Reaper + retention cluster extracted from daemon-supervisor.ts (wave-52, the
 * fourth Host-seam cut on the supervisor after the wave-48 warm pool, the
 * wave-50 adoption cluster and the wave-51 roster-sync): the failed-worker
 * reaper (L5 — archive a verifiably-dead failed registration once it is past
 * the threshold, and stand down entirely while the supervisor runs degraded)
 * and the disk-retention sweep timer (the `retention.sweepIntervalMinutes`
 * cadence check around the core retention runner). The moved methods keep
 * exactly the same bodies; they read the supervisor through
 * {@link DaemonSupervisorReaperHost}, so the move changes no runtime behavior.
 * The four entry points with callers outside the cluster
 * (startFailedWorkerReaper / startRetentionSweepTimer from start(),
 * clearFailedWorkerReaperTimer / clearRetentionSweepTimer from the cleanup
 * paths) keep one-line shells on the class so instance-level dispatch —
 * including prototype-harness stubs that shadow those names — is preserved
 * exactly. Cluster-internal helpers (runRetentionSweepIfDue /
 * residentSessionIds / reapFailedWorkers / reapFailedWorkersOnce /
 * isFailedWorkerReapCandidate / isWorkerProcessConfirmedDead /
 * hasUnconsumedRecoveryJournal / archiveAndReapFailedWorker /
 * reapFailedWorkerOrphanJournal) are module-private and called directly — no
 * test or caller ever named them on the class.
 *
 * Same adaptations as the earlier cuts: DaemonSupervisor members are
 * `private`-keyworded, so `this` cannot satisfy the host interface structurally
 * — the class instead exposes `reaperHost`, a facade of live getters and
 * arrows built inside the class (no casts, no visibility changes), so the
 * memoized facade never goes stale. The reap/retention bookkeeping (both
 * timers, the in-flight reap promise, the last-sweep clock) moved with the
 * cluster as {@link DaemonReaperState}; the class holds one lazily-created
 * instance, preserving the prototype-harness semantics of supervisors that
 * bypass the constructor. The cadence configuration
 * (failedWorkerReapIntervalMs / retentionSweepCheckIntervalMs) stays
 * constructor-set on the class and is read live through the host.
 *
 * `workerHasScheduledJobs` / `workerHasAttachedClient` (adoption cluster) and
 * `flipWorkerRosterEntriesInactive` (roster-sync cluster) are reached through
 * the class shells, so an own-property stub of those names keeps intercepting.
 * Like the adoption module, this one carries a value-level import back into
 * ./daemon-supervisor.js (isProcessIdentityConfirmedDead); the binding is only
 * touched inside a function body, so the module-evaluation cycle is inert.
 * Everything else from the supervisor is imported as types only.
 */

import {
	killOrphanProcess,
	readActiveOrphanProcesses,
	reapForeignOrphanProcessRecords,
	shouldReapOrphanProcess,
} from "../../core/orphan-process-journal.js";
import { runRetentionSweepOnce } from "../../core/retention/runner.js";
import { type DaemonSupervisor, isProcessIdentityConfirmedDead, type ResidentWorker } from "./daemon-supervisor.js";
import { WorkerRecoveryJournal } from "./worker-recovery-journal.js";

/**
 * The reaper/retention bookkeeping, moved out of the supervisor with the
 * cluster. The class holds one lazily-created instance: prototype-harness
 * supervisors in tests bypass the constructor, and every reader (the start
 * path's timer arming, the cleanup paths' clears, an in-flight reap) must see
 * an empty seat there instead of throwing.
 */
export class DaemonReaperState {
	failedWorkerReaperTimer?: NodeJS.Timeout;
	/** Single-flight guard: one reap pass at a time; a tick during a pass joins it. */
	failedWorkerReapSweep?: Promise<void>;
	retentionSweepTimer?: NodeJS.Timeout;
	/** The cadence clock moves only after a sweep that actually ran. */
	lastRetentionSweepAtMs = 0;
}

/**
 * The seam of DaemonSupervisor the extracted reaper+retention cluster reads and
 * calls. Member types mirror the class's own members via indexed access so a
 * rename on the class fails here at compile time. The class satisfies this with
 * the `reaperHost` facade (its members are `private`-keyworded, so the instance
 * itself cannot be the host structurally); every member is read live through a
 * getter or arrow, never snapshotted. The seam is read-only/call-only: the
 * cluster mutates only its own state seat and (through workers.delete /
 * flipWorkerRosterEntriesInactive / deleteWorkerDescriptor) the registration —
 * exactly what the methods did on the class.
 */
export interface DaemonSupervisorReaperHost {
	readonly reaperState: DaemonReaperState;
	readonly workers: DaemonSupervisor["workers"];
	readonly shuttingDown: DaemonSupervisor["shuttingDown"];
	readonly degraded: DaemonSupervisor["degraded"];
	readonly settingsManager: DaemonSupervisor["settingsManager"];
	readonly defaultSessionConfig: DaemonSupervisor["defaultSessionConfig"];
	readonly failedWorkerReapIntervalMs: DaemonSupervisor["failedWorkerReapIntervalMs"];
	readonly retentionSweepCheckIntervalMs: DaemonSupervisor["retentionSweepCheckIntervalMs"];
	readonly adoptionState: DaemonSupervisor["adoptionState"];
	background: DaemonSupervisor["background"];
	log: DaemonSupervisor["log"];
	logDegraded: DaemonSupervisor["logDegraded"];
	isWorkerStopping: DaemonSupervisor["isWorkerStopping"];
	workerHasScheduledJobs: DaemonSupervisor["workerHasScheduledJobs"];
	workerHasAttachedClient: DaemonSupervisor["workerHasAttachedClient"];
	flipWorkerRosterEntriesInactive: DaemonSupervisor["flipWorkerRosterEntriesInactive"];
	deleteWorkerDescriptor: DaemonSupervisor["deleteWorkerDescriptor"];
	broadcastHeartbeatsChanged: DaemonSupervisor["broadcastHeartbeatsChanged"];
}

export function startFailedWorkerReaper(host: DaemonSupervisorReaperHost): void {
	const state = host.reaperState;
	if (state.failedWorkerReaperTimer) {
		return;
	}
	state.failedWorkerReaperTimer = setInterval(() => {
		host.background(reapFailedWorkers(host), "failed worker reaper");
	}, host.failedWorkerReapIntervalMs);
	state.failedWorkerReaperTimer.unref();
}

export function clearFailedWorkerReaperTimer(host: DaemonSupervisorReaperHost): void {
	const state = host.reaperState;
	if (!state.failedWorkerReaperTimer) {
		return;
	}
	clearInterval(state.failedWorkerReaperTimer);
	state.failedWorkerReaperTimer = undefined;
}

export function startRetentionSweepTimer(host: DaemonSupervisorReaperHost): void {
	const state = host.reaperState;
	if (state.retentionSweepTimer) {
		return;
	}
	state.retentionSweepTimer = setInterval(() => {
		host.background(runRetentionSweepIfDue(host), "retention sweep");
	}, host.retentionSweepCheckIntervalMs);
	state.retentionSweepTimer.unref();
}

export function clearRetentionSweepTimer(host: DaemonSupervisorReaperHost): void {
	const state = host.reaperState;
	if (!state.retentionSweepTimer) {
		return;
	}
	clearInterval(state.retentionSweepTimer);
	state.retentionSweepTimer = undefined;
}

/**
 * The disk-retention sweep, on the cadence `retention.sweepIntervalMinutes`
 * asks for. Only the daemon runs it on a timer: a short-lived CLI process must
 * not perform a large delete while it is exiting. `retention.enabled: false`
 * and the per-class zero knobs keep the sweep report-only, the runner has its
 * own in-flight guard so a slow sweep cannot stack, and the runner's sweep guard
 * keeps a second process on the same agent dir out of the same accounts.
 *
 * The cadence clock moves only after a sweep that actually ran. A trigger that
 * found the guard held by another process did no work, so it is not a sweep at
 * this timestamp: the next check tick tries again instead of waiting out a full
 * interval for nothing.
 */
async function runRetentionSweepIfDue(host: DaemonSupervisorReaperHost, now = Date.now()): Promise<void> {
	if (host.shuttingDown) {
		return;
	}
	const settings = host.settingsManager.getRetentionSettings();
	const intervalMs = settings.sweepIntervalMinutes * 60_000;
	if (intervalMs <= 0) {
		return;
	}
	const state = host.reaperState;
	if (state.lastRetentionSweepAtMs !== 0 && now - state.lastRetentionSweepAtMs < intervalMs) {
		return;
	}
	const outcome = await runRetentionSweepOnce({
		settings,
		...(host.defaultSessionConfig.agentDir ? { agentDir: host.defaultSessionConfig.agentDir } : {}),
		residentSessionIds: residentSessionIds(host),
	});
	if (outcome.lockHeld) {
		host.log(`retention sweep skipped: another sweep holds the guard${outcome.holder ? ` (${outcome.holder})` : ""}`);
		return;
	}
	state.lastRetentionSweepAtMs = now;
	const report = outcome.report;
	if (!report) {
		return;
	}
	host.log(
		`retention sweep: reclaimed ${report.totals.reclaimed} entries / ${report.totals.bytes} bytes` +
			`${report.capped ? " (per-sweep cap reached)" : ""}${report.dryRun ? " (dry run)" : ""}` +
			`${outcome.lockUnavailable ? " (no sweep guard)" : ""}`,
	);
}

/** Session ids this supervisor has resident, so a sweep never touches them. */
function residentSessionIds(host: DaemonSupervisorReaperHost): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const worker of host.workers.values()) {
		for (const summary of worker.summaries.values()) {
			ids.add(summary.id);
			if (summary.activeSessionId) {
				ids.add(summary.activeSessionId);
			}
		}
	}
	return ids;
}

/**
 * L5: a failed worker whose process is verifiably gone is archived into the log
 * and removed, so restarts stop replaying the same corpses and the agents view
 * stops carrying rows nobody can act on. Low frequency by design: this is
 * cleanup, not liveness detection.
 */
async function reapFailedWorkers(host: DaemonSupervisorReaperHost, now = Date.now()): Promise<void> {
	const state = host.reaperState;
	if (state.failedWorkerReapSweep || host.shuttingDown) {
		return state.failedWorkerReapSweep;
	}
	state.failedWorkerReapSweep = reapFailedWorkersOnce(host, now).finally(() => {
		state.failedWorkerReapSweep = undefined;
	});
	return state.failedWorkerReapSweep;
}

async function reapFailedWorkersOnce(host: DaemonSupervisorReaperHost, now: number): Promise<void> {
	const thresholdHours = host.settingsManager.getDaemonSupervisorSettings().failedWorkerReapHours;
	if (thresholdHours === undefined) {
		return;
	}
	const thresholdMs = thresholdHours * 60 * 60 * 1000;
	const candidates = [...host.workers.values()].filter((worker) =>
		isFailedWorkerReapCandidate(host, worker, now, thresholdMs),
	);
	if (candidates.length === 0) {
		return;
	}
	for (const worker of candidates) {
		if (host.shuttingDown) {
			return;
		}
		// I-7: the identity check may spawn `ps`, so it is awaited (never
		// execFileSync) and the loop yields between candidates.
		if (!(await isWorkerProcessConfirmedDead(worker))) {
			continue;
		}
		if (hasUnconsumedRecoveryJournal(worker)) {
			host.log(
				`Keeping failed worker ${worker.descriptor.workerId}: its recovery journal still has unconsumed busy operations`,
			);
			continue;
		}
		if (host.degraded) {
			// M16: the reaper's inputs are bookkeeping. While the supervisor runs on
			// state it could not persist, only the reversible half runs — the roster
			// row goes inactive, the descriptor (an irreversible delete) is kept.
			host.logDegraded(
				"failed worker reaper deferred",
				`Failed-worker reaper deferred while degraded: kept ${worker.descriptor.workerId} on disk and only flipped its roster rows inactive`,
			);
			host.flipWorkerRosterEntriesInactive(worker);
			continue;
		}
		archiveAndReapFailedWorker(host, worker, now);
		await new Promise<void>((resolveYield) => setImmediate(resolveYield));
	}
}

function isFailedWorkerReapCandidate(
	host: DaemonSupervisorReaperHost,
	worker: ResidentWorker,
	now: number,
	thresholdMs: number,
): boolean {
	if (worker.descriptor.lifecycle !== "failed") {
		return false;
	}
	// An intentional or in-flight stop owns the registration until it finishes.
	if (worker.descriptor.stopRequestedAt !== undefined || host.isWorkerStopping(worker)) {
		return false;
	}
	if (worker.recovery || worker.deferredRecovery || worker.stopFinalization) {
		return false;
	}
	if (host.adoptionState.retryTimers.has(worker)) {
		return false;
	}
	// Exemptions: a schedule that still needs the tree, and anybody watching it.
	if (host.workerHasScheduledJobs(worker) || host.workerHasAttachedClient(worker)) {
		return false;
	}
	const failedAt = Date.parse(worker.descriptor.lastFailureAt ?? worker.descriptor.updatedAt);
	if (!Number.isFinite(failedAt)) {
		return false;
	}
	return now - failedAt >= thresholdMs;
}

/**
 * Death has to be proven twice before an irreversible delete: the pid must be
 * gone, and a pid that is alive must demonstrably belong to somebody else. An
 * unobservable identity counts as alive, so a transient `ps` failure can never
 * authorise deleting a registration.
 */
async function isWorkerProcessConfirmedDead(worker: ResidentWorker): Promise<boolean> {
	return isProcessIdentityConfirmedDead(worker.descriptor.pid, worker.descriptor.processStartId);
}

function hasUnconsumedRecoveryJournal(worker: ResidentWorker): boolean {
	try {
		const journal = new WorkerRecoveryJournal(worker.descriptor.recoveryJournalPath);
		// Busy records name interrupted work; a non-busy record carrying queuedInputs
		// holds the only crash-durable copy of a parked user queue. Both must reach
		// an interruption marker before this corpse may go.
		return journal
			.getLatest()
			.some((record) => record.busy || (record.queuedInputs !== undefined && record.queuedInputs.length > 0));
	} catch {
		// An unreadable journal is treated as unconsumed: deleting the descriptor
		// would drop the only record of operations that may need interruption.
		return true;
	}
}

/** C17: the failed descriptor is the only on-disk evidence of an OOM-class accident, so it is archived before deletion. */
function archiveAndReapFailedWorker(host: DaemonSupervisorReaperHost, worker: ResidentWorker, now: number): void {
	const descriptor = worker.descriptor;
	const failedAt = Date.parse(descriptor.lastFailureAt ?? descriptor.updatedAt);
	const failedForMinutes = Number.isFinite(failedAt) ? Math.round((now - failedAt) / 60_000) : undefined;
	host.log(
		`Reaped failed worker ${descriptor.workerId} (reaped failed worker: pid ${descriptor.pid}, ` +
			`processStartId ${descriptor.processStartId ?? "unknown"}, ` +
			`failedForMinutes ${failedForMinutes ?? "unknown"}, ` +
			`lastFailureAt ${descriptor.lastFailureAt ?? "unknown"}, ` +
			`lastError ${descriptor.lastError ?? "unknown"}, ` +
			`rootActiveSessionId ${descriptor.rootActiveSessionId}, ` +
			`rootSessionId ${descriptor.rootSessionId ?? "unknown"}, ` +
			`sessionFile ${descriptor.sessionFile ?? "unknown"}, ` +
			`descriptorPath ${worker.descriptorPath}, ` +
			`consecutiveFailures ${descriptor.consecutiveFailures})`,
	);
	host.workers.delete(descriptor.workerId);
	host.flipWorkerRosterEntriesInactive(worker);
	// L9F-1 / audit F2: this path used to delete the orphan journal without
	// reaping it (reclaimStaleWorkerRegistration reaps first), leaking the dead
	// worker's still-running bash children and leaving foreign dead records
	// active until the file went. Reap both halves before the delete.
	reapFailedWorkerOrphanJournal(host, worker);
	host.deleteWorkerDescriptor(worker);
	if (!host.shuttingDown) {
		host.broadcastHeartbeatsChanged();
	}
}

/**
 * L9F-1: the failed-worker reap path's journal cleanup. The owner half mirrors
 * `recoverUncertainWorkerOperations` (kill the dead worker's still-active bash
 * children, guarded by the same identity checks); the foreign half only retires
 * records whose pid is already gone, never killing anything a foreign writer
 * still owns. The journal itself still goes with the descriptor right after.
 */
function reapFailedWorkerOrphanJournal(host: DaemonSupervisorReaperHost, worker: ResidentWorker): void {
	const path = worker.descriptor.orphanProcessJournalPath;
	if (!path) {
		return;
	}
	try {
		for (const orphan of readActiveOrphanProcesses(path, worker.descriptor.pid)) {
			if (!shouldReapOrphanProcess(orphan)) {
				continue;
			}
			killOrphanProcess(orphan.pid);
		}
		reapForeignOrphanProcessRecords(path, worker.descriptor.pid);
	} catch (error) {
		host.log(`Could not reap orphan journal of failed worker ${worker.descriptor.workerId}: ${String(error)}`);
	}
}
