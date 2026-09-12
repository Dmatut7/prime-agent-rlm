import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { repairTruncatedTrailingLine } from "../../utils/file-lines.js";
import type { DaemonClientId, DaemonCommandId, DaemonResponse } from "./daemon-protocol.js";

interface ReceivedRecord {
	version: 1;
	type: "received";
	key: string;
	clientId: DaemonClientId;
	commandId: DaemonCommandId;
	commandType: string;
	recordedAt: string;
}

interface ResultRecord {
	version: 1;
	type: "result";
	key: string;
	response: DaemonResponse;
	recordedAt: string;
}

interface AcknowledgedRecord {
	version: 1;
	type: "acknowledged";
	key: string;
	recordedAt: string;
}

type JournalRecord = ReceivedRecord | ResultRecord | AcknowledgedRecord;

interface JournalEntry {
	received: ReceivedRecord;
	response?: DaemonResponse;
}

export type CommandJournalBeginResult =
	| { status: "new" }
	| { status: "pending" }
	| { status: "complete"; response: DaemonResponse };

const structuredLog = getLogger("coding-agent.daemon.command-recovery-journal");

/**
 * Compaction bounds. Acknowledged records are dead weight on disk but harmless
 * (a load replays the acknowledgement and drops the entry), so compaction waits
 * for one of these instead of rewriting the whole journal after every command.
 * Both bounds match the sibling worker-recovery-journal.
 */
export const COMPACT_AFTER_RECORDS = 4096;
export const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

export function createCommandIdempotencyKey(clientId: DaemonClientId, commandId: DaemonCommandId): string {
	return JSON.stringify([clientId, commandId]);
}

/**
 * Append-only command journal used at the supervisor boundary. A received
 * record is durable before a mutating command is dispatched; a missing result
 * after a crash is therefore treated as uncertain and is never replayed.
 */
export class CommandRecoveryJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private recordCount = 0;
	private byteLength = 0;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.cleanStaleCompactionTemps();
		// A crash can leave a torn final line; load skips it, so drop it from disk
		// too — the next append must not glue onto the torn bytes.
		repairTruncatedTrailingLine(path);
		this.load();
		this.tightenPermissions();
	}

	/**
	 * openSync(path, "a", 0o600) applies the mode only when it creates the file, so
	 * a journal that already exists with looser permissions is tightened once here.
	 * Appending never changes a file's mode, which is why this does not run per record.
	 */
	private tightenPermissions(): void {
		try {
			chmodSync(this.path, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// Nothing on disk yet; the first append creates it with mode 0600.
				return;
			}
			structuredLog.warn("could not tighten command recovery journal permissions", {
				path: this.path,
				error: String(error),
			});
		}
	}

	private cleanStaleCompactionTemps(): void {
		const prefix = `${basename(this.path)}.`;
		try {
			for (const name of readdirSync(dirname(this.path))) {
				if (name.startsWith(prefix) && name.endsWith(".tmp")) {
					rmSync(join(dirname(this.path), name), { force: true });
				}
			}
		} catch {
			// Stale temps only waste space; their cleanup must not break startup.
		}
	}

	lookup(
		clientId: DaemonClientId,
		commandId: DaemonCommandId,
	): Exclude<CommandJournalBeginResult, { status: "new" }> | undefined {
		const existing = this.entries.get(createCommandIdempotencyKey(clientId, commandId));
		if (existing?.response) {
			return { status: "complete", response: existing.response };
		}
		return existing ? { status: "pending" } : undefined;
	}

	begin(clientId: DaemonClientId, commandId: DaemonCommandId, commandType: string): CommandJournalBeginResult {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const existing = this.lookup(clientId, commandId);
		if (existing) return existing;
		const received: ReceivedRecord = {
			version: 1,
			type: "received",
			key,
			clientId,
			commandId,
			commandType,
			recordedAt: new Date().toISOString(),
		};
		this.append(received);
		this.entries.set(key, { received });
		return { status: "new" };
	}

	recordResult(clientId: DaemonClientId, commandId: DaemonCommandId, response: DaemonResponse): void {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const entry = this.entries.get(key);
		if (!entry) {
			throw new Error(`Cannot record a result before command receipt: ${key}`);
		}
		const record: ResultRecord = {
			version: 1,
			type: "result",
			key,
			response,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		entry.response = response;
		if (this.shouldCompact()) {
			this.compact();
		}
	}

	acknowledge(clientId: DaemonClientId, commandId: DaemonCommandId): void {
		const key = createCommandIdempotencyKey(clientId, commandId);
		if (!this.entries.has(key)) {
			return;
		}
		this.append({
			version: 1,
			type: "acknowledged",
			key,
			recordedAt: new Date().toISOString(),
		});
		this.entries.delete(key);
		if (this.shouldCompact()) {
			this.compact();
		}
	}

	/**
	 * Dead records only cost disk until a bound is hit, while a compaction rewrites
	 * and fsyncs the whole file synchronously on the supervisor's thread.
	 */
	private shouldCompact(): boolean {
		return this.recordCount >= COMPACT_AFTER_RECORDS || this.byteLength >= COMPACT_AFTER_BYTES;
	}

	private load(): void {
		let contents: string;
		try {
			contents = readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		this.byteLength = Buffer.byteLength(contents);
		for (const line of contents.split("\n")) {
			if (!line) {
				continue;
			}
			let record: JournalRecord;
			try {
				record = JSON.parse(line) as JournalRecord;
			} catch {
				// A crash may leave only the final append truncated.
				continue;
			}
			if (record.version !== 1 || typeof record.key !== "string") {
				continue;
			}
			this.recordCount++;
			if (record.type === "received") {
				if (
					typeof record.clientId === "string" &&
					typeof record.commandId === "string" &&
					typeof record.commandType === "string"
				) {
					this.entries.set(record.key, { received: record });
				}
				continue;
			}
			if (record.type === "acknowledged") {
				this.entries.delete(record.key);
				continue;
			}
			const entry = this.entries.get(record.key);
			if (entry && record.response?.type === "response") {
				entry.response = record.response;
			}
		}
	}

	/**
	 * Append and fsync. Unlike the sibling worker journal this record is part of a
	 * durability contract: the received record must be on disk before the mutating
	 * command is dispatched, so a crash cannot leave an unjournaled side effect.
	 */
	private append(record: JournalRecord): void {
		const line = `${JSON.stringify(record)}\n`;
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, line);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		this.recordCount++;
		this.byteLength += Buffer.byteLength(line);
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		const records: JournalRecord[] = [];
		for (const [key, entry] of this.entries) {
			records.push(entry.received);
			if (entry.response) {
				records.push({
					version: 1,
					type: "result",
					key,
					response: entry.response,
					recordedAt: new Date().toISOString(),
				});
			}
		}
		const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			writeSync(descriptor, content);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(tempPath, this.path);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			// After a successful rename the temp no longer exists; on failure this
			// removes the partial file instead of leaving it for the next startup.
			rmSync(tempPath, { force: true });
		}
		const directoryDescriptor = openSync(dirname(this.path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
		this.recordCount = records.length;
		this.byteLength = Buffer.byteLength(content);
	}
}
