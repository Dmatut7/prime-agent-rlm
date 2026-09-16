// The one entry point every trigger shares: CLI, daemon interval, and tests.
//
// Two guards, one per concurrency domain. The in-process one mirrors the
// failed-worker reaper (daemon-supervisor.ts): a second trigger while a sweep is
// running returns the running sweep instead of walking the tree twice. Across
// processes that guard is invisible, so a daemon tick and an operator's
// `retention sweep` - or two daemons sharing one agent dir - would each walk the
// tree, each spend the per-sweep circuit breaker, and each read-modify-write
// history.jsonl. The sweep guard below is what serializes them; it is the
// session-lease "guard plus owner record" shape, cropped to a short critical
// section (r41 plan, ADC-3 candidate 3A).
//
// What the guard protects is the ACCOUNT, not the delete: a candidate is only
// removed after its class judgement, its signature re-check and a rename-then-remove
// (delete.ts). So a guard may be stale-broken by the next acquirer, and it may be
// unavailable altogether, and the sweep still has to run - a machine whose retention
// dir cannot hold a lock must keep cleaning, because stopped cleanup is the failure
// the sweep exists to prevent. That is also why `stale` can sit generous and why a
// non-contention lock failure degrades to an unlocked sweep with one log line.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getLogger } from "@earendil-works/pi-ai";
import { lockSync } from "proper-lockfile";
import { getAgentDir } from "../../config.js";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../../utils/private-files.js";
import { SettingsManager } from "../settings-manager.js";
import {
	readLastRetentionReport,
	retentionRoots,
	sweepGuardPath,
	sweepInProgressPath,
	writeRetentionReport,
} from "./reports.js";
import { runRetentionSweep } from "./sweep.js";
import type { ResolvedRetentionSettings, RetentionRoots, RetentionSweepReport } from "./types.js";

const retentionLog = getLogger("coding-agent.core.retention");

/**
 * How long a guard may go un-refreshed before the next trigger breaks it.
 *
 * One sweep is bounded by the circuit breaker (512 MiB / 20000 entries) and measures
 * seconds to minutes on a real tree, so 30 minutes sits an order of magnitude above
 * any honest run: a live sweep is never stolen from, while a holder that died wedges
 * retention for at most half the default sweep interval (`sweepIntervalMinutes: 60`).
 * Guessing low costs a jittered account; guessing high costs cleanup. Proper-lockfile
 * floors `stale` at 2s and refreshes the guard mtime at half of it, so a sweep that
 * really does run past 15 minutes keeps its guard alive.
 */
const SWEEP_GUARD_STALE_MS = 30 * 60_000;

/** Names of the guard files, part of this module's on-disk contract. */
export { SWEEP_GUARD_FILE_NAME, SWEEP_IN_PROGRESS_FILE_NAME } from "./reports.js";

let inFlight: Promise<RetentionSweepOutcome> | undefined;
let lastReport: RetentionSweepReport | undefined;

export interface RetentionRunOptions {
	agentDir?: string;
	/** Force a dry run for this sweep (CLI flag or the env rollback lever). */
	dryRun?: boolean;
	/** Pre-resolved settings; the default reads the process settings. */
	settings?: ResolvedRetentionSettings;
	now?: number;
	/** Resident sessions, when the caller is a daemon that knows them. */
	residentSessionIds?: ReadonlySet<string>;
	activeLeaseDirectories?: ReadonlySet<string>;
}

/**
 * What one trigger of the shared entry point did, and why.
 *
 * Both callers branch on `lockHeld`: a CLI prints the report it did not produce, and
 * a daemon tick must not advance its cadence clock for a sweep that never ran.
 */
export interface RetentionSweepOutcome {
	/** True when nothing swept, because another process holds the guard. */
	lockHeld: boolean;
	/** True when a guard was wanted and this trigger swept without one, because it
	 *  could not be taken. A guard switched off by `retention.sweepLockEnabled` is a
	 *  choice, not a failure, and reports false. */
	lockUnavailable: boolean;
	/** The report this call swept and persisted; absent exactly when `lockHeld` is true. */
	report?: RetentionSweepReport;
	/** The report already on record, returned when `lockHeld` so a trigger can answer. */
	lastReport?: RetentionSweepReport;
	/** Who holds the guard, from the owner record, when that record is readable. */
	holder?: string;
}

interface SweepGuard {
	release: () => void;
	/** True once the guard has been reported stolen from under this sweep. */
	lost: () => boolean;
}

type GuardAcquisition =
	| { status: "acquired"; guard: SweepGuard }
	| { status: "contended"; holder?: string }
	| { status: "unavailable"; detail: string };

export function resolveRetentionSettingsForProcess(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): ResolvedRetentionSettings {
	return SettingsManager.create(cwd, agentDir).getRetentionSettings();
}

/** True while a sweep is running, so a caller can skip scheduling another. */
export function retentionSweepInFlight(): boolean {
	return inFlight !== undefined;
}

export function lastRetentionSweepReport(): RetentionSweepReport | undefined {
	return lastReport;
}

/** The owner record as a trigger can name it: `pid 4242 since <ISO start time>`. */
function describeSweepHolder(roots: RetentionRoots): string | undefined {
	let record: { pid?: unknown; startedAt?: unknown };
	try {
		record = JSON.parse(readFileSync(sweepInProgressPath(roots), "utf8")) as {
			pid?: unknown;
			startedAt?: unknown;
		};
	} catch {
		// No record, or an unreadable one: the guard still says someone is inside.
		return undefined;
	}
	const pid = typeof record.pid === "number" ? String(record.pid) : "unknown";
	const startedAt = typeof record.startedAt === "string" ? record.startedAt : "unknown";
	return `pid ${pid} since ${startedAt}`;
}

/** Best-effort owner record. Nothing decides anything with it; it only names a holder. */
function publishSweepHolder(roots: RetentionRoots): void {
	try {
		const record = { pid: process.pid, startedAt: new Date().toISOString(), agentDir: roots.agentDir };
		writePrivateFileAtomic(sweepInProgressPath(roots), JSON.stringify(record, null, 1));
	} catch {
		// A holder that cannot publish its name is still holding the guard.
	}
}

function acquireSweepGuard(roots: RetentionRoots): GuardAcquisition {
	let lost = false;
	let release: (() => void) | undefined;
	try {
		// The guard directory lives inside the retention dir. Create that only when it
		// is missing: `ensurePrivateDirectory` also re-tightens a mode, which would
		// turn an intentionally read-only retention dir into a writable one and hide
		// the very condition the degrade path exists for.
		if (!existsSync(roots.retentionDir)) ensurePrivateDirectory(roots.retentionDir);
		release = lockSync(roots.retentionDir, {
			realpath: false,
			lockfilePath: sweepGuardPath(roots),
			stale: SWEEP_GUARD_STALE_MS,
			// Explicit, and it must not throw: proper-lockfile's default rethrows from a
			// timer callback, which would take a daemon down over a bookkeeping lock.
			// A lost guard is reported and handled as contention wherever a decision is
			// still open.
			onCompromised: () => {
				lost = true;
			},
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "lock-error";
		if (code === "ELOCKED") return { status: "contended", holder: describeSweepHolder(roots) };
		return { status: "unavailable", detail: `${code}: ${String((error as Error).message ?? error)}` };
	}
	if (lost) {
		// Broken before the critical section began: someone else owns the accounts now.
		try {
			release?.();
		} catch {
			// The guard is no longer ours to release.
		}
		return { status: "contended", holder: describeSweepHolder(roots) };
	}
	publishSweepHolder(roots);
	return {
		status: "acquired",
		guard: {
			lost: () => lost,
			release: () => {
				try {
					release?.();
				} catch {
					// Already removed by whoever broke the stale guard; nothing to release.
				}
			},
		},
	};
}

export async function runRetentionSweepOnce(options: RetentionRunOptions = {}): Promise<RetentionSweepOutcome> {
	if (inFlight) {
		return inFlight;
	}
	const promise = (async (): Promise<RetentionSweepOutcome> => {
		const roots = retentionRoots({ ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
		const settings = options.settings ?? resolveRetentionSettingsForProcess();
		if (!settings.sweepLockEnabled) {
			// The rollback lever: take no guard at all, i.e. exactly the behaviour of
			// every sweep before this one. A choice, not a failed lock.
			return { lockHeld: false, lockUnavailable: false, report: await sweep(roots, settings, options) };
		}
		const acquired = acquireSweepGuard(roots);
		if (acquired.status === "contended") {
			return {
				lockHeld: true,
				lockUnavailable: false,
				lastReport: readLastRetentionReport(roots) ?? lastReport,
				...(acquired.holder ? { holder: acquired.holder } : {}),
			};
		}
		if (acquired.status === "unavailable") {
			retentionLog.warn(`retention sweep running unlocked, sweep guard unavailable: ${acquired.detail}`);
		}
		const guard = acquired.status === "acquired" ? acquired.guard : undefined;
		try {
			const report = await sweep(roots, settings, options);
			if (guard?.lost()) {
				// This sweep already deleted; withholding its report would hide that, so
				// the account is still written and the interleaving risk is logged.
				retentionLog.warn("retention sweep guard was stolen mid-sweep: the history account may have interleaved");
			}
			return { lockHeld: false, lockUnavailable: acquired.status === "unavailable", report };
		} finally {
			if (guard) {
				try {
					rmSync(sweepInProgressPath(roots), { force: true });
				} catch {
					// A leftover owner record only names a sweep that has finished.
				}
				guard.release();
			}
		}
	})().finally(() => {
		inFlight = undefined;
	});
	inFlight = promise;
	return promise;
}

/** One guarded sweep: walk every class, then persist the report inside the guard. */
async function sweep(
	roots: RetentionRoots,
	settings: ResolvedRetentionSettings,
	options: RetentionRunOptions,
): Promise<RetentionSweepReport> {
	const report = await runRetentionSweep({
		settings,
		roots,
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.dryRun ? { forceDryRun: true } : {}),
		...(options.residentSessionIds ? { residentSessionIds: options.residentSessionIds } : {}),
		...(options.activeLeaseDirectories ? { activeLeaseDirectories: options.activeLeaseDirectories } : {}),
		log: (line) => retentionLog.info(line),
	});
	// Inside the guard on purpose: history.jsonl's >=HISTORY_LIMIT branch reads the
	// whole file back and rewrites it, and that read-modify-write is what this lock
	// serializes into a structural guarantee instead of a race.
	writeRetentionReport(roots, report);
	lastReport = report;
	return report;
}
