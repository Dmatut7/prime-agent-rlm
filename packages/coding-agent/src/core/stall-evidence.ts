import { join } from "node:path";
import { appendRotatingLog, getAgentLogPath, getLogsDir } from "../config.js";

/**
 * Stall evidence keeps its own bounded file next to `agent.jsonl`.
 *
 * The shared log rotates at 20MB and every session on the machine writes into it, so a stall
 * kill record - the one thing a post-mortem needs - can be rotated out by unrelated chatter
 * before anyone reads it. Stall records are rare and small, so giving them a dedicated file
 * with its own cap buys a hard retention floor (two generations of stall traffic, and nothing
 * else) for no measurable cost. The alternative, raising the category's priority inside the
 * shared log, cannot guarantee retention without making the rotator category-aware.
 */
export const STALL_EVIDENCE_MAX_BYTES = 512 * 1024;

export const STALL_EVIDENCE_BASENAME = "stall-evidence.jsonl";

/** Message prefix the stall watchdog logs under; the tee keeps the whole watchdog family. */
const STALL_EVIDENCE_MESSAGE_PREFIX = "stall watchdog:";

export function getStallEvidencePath(): string {
	return join(getLogsDir(), STALL_EVIDENCE_BASENAME);
}

export function isStallEvidenceMessage(message: string): boolean {
	return message.startsWith(STALL_EVIDENCE_MESSAGE_PREFIX);
}

/** Append one already-serialized log line. Best-effort: never throws into the logging sink. */
export function writeStallEvidenceLine(line: string): void {
	appendRotatingLog(getStallEvidencePath(), line, STALL_EVIDENCE_MAX_BYTES);
}

/** Where the stall diagnostics of this process actually land, and which runtime wrote them. */
export interface StallDiagnosticsPointer {
	/** Bounded stall-only evidence file. */
	evidencePath: string;
	/** Shared structured log (all sessions, all components). */
	agentLogPath: string;
	/** True when this process is a daemon worker; a direct run has no daemon at all. */
	daemonWorker: boolean;
}

let daemonWorkerRuntime = false;

/**
 * Record whether this process runs as a daemon worker. Set once at startup (see `main.ts`),
 * because the stall copy has to tell "check the shared log" apart from "there is no daemon
 * here" without every call site knowing which runtime it is in.
 */
export function setStallRuntimeDaemonWorker(value: boolean): void {
	daemonWorkerRuntime = value;
}

export function resolveStallDiagnosticsPointer(): StallDiagnosticsPointer {
	return {
		evidencePath: getStallEvidencePath(),
		agentLogPath: getAgentLogPath(),
		daemonWorker: daemonWorkerRuntime,
	};
}

/** The two files, with the filter that finds a stall record in the shared one. */
export function formatStallDiagnosticsWhere(pointer: StallDiagnosticsPointer): string {
	return (
		`${pointer.evidencePath} (stall-only, size-bounded) and ${pointer.agentLogPath} ` +
		`(all sessions; filter with: grep "stall watchdog" ${pointer.agentLogPath})`
	);
}

/**
 * Full pointer sentence for the warn copy. Names the real files and states the runtime, so a
 * reader is never sent to `logs/daemon.sock.*.log` - a file whose name says "daemon log" and
 * which never carries stall diagnostics.
 */
export function formatStallDiagnosticsPointer(pointer: StallDiagnosticsPointer): string {
	const where = formatStallDiagnosticsWhere(pointer);
	if (pointer.daemonWorker) {
		return (
			`This session runs inside a daemon worker. Stall diagnostics: ${where}. ` +
			"They are not in the daemon supervisor log (logs/daemon.sock.*.log), which never carries them."
		);
	}
	return `This session runs without a daemon, so there is no daemon log to check. Stall diagnostics: ${where}.`;
}

/** Short runtime clause for the abort copies, which already carry the file list. */
export function formatStallRuntimeClause(pointer: StallDiagnosticsPointer): string {
	return pointer.daemonWorker
		? " This session runs inside a daemon worker; the daemon supervisor log never carries stall diagnostics."
		: " This session runs without a daemon, so there is no daemon log.";
}
