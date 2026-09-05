import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { lockSync } from "proper-lockfile";
import { repairTruncatedTrailingLine } from "../utils/file-lines.js";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	/** Set on records written by a kernel (e.g. bash() children) so the host can reap per kernel. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	/** Missing on identity-free records: old journals or host writes whose start-id query failed (kernels no longer write pid-only records). */
	processStartId?: string;
	/** When the record was written; bounds pid-reuse checks for identity-free records. */
	recordedAt?: string;
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		// Host and kernels append to the same journal; hold the guard across
		// repair+append so a crash-torn tail from one writer cannot glue onto
		// another writer's record. Lock failures stay best-effort (outer catch).
		// proper-lockfile requires the lock target to exist; create it first (a
		// symlinked journal is refused by O_NOFOLLOW and skipped).
		const touch = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
		closeSync(touch);
		let release: (() => void) | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				release = lockSync(path, {
					realpath: false,
					lockfilePath: `${path}.guard`,
					stale: 5000,
				});
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
				if (attempt === 19) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		if (!release) throw new Error(`Could not lock orphan process journal: ${path}`);
		const releaseLock = release;
		try {
			// A crash can leave a torn final line; readers skip it, so drop it before
			// the append glues onto it.
			repairTruncatedTrailingLine(path);
			const descriptor = openSync(
				path,
				constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				// Repair legacy 0644 journals: the create mode only applies to new files.
				if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
				writeSync(descriptor, `${JSON.stringify(record)}\n`);
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		} finally {
			releaseLock();
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<number, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as OrphanProcessRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	// Pid-only actives (no processStartId) still surface from old journals or
	// host writes whose start-id query failed; reapers decide per-platform.
	return [...latest.values()]
		.filter(
			(record) =>
				record.active && (record.processStartId === undefined || typeof record.processStartId === "string"),
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
			...(typeof record.recordedAt === "string" ? { recordedAt: record.recordedAt } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	// Pid-only records can never claim identity (undefined === undefined must not match).
	return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}

/**
 * A reused pid must not be killed for an identity-free record. When the start
 * id is a ps lstart stamp (macOS/BSD), a process that only started after the
 * record was written cannot be the journaled one. Unparseable sources keep the
 * historical best-effort behavior.
 */
export function isOrphanPidReused(
	orphan: ActiveOrphanProcess,
	query: (pid: number) => string | undefined = getProcessStartId,
): boolean {
	if (!orphan.recordedAt) return false;
	const recorded = Date.parse(orphan.recordedAt);
	if (Number.isNaN(recorded)) return false;
	const startId = query(orphan.pid);
	if (typeof startId !== "string" || !startId.startsWith("ps:")) return false;
	const started = Date.parse(startId.slice("ps:".length));
	if (Number.isNaN(started)) return false;
	return started > recorded;
}

/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there), except when the pid demonstrably belongs to a
 * process younger than the record.
 */
export function shouldReapOrphanProcess(
	orphan: ActiveOrphanProcess,
	query: (pid: number) => string | undefined = getProcessStartId,
): boolean {
	if (orphan.processStartId === undefined) {
		if (process.platform === "win32") return false;
		return !isOrphanPidReused(orphan, query);
	}
	return isOrphanProcessIdentityCurrent(orphan);
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(kernelPid: number): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return;
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return;
	}
	for (const orphan of orphans) {
		if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
			continue;
		}
		if (!shouldReapOrphanProcess(orphan)) {
			continue;
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (killOrphanProcess(orphan.pid)) {
			recordOrphanProcessState(orphan.pid, false);
		}
	}
}

// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
		const result = spawnSync(
			win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// The orphan may already have exited.
		}
	}
	return false;
}
