import { type LogEntry, setLogSink, stringifyLogEntry } from "@earendil-works/pi-ai";
import { appendRotatingLog, getAgentLogPath } from "../config.js";
import { isStallEvidenceMessage, writeStallEvidenceLine } from "./stall-evidence.js";

const AGENT_LOG_MAX_BYTES = 20 * 1024 * 1024;

let context: Record<string, unknown> = {};

/** Merge late-bound fields (e.g. mode, sessionId) into every subsequent log entry. */
export function setLogContext(fields: Record<string, unknown>): void {
	Object.assign(context, fields);
}

export function writeFileLogEntry(entry: LogEntry): void {
	const line = stringifyLogEntry({ ...entry, ...context });
	appendRotatingLog(getAgentLogPath(), line, AGENT_LOG_MAX_BYTES);
	// Stall records get a second, bounded home: the shared log holds every session on the
	// machine and rotates at 20MB, so a stall post-mortem can otherwise be rolled away by
	// unrelated chatter before anyone reads it.
	if (isStallEvidenceMessage(entry.msg)) {
		writeStallEvidenceLine(line);
	}
}

/**
 * Route all structured logging (coding-agent and pi-ai) to the shared JSONL
 * log at ~/.prime/agent/logs/agent.jsonl. One master file, filterable by the
 * pid/context fields; writes are best-effort and size-bounded.
 */
export function installFileLogSink(fields?: Record<string, unknown>): void {
	context = { pid: process.pid, ...fields };
	setLogSink(writeFileLogEntry);
}
