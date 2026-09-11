import { createConnection } from "node:net";

/**
 * P1-7b, 250ms tier: a worker decides its supervisor is gone.
 *
 * One 250ms connect probe decided it, so a supervisor that was merely slow to
 * accept (a busy event loop, a machine under load) was declared dead and every
 * worker on the host raced to launch a replacement — the `Lock file is already
 * being held` storm. Death now takes `SUPERVISOR_PROBE_ATTEMPTS` consecutive
 * failures, and the recheck between rounds backs off instead of polling at a
 * fixed 5s forever.
 */
export const SUPERVISOR_PROBE_TIMEOUT_MS = 250;
export const SUPERVISOR_PROBE_ATTEMPTS = 3;
export const SUPERVISOR_PROBE_INTERVAL_MS = 250;
/** Recheck ladder after a failed round: 5s, 10s, 20s, then the cap. */
export const SUPERVISOR_RECHECK_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000];
export const SUPERVISOR_RECHECK_MAX_MS = 60_000;
/** A shutdown admission in progress is not a failure: recheck at the first ladder step. */
export const SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS = SUPERVISOR_RECHECK_BACKOFF_MS[0]!;

export interface SupervisorProbeResult {
	available: boolean;
	/** Probes made in the last round; a round that connects early stops probing. */
	attempts: number;
}

export interface SupervisorProbeOptions {
	attempts?: number;
	probeTimeoutMs?: number;
	intervalMs?: number;
	/** Injectable so a test can fail the first probe and answer the second, deterministically. */
	connect?: (socketPath: string, timeoutMs: number) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	/** Checked between attempts; a shutdown or an authenticated connection ends the round early. */
	isCancelled?: () => boolean;
	onFailedAttempt?: (attempt: number, attempts: number) => void;
}

/** One connect probe: true when the supervisor socket accepts within the timeout. */
export function connectProbeSupervisor(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(connected);
		};
		const timeout = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function probeSupervisorAvailability(
	socketPath: string,
	options: SupervisorProbeOptions = {},
): Promise<SupervisorProbeResult> {
	const attempts = Math.max(1, options.attempts ?? SUPERVISOR_PROBE_ATTEMPTS);
	const probeTimeoutMs = options.probeTimeoutMs ?? SUPERVISOR_PROBE_TIMEOUT_MS;
	const intervalMs = options.intervalMs ?? SUPERVISOR_PROBE_INTERVAL_MS;
	const connect = options.connect ?? connectProbeSupervisor;
	const wait = options.sleep ?? sleep;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.isCancelled?.() === true) {
			return { available: false, attempts: attempt - 1 };
		}
		if (await connect(socketPath, probeTimeoutMs)) {
			return { available: true, attempts: attempt };
		}
		options.onFailedAttempt?.(attempt, attempts);
		if (attempt < attempts) {
			await wait(intervalMs);
		}
	}
	return { available: false, attempts };
}

/** Delay before the next availability round, given how many rounds failed in a row. */
export function supervisorRecheckDelayMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) {
		return SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS;
	}
	const index = consecutiveFailures - 1;
	return index < SUPERVISOR_RECHECK_BACKOFF_MS.length
		? (SUPERVISOR_RECHECK_BACKOFF_MS[index] ?? SUPERVISOR_RECHECK_MAX_MS)
		: SUPERVISOR_RECHECK_MAX_MS;
}

export interface SupervisorAvailabilityDeps {
	probe(socketPath: string): Promise<SupervisorProbeResult>;
	launchReplacement(socketPath: string): Promise<void>;
	/** True once the supervisor authenticated to this worker, which ends the monitoring. */
	isConnected(): boolean;
	isShuttingDown(): boolean;
	isShutdownAdmissionActive(): Promise<boolean>;
}

/** Rounds that failed in a row; the worker owns it across checks so the backoff can grow. */
export interface SupervisorAvailabilityState {
	consecutiveFailures: number;
}

export interface SupervisorAvailabilityOutcome {
	/** Delay before the next round, or undefined when monitoring should stop. */
	nextDelayMs?: number;
	probe?: SupervisorProbeResult;
	launchedReplacement: boolean;
}

/**
 * One monitoring round: probe, and only launch a replacement when the whole
 * round failed. The caller reschedules with `nextDelayMs`.
 */
export async function checkSupervisorAvailability(
	socketPath: string,
	state: SupervisorAvailabilityState,
	deps: SupervisorAvailabilityDeps,
): Promise<SupervisorAvailabilityOutcome> {
	if (deps.isShuttingDown() || deps.isConnected()) {
		return { launchedReplacement: false };
	}
	if (await deps.isShutdownAdmissionActive()) {
		return { nextDelayMs: SUPERVISOR_SHUTDOWN_ADMISSION_RECHECK_MS, launchedReplacement: false };
	}
	const probe = await deps.probe(socketPath);
	if (probe.available) {
		state.consecutiveFailures = 0;
		return { probe, launchedReplacement: false };
	}
	state.consecutiveFailures++;
	await deps.launchReplacement(socketPath);
	if (deps.isShuttingDown() || deps.isConnected()) {
		return { probe, launchedReplacement: true };
	}
	return { probe, launchedReplacement: true, nextDelayMs: supervisorRecheckDelayMs(state.consecutiveFailures) };
}
