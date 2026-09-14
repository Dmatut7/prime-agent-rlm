// Retention roots, report persistence, and the status view.
//
// Two artifacts, both under `<agentDir>/retention/`:
//   * `last-sweep.json` - the full machine-readable report of the last sweep,
//     skip reasons included (design section 4.1).
//   * `history.jsonl` - one compact line per sweep, bounded to the most recent
//     HISTORY_LIMIT sweeps, which is what the "is the defect account going down"
//     reading and the stalled-class test use.
//
// Writing is best effort: a retention sweep must not fail because a report could
// not be written, and the sweep report is returned to the caller either way.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, getSessionsDir } from "../../config.js";
import { appendPrivateFile, ensurePrivateDirectory, writePrivateFileAtomicLines } from "../../utils/private-files.js";
import { getKernelVenvDir } from "../kernel/bootstrap.js";
import { SESSION_ARTIFACTS_DIR_NAME } from "../session-info-disk-cache.js";
import type { RetentionRoots, RetentionSweepReport } from "./types.js";

export const RETENTION_DIR_NAME = "retention";
export const LAST_SWEEP_FILE_NAME = "last-sweep.json";
export const HISTORY_FILE_NAME = "history.jsonl";
const HISTORY_LIMIT = 200;

/** The roots one sweep works on, derived the same way the native code derives them. */
export function retentionRoots(options: { agentDir?: string } = {}): RetentionRoots {
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);
	return {
		agentDir,
		sessionsDir,
		// The artifact root is a sibling of the session directory (an env override of
		// the session dir moves both), which is exactly how the session manager
		// derives it: getSessionArtifactsRoot(dirname(sessionDir)).
		artifactRoot: join(dirname(sessionsDir), SESSION_ARTIFACTS_DIR_NAME),
		// Derived from agentDir (not getLogsDir()) so a sweep of one agent dir cannot
		// reach the logs of another; the default agent dir resolves to the same path.
		logsDir: join(agentDir, "logs"),
		tmpDir: tmpdir(),
		leasesRoot: join(agentDir, "session-leases"),
		retentionDir: join(agentDir, RETENTION_DIR_NAME),
		kernelVenvBase: getKernelVenvDir(),
	};
}

export function lastSweepPath(roots: RetentionRoots): string {
	return join(roots.retentionDir, LAST_SWEEP_FILE_NAME);
}

export function retentionHistoryPath(roots: RetentionRoots): string {
	return join(roots.retentionDir, HISTORY_FILE_NAME);
}

/** Compact form for the history line: the skipped list is dropped, the counts stay. */
function compactReport(report: RetentionSweepReport): RetentionSweepReport {
	return {
		...report,
		classes: report.classes.map((entry) => ({ ...entry, skipped: [] })),
	};
}

export function writeRetentionReport(roots: RetentionRoots, report: RetentionSweepReport): void {
	try {
		ensurePrivateDirectory(roots.retentionDir);
	} catch {
		return;
	}
	try {
		writePrivateFileAtomicLines(lastSweepPath(roots), `${JSON.stringify(report, null, 1)}\n`);
	} catch {
		// The report is returned to the caller even when it cannot be persisted.
	}
	try {
		const history = readRetentionHistory(roots);
		const next = [...history, compactReport(report)].slice(-HISTORY_LIMIT);
		if (history.length >= HISTORY_LIMIT) {
			writePrivateFileAtomicLines(
				retentionHistoryPath(roots),
				`${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
		} else {
			appendPrivateFile(retentionHistoryPath(roots), `${JSON.stringify(compactReport(report))}\n`, {
				privateParent: true,
			});
		}
	} catch {
		// History is diagnostic; losing a line must not fail a sweep.
	}
}

function parseReport(line: string): RetentionSweepReport | undefined {
	try {
		const parsed = JSON.parse(line) as RetentionSweepReport;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		if (!Array.isArray(parsed.classes) || typeof parsed.at !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function readRetentionHistory(roots: RetentionRoots): RetentionSweepReport[] {
	let raw: string;
	try {
		raw = readFileSync(retentionHistoryPath(roots), "utf8");
	} catch {
		return [];
	}
	const reports: RetentionSweepReport[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const report = parseReport(line);
		if (report) reports.push(report);
	}
	return reports;
}

export function readLastRetentionReport(roots: RetentionRoots): RetentionSweepReport | undefined {
	try {
		const raw = readFileSync(lastSweepPath(roots), "utf8");
		const parsed = parseReport(raw);
		if (parsed) return parsed;
	} catch {
		// Fall through to the history tail.
	}
	return readRetentionHistory(roots).slice(-1)[0];
}

export interface RetentionStatus {
	roots: RetentionRoots;
	lastSweepAt?: string;
	lastSweep?: RetentionSweepReport;
	/** Bytes the artifact tree currently holds, and how much of it is candidate-bearing. */
	artifactRootPresent: boolean;
	historySweeps: number;
}

export function retentionStatus(roots: RetentionRoots): RetentionStatus {
	const lastSweep = readLastRetentionReport(roots);
	return {
		roots,
		...(lastSweep ? { lastSweepAt: lastSweep.at, lastSweep } : {}),
		artifactRootPresent: existsSync(roots.artifactRoot),
		historySweeps: readRetentionHistory(roots).length,
	};
}
