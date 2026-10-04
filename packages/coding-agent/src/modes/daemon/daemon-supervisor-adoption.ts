/**
 * Adoption cluster extracted from daemon-supervisor.ts (wave-50, the second
 * Host-seam cut on the supervisor after the wave-48 warm pool): startup
 * adoption of descriptor-registered workers runs off the ready critical path
 * (L3), and a failed worker whose sessions still carry a heartbeat or cron
 * registration is re-adopted on a bounded backoff instead of staying parked
 * dark. The moved methods keep exactly the same bodies; they read the
 * supervisor through {@link DaemonSupervisorAdoptionHost}, so the move changes
 * no runtime behavior. The five entry points with callers outside the cluster
 * keep one-line shells on the class (beginWorkerAdoption /
 * armScheduledJobReadoption / workerHasScheduledJobs / workerHasAttachedClient
 * / clearAdoptionRetryTimers) so instance-level dispatch — including
 * prototype-harness stubs that shadow those names — is preserved exactly.
 * Cluster-internal helpers (runWorkerAdoption / adoptWorkerContained /
 * containAdoptionFailure / recordAdoptionFailure / retryWorkerAdoption /
 * finishAdoptionAttempt / reportAdoptionOutcome) are module-private and called
 * directly — no test or caller ever named them on the class. The public getter
 * `adoptingSessionWorkers` had zero references repo-wide, so it was deleted in
 * this move instead of being shelled (registered removal decision, wave-35
 * precedent).
 *
 * Same adaptations as the warm-pool cut: DaemonSupervisor members are
 * `private`-keyworded (unlike AgentSession's underscore-public convention), so
 * `this` cannot satisfy the host interface structurally — the class instead
 * exposes `adoptionHost`, a facade of live getters and arrows built inside the
 * class (no casts, no visibility changes). And the adoption bookkeeping
 * (pending count, counted-worker set, retry timers, failure list, reported
 * flag) moved with the cluster as {@link DaemonAdoptionState}; the class holds
 * one lazily-created instance, preserving the prototype-harness semantics of
 * supervisors that bypass the constructor.
 *
 * Unlike the warm-pool module, this one carries a value-level import back into
 * ./daemon-supervisor.js (isSupervisorRecoveryCancelled); the binding is only
 * touched inside function bodies, so the module-evaluation cycle is inert.
 * Everything else from the supervisor is imported as types only.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_SCHEDULED_JOBS_FILENAME } from "../../core/cron-jobs.js";
import { getSessionArtifactPathForFile } from "../../core/session-manager.js";
import { type DaemonSupervisor, isSupervisorRecoveryCancelled, type ResidentWorker } from "./daemon-supervisor.js";

// L3: how many workers are adopted concurrently once the socket is already open.
const ADOPTION_CONCURRENCY = 4;

/**
 * The adoption bookkeeping, moved out of the supervisor with the cluster. The
 * class holds one lazily-created instance: prototype-harness supervisors in
 * tests bypass the constructor, and every reader (daemon_hello's `adopting`
 * count, the reap-candidate check, findWorker's recovering window) must see an
 * empty, zeroed seat there instead of throwing.
 */
export class DaemonAdoptionState {
	/** Workers still being adopted; published as daemon_hello.adopting so a partial startup is visible. */
	pendingCount = 0;
	/** The workers the startup count was opened for, so a runtime re-adoption cannot skew it. */
	readonly countedWorkers = new Set<ResidentWorker>();
	readonly retryTimers = new Map<ResidentWorker, NodeJS.Timeout>();
	readonly failures: Array<{ workerId: string; session: string; reason: string }> = [];
	reported = false;
}

/**
 * The seam of DaemonSupervisor the extracted adoption cluster reads and calls.
 * Member types mirror the class's own members via indexed access so a rename
 * on the class fails here at compile time. The class satisfies this with the
 * `adoptionHost` facade (its members are `private`-keyworded, so the instance
 * itself cannot be the host structurally); every member is read live through a
 * getter or arrow, never snapshotted. The seam is read-only/call-only: the
 * cluster mutates only its own state seat, its argument's worker record, and
 * (through tryPersistWorker / markWorkerRosterEntries) the persisted
 * descriptor and roster — exactly what the methods did on the class.
 */
export interface DaemonSupervisorAdoptionHost {
	readonly adoptionState: DaemonAdoptionState;
	readonly workers: DaemonSupervisor["workers"];
	readonly clients: DaemonSupervisor["clients"];
	readonly shuttingDown: DaemonSupervisor["shuttingDown"];
	readonly adoptionRequestTimeoutMs: DaemonSupervisor["adoptionRequestTimeoutMs"];
	readonly adoptionRetryDelaysMs: DaemonSupervisor["adoptionRetryDelaysMs"];
	background: DaemonSupervisor["background"];
	log: DaemonSupervisor["log"];
	recordDegraded: DaemonSupervisor["recordDegraded"];
	tryPersistWorker: DaemonSupervisor["tryPersistWorker"];
	markWorkerRosterEntries: DaemonSupervisor["markWorkerRosterEntries"];
	workerRosterEntries: DaemonSupervisor["workerRosterEntries"];
	adoptOrRecoverWorker: DaemonSupervisor["adoptOrRecoverWorker"];
}

/**
 * L3: adoption runs off the ready critical path. The socket is already open and
 * `markReady()` has run, so a worker that never answers cannot keep the whole
 * daemon from serving; its sessions answer as recovering until it lands.
 */
export function beginWorkerAdoption(host: DaemonSupervisorAdoptionHost, workers: readonly ResidentWorker[]): void {
	if (workers.length === 0) {
		return;
	}
	const state = host.adoptionState;
	state.pendingCount = workers.length;
	for (const worker of workers) {
		state.countedWorkers.add(worker);
	}
	host.background(runWorkerAdoption(host, workers), "worker adoption");
}

async function runWorkerAdoption(
	host: DaemonSupervisorAdoptionHost,
	workers: readonly ResidentWorker[],
): Promise<void> {
	const queue = [...workers];
	const lanes: Array<Promise<void>> = [];
	const concurrency = Math.max(1, Math.min(ADOPTION_CONCURRENCY, queue.length));
	for (let lane = 0; lane < concurrency; lane++) {
		lanes.push(
			(async () => {
				while (queue.length > 0 && !host.shuttingDown) {
					const worker = queue.shift();
					if (!worker) {
						return;
					}
					const retryArmed = await adoptWorkerContained(host, worker);
					if (!retryArmed) {
						finishAdoptionAttempt(host, worker);
					}
				}
			})(),
		);
	}
	await Promise.all(lanes);
	reportAdoptionOutcome(host);
}

/**
 * Adopts one worker and contains every outcome: startup must not fail because a
 * single worker cannot be adopted (L3). Returns true when a backoff re-adoption
 * was armed for a session that has scheduled jobs behind it.
 */
async function adoptWorkerContained(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker): Promise<boolean> {
	let reason: string | undefined;
	try {
		await host.adoptOrRecoverWorker(worker);
		// "recovering" is not a failure: the recovery machinery owns the worker from
		// here and re-parks or retries it itself. An intentional stop is a completed
		// adoption of a tombstone.
		if (
			worker.descriptor.lifecycle !== "ready" &&
			worker.descriptor.lifecycle !== "recovering" &&
			worker.descriptor.stopRequestedAt === undefined
		) {
			reason = worker.descriptor.lastError ?? `Worker stayed ${worker.descriptor.lifecycle}`;
		}
	} catch (error) {
		if (host.shuttingDown || isSupervisorRecoveryCancelled(error)) {
			return false;
		}
		reason = error instanceof Error ? error.message : String(error);
	}
	if (reason === undefined) {
		return false;
	}
	return containAdoptionFailure(host, worker, reason);
}

/**
 * One unadoptable worker parks failed on its own instead of taking the daemon
 * down with it. A worker whose sessions have a heartbeat or cron registration is
 * re-adopted on a backoff first: parking it would silently stop an unattended
 * schedule, which nobody would notice because the daemon itself looks healthy.
 */
function containAdoptionFailure(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker, reason: string): boolean {
	recordAdoptionFailure(host, worker, reason);
	if (/\bTimed out\b/.test(reason)) {
		// Production signature for a bounded adoption that hit its ceiling (F14).
		host.log(
			`Worker adoption timed out for ${worker.descriptor.workerId} after ${host.adoptionRequestTimeoutMs}ms: ${reason}`,
		);
	}
	if (worker.descriptor.lifecycle !== "failed") {
		worker.descriptor.lifecycle = "failed";
		worker.descriptor.lastError = reason;
		// Preserve the first failure time: the reaper ages a corpse from it, and a
		// restart that re-parks the same dead worker must not reset that clock.
		worker.descriptor.lastFailureAt ??= new Date().toISOString();
		host.tryPersistWorker(worker, "adoption failure");
		host.markWorkerRosterEntries(worker, "failed");
	}
	return armScheduledJobReadoption(host, worker, reason);
}

function recordAdoptionFailure(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker, reason: string): void {
	const workerId = worker.descriptor.workerId;
	const state = host.adoptionState;
	if (state.failures.some((failure) => failure.workerId === workerId)) {
		return;
	}
	state.failures.push({
		workerId,
		session: worker.descriptor.rootSessionId ?? worker.descriptor.rootActiveSessionId,
		reason,
	});
}

export function armScheduledJobReadoption(
	host: DaemonSupervisorAdoptionHost,
	worker: ResidentWorker,
	reason: string,
): boolean {
	const state = host.adoptionState;
	if (host.shuttingDown || state.retryTimers.has(worker)) {
		return false;
	}
	// An intentional stop must stay stopped; only unexpected failures are retried.
	if (worker.descriptor.stopRequestedAt !== undefined || worker.intentionalStop) {
		return false;
	}
	// A client-owned worker is re-driven by its owner's next attach; re-adopting it
	// here would only re-park it until that client shows up.
	if (worker.descriptor.ownerClientId !== undefined) {
		return false;
	}
	if (!workerHasScheduledJobs(host, worker)) {
		return false;
	}
	const attempt = worker.adoptionRetryAttempt ?? 0;
	const delayMs = host.adoptionRetryDelaysMs[attempt];
	if (delayMs === undefined) {
		host.recordDegraded("scheduled session not re-adopted");
		host.log(
			`Worker ${worker.descriptor.workerId} stayed failed after ${host.adoptionRetryDelaysMs.length} re-adoption attempts (${reason}); ` +
				`its scheduled sessions stay dark until a client attaches or retry_worker runs`,
		);
		return false;
	}
	worker.adoptionRetryAttempt = attempt + 1;
	host.log(
		`Re-adopting worker ${worker.descriptor.workerId} in ${Math.round(delayMs / 1000)}s because its sessions have scheduled jobs ` +
			`(attempt ${attempt + 1}/${host.adoptionRetryDelaysMs.length}): ${reason}`,
	);
	const timer = setTimeout(() => {
		state.retryTimers.delete(worker);
		host.background(retryWorkerAdoption(host, worker), `worker re-adoption for ${worker.descriptor.workerId}`);
	}, delayMs);
	timer.unref();
	state.retryTimers.set(worker, timer);
	return true;
}

async function retryWorkerAdoption(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker): Promise<void> {
	if (host.shuttingDown || host.workers.get(worker.descriptor.workerId) !== worker) {
		finishAdoptionAttempt(host, worker);
		return;
	}
	// A re-adoption starts from the parked state, so recovery is allowed to run again.
	worker.deferredRecoveryRounds = 0;
	const retryArmed = await adoptWorkerContained(host, worker);
	if (!retryArmed) {
		finishAdoptionAttempt(host, worker);
	}
}

function finishAdoptionAttempt(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker): void {
	const state = host.adoptionState;
	if (state.countedWorkers.delete(worker)) {
		state.pendingCount = Math.max(0, state.pendingCount - 1);
	}
}

/**
 * M12①: a startup that no longer fails loudly has to report what it could not
 * restore, with the reason and the action that brings a session back.
 */
function reportAdoptionOutcome(host: DaemonSupervisorAdoptionHost): void {
	const state = host.adoptionState;
	if (state.reported) {
		return;
	}
	state.reported = true;
	const failures = state.failures;
	if (failures.length === 0) {
		return;
	}
	const detail = failures.map((failure) => `${failure.session} (worker ${failure.workerId}): ${failure.reason}`);
	host.log(
		`Daemon started with ${failures.length} session${failures.length === 1 ? "" : "s"} unrestored: ${detail.join("; ")}. ` +
			`Each stays registered as failed; attach the session or run retry_worker to bring it back, ` +
			`and the failed-worker reaper archives it once it is old enough.`,
	);
}

/** Whether a heartbeat or cron registration behind this worker's sessions still needs it. */
export function workerHasScheduledJobs(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker): boolean {
	for (const entry of host.workerRosterEntries(worker)) {
		if (entry.summary.hasRegisteredHeartbeat === true || entry.summary.hasRegisteredCronJob === true) {
			return true;
		}
	}
	const sessionFile = worker.descriptor.sessionFile;
	const sessionId = worker.descriptor.rootSessionId;
	if (!sessionFile || !sessionId) {
		return false;
	}
	try {
		const artifactDir = getSessionArtifactPathForFile(resolve(sessionFile), sessionId);
		return existsSync(join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME));
	} catch {
		// An unreadable artifact directory must not decide the policy either way.
		return false;
	}
}

export function workerHasAttachedClient(host: DaemonSupervisorAdoptionHost, worker: ResidentWorker): boolean {
	const activeSessionIds = new Set(
		host.workerRosterEntries(worker).map((entry) => entry.summary.activeSessionId ?? entry.summary.id),
	);
	if (activeSessionIds.size === 0) {
		return false;
	}
	for (const client of host.clients) {
		for (const activeSessionId of client.attachedActiveSessionIds) {
			if (activeSessionIds.has(activeSessionId)) {
				return true;
			}
		}
	}
	return false;
}

export function clearAdoptionRetryTimers(host: DaemonSupervisorAdoptionHost): void {
	const state = host.adoptionState;
	for (const timer of state.retryTimers.values()) {
		clearTimeout(timer);
	}
	state.retryTimers.clear();
}
