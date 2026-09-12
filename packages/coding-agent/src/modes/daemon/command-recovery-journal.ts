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

/** Why an entry was dropped without a client acknowledgement; see `sweepExpired`. */
export type CommandJournalExpiryReason = "completed_ttl" | "pending_ttl" | "capacity";

interface ExpiredRecord {
	version: 1;
	type: "expired";
	key: string;
	reason: CommandJournalExpiryReason;
	recordedAt: string;
}

type JournalRecord = ReceivedRecord | ResultRecord | AcknowledgedRecord | ExpiredRecord;

interface JournalEntry {
	received: ReceivedRecord;
	response?: DaemonResponse;
	/** Epoch ms of the received record: the clock the pending TTL runs on. */
	receivedAt: number;
	/** Epoch ms of the result record: a completed entry ages from its own result, not from receipt. */
	respondedAt?: number;
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

/**
 * Active-entry bounds. `acknowledge()` is the only client-driven removal and three
 * real paths never reach it: a `close()` that races the response it was answering,
 * a request whose client-side timeout fired before the response arrived (a
 * `send_message` with a 24h delivery budget against a 30s caller budget is that
 * shape by construction), and any reconnect — the idempotency key carries a
 * per-connection clientId, so a new connection can never ack the old one's
 * entries. Production showed 46 permanently active entries out of 432 commands,
 * and from COMPACT_AFTER_RECORDS/2 active entries on *every* mutating command pays
 * a full synchronous rewrite plus fsync on the supervisor's single thread.
 *
 * Entries therefore expire: a completed one (its result is recorded, so a replay
 * has already been answered or never came) after an hour, a pending one only after
 * 48h — comfortably past the 24h agent-message delivery budget, because a pending
 * entry is the "uncertain" half of the crash-idempotency contract and dropping it
 * early would turn "may already have run" into "never seen before" and invite a
 * second execution. Expiry is journaled, so a restart does not resurrect what was
 * dropped. A client disconnect deliberately does NOT clear entries: `DaemonClient`
 * replays a recoverable in-flight command verbatim after reconnecting, and that
 * replay is exactly what the recorded result has to answer.
 */
export const COMPLETED_ENTRY_TTL_MS = 60 * 60 * 1000;
export const PENDING_ENTRY_TTL_MS = 48 * 60 * 60 * 1000;
/** Tripwire: past this many active entries each mutating command would rewrite the journal. */
export const MAX_ACTIVE_ENTRIES = COMPACT_AFTER_RECORDS / 2;
/** Expiry is checked on the command path, so it is throttled rather than per entry. */
const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export function createCommandIdempotencyKey(clientId: DaemonClientId, commandId: DaemonCommandId): string {
	return JSON.stringify([clientId, commandId]);
}

/** An unparseable timestamp must not make an entry immortal, nor expire it on sight. */
function recordedAtMs(recordedAt: string): number {
	const parsed = Date.parse(recordedAt);
	return Number.isFinite(parsed) ? parsed : Date.now();
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
	private nextExpirySweepAt = 0;
	private capacityWarningLogged = false;

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
		this.entries.set(key, { received, receivedAt: recordedAtMs(received.recordedAt) });
		this.maybeSweepExpired();
		this.enforceActiveEntryBound();
		return { status: "new" };
	}

	/**
	 * Drop entries no acknowledgement can still reach. Called on the command path
	 * (throttled) and directly by tests; `now` is injectable so the TTLs are
	 * testable without a clock.
	 */
	sweepExpired(now = Date.now()): number {
		const expirations: Array<{ key: string; reason: CommandJournalExpiryReason }> = [];
		for (const [key, entry] of this.entries) {
			const completed = entry.response !== undefined;
			const ttl = completed ? COMPLETED_ENTRY_TTL_MS : PENDING_ENTRY_TTL_MS;
			const since = completed ? Math.max(entry.receivedAt, entry.respondedAt ?? 0) : entry.receivedAt;
			if (now - since >= ttl) {
				expirations.push({ key, reason: completed ? "completed_ttl" : "pending_ttl" });
			}
		}
		this.expireEntries(expirations);
		return expirations.length;
	}

	private maybeSweepExpired(now = Date.now()): void {
		if (now < this.nextExpirySweepAt) {
			return;
		}
		this.nextExpirySweepAt = now + EXPIRY_SWEEP_INTERVAL_MS;
		this.sweepExpired(now);
	}

	/**
	 * Oldest completed entries go first: a pending entry is the "uncertain" half of
	 * the contract and is never dropped for capacity. Reaching this with nothing
	 * completed left means every active entry is an unanswered mutating command,
	 * which is worth one warning rather than a silent rewrite per command.
	 */
	private enforceActiveEntryBound(): void {
		if (this.entries.size <= MAX_ACTIVE_ENTRIES) {
			return;
		}
		const expirations: Array<{ key: string; reason: CommandJournalExpiryReason }> = [];
		for (const [key, entry] of this.entries) {
			if (this.entries.size - expirations.length <= MAX_ACTIVE_ENTRIES) {
				break;
			}
			if (entry.response !== undefined) {
				expirations.push({ key, reason: "capacity" });
			}
		}
		this.expireEntries(expirations);
		if (this.entries.size > MAX_ACTIVE_ENTRIES && !this.capacityWarningLogged) {
			this.capacityWarningLogged = true;
			structuredLog.warn("command journal is at its active entry bound with no completed entry left to drop", {
				path: this.path,
				activeEntries: this.entries.size,
				limit: MAX_ACTIVE_ENTRIES,
			});
		}
	}

	/** Journal the removals before dropping them, so a restart cannot resurrect an expired entry. */
	private expireEntries(expirations: ReadonlyArray<{ key: string; reason: CommandJournalExpiryReason }>): void {
		if (expirations.length === 0) {
			return;
		}
		const recordedAt = new Date().toISOString();
		this.appendAll(
			expirations.map((expiration) => ({
				version: 1 as const,
				type: "expired" as const,
				key: expiration.key,
				reason: expiration.reason,
				recordedAt,
			})),
		);
		for (const { key } of expirations) {
			this.entries.delete(key);
		}
		if (this.shouldCompact()) {
			this.compact();
		}
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
		entry.respondedAt = recordedAtMs(record.recordedAt);
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
					this.entries.set(record.key, { received: record, receivedAt: recordedAtMs(record.recordedAt) });
				}
				continue;
			}
			if (record.type === "acknowledged" || record.type === "expired") {
				this.entries.delete(record.key);
				continue;
			}
			const entry = this.entries.get(record.key);
			if (entry && record.response?.type === "response") {
				entry.response = record.response;
				entry.respondedAt = recordedAtMs(record.recordedAt);
			}
		}
	}

	/**
	 * Append and fsync. Unlike the sibling worker journal this record is part of a
	 * durability contract: the received record must be on disk before the mutating
	 * command is dispatched, so a crash cannot leave an unjournaled side effect.
	 */
	private append(record: JournalRecord): void {
		this.appendAll([record]);
	}

	/** One open/write/fsync for the whole batch: an expiry sweep must not pay one fsync per dropped entry. */
	private appendAll(records: readonly JournalRecord[]): void {
		if (records.length === 0) {
			return;
		}
		const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, lines);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		this.recordCount += records.length;
		this.byteLength += Buffer.byteLength(lines);
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
