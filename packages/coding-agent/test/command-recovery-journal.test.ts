import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACT_AFTER_BYTES,
	COMPACT_AFTER_RECORDS,
	COMPLETED_ENTRY_TTL_MS,
	CommandRecoveryJournal,
	createCommandIdempotencyKey,
	MAX_ACTIVE_ENTRIES,
	PENDING_ENTRY_TTL_MS,
} from "../src/modes/daemon/command-recovery-journal.js";

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	it("drops a torn trailing line so the next append does not glue onto it", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		// Simulate a crash mid-append of the next record.
		appendFileSync(path, '{"version":1,"type":"received","key":"torn-key","commandType":"pro');

		const reopened = new CommandRecoveryJournal(path);
		expect(reopened.lookup("client-a", "command-a")).toEqual({ status: "pending" });
		expect(reopened.begin("client-b", "command-b", "prompt")).toEqual({ status: "new" });

		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(lines.some((line) => line.includes("command-b"))).toBe(true);
		expect(lines.some((line) => line.includes("torn"))).toBe(false);
	});

	it("cleans stale compaction temp files left by a crash", () => {
		const path = createPath();
		writeFileSync(`${path}.4242.tmp`, "stale");
		new CommandRecoveryJournal(path);
		expect(existsSync(`${path}.4242.tmp`)).toBe(false);
	});

	it("defers compaction past an acknowledgement and leaves no temp file behind", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");
		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		// The acknowledgement is a record, not a rewrite: the dead entry waits for a bound.
		expect(recordTypes(path)).toEqual(["received", "result", "acknowledged"]);
		const reopened = new CommandRecoveryJournal(path);
		expect(reopened.lookup("client-a", "command-a")).toBeUndefined();
		expect(reopened.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});

	it("compacts atomically at the record bound without leaving a temp file behind", () => {
		const path = createPath();
		// Seeded pairs of received+acknowledged records: dead on load, but they still
		// count toward the bound, so the next result is what triggers the rewrite.
		const seeded: string[] = [];
		for (let index = 0; index < COMPACT_AFTER_RECORDS - 2; index += 2) {
			const key = createCommandIdempotencyKey("seed", `${index}`);
			seeded.push(
				JSON.stringify({
					version: 1,
					type: "received",
					key,
					clientId: "seed",
					commandId: `${index}`,
					commandType: "prompt",
					recordedAt: new Date().toISOString(),
				}),
				JSON.stringify({ version: 1, type: "acknowledged", key, recordedAt: new Date().toISOString() }),
			);
		}
		expect(seeded).toHaveLength(COMPACT_AFTER_RECORDS - 2);
		writeFileSync(path, `${seeded.join("\n")}\n`);

		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		// Only the live entry survived the rewrite.
		expect(recordTypes(path)).toEqual(["received", "result"]);
		const reopened = new CommandRecoveryJournal(path);
		expect(reopened.lookup("client-a", "command-a")).toEqual({
			status: "complete",
			response: { id: "command-a", type: "response", command: "prompt", success: true },
		});
		expect(reopened.lookup("seed", "0")).toBeUndefined();
	});

	it("compacts at the byte bound", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
			data: { filler: "x".repeat(COMPACT_AFTER_BYTES) },
		});
		// Two records only, so the byte bound is what makes the acknowledgement compact.
		expect(statSync(path).size).toBeGreaterThanOrEqual(COMPACT_AFTER_BYTES);
		journal.acknowledge("client-a", "command-a");
		expect(recordTypes(path)).toEqual([]);
		expect(statSync(path).size).toBeLessThan(1024);
	});

	it.skipIf(process.platform === "win32")("tightens journal permissions once, not per record", () => {
		const path = createPath();
		writeFileSync(path, "");
		chmodSync(path, 0o644); // a journal left behind by an older build
		const journal = new CommandRecoveryJournal(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		journal.begin("client-a", "command-a", "prompt");
		journal.acknowledge("client-a", "command-a");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	function recordTypes(path: string): string[] {
		if (!existsSync(path)) {
			return [];
		}
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => (JSON.parse(line) as { type: string }).type);
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("ignores a truncated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("expires a completed entry no acknowledgement ever reached", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		expect(journal.sweepExpired(Date.now() + COMPLETED_ENTRY_TTL_MS - 1000)).toBe(0);
		expect(journal.lookup("client-a", "command-a")?.status).toBe("complete");
		expect(journal.sweepExpired(Date.now() + COMPLETED_ENTRY_TTL_MS + 1000)).toBe(1);
		expect(journal.lookup("client-a", "command-a")).toBeUndefined();
		// The removal is journaled, so a restart cannot resurrect the entry (which
		// would keep the active set, and the rewrite it forces, growing forever).
		expect(recordTypes(path)).toContain("expired");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.lookup("client-a", "command-a")).toBeUndefined();
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});

	it("keeps a pending entry past the completed TTL and expires it past its own", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "send_message");

		// A pending entry is the "uncertain" half of the contract: dropping it early
		// would tell a replay "never seen before" and invite a second execution.
		expect(journal.sweepExpired(Date.now() + COMPLETED_ENTRY_TTL_MS * 2)).toBe(0);
		expect(journal.lookup("client-a", "command-a")).toEqual({ status: "pending" });
		// Past the delivery budget (24h) no answer can still arrive, so it goes.
		expect(PENDING_ENTRY_TTL_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
		expect(journal.sweepExpired(Date.now() + PENDING_ENTRY_TTL_MS + 1000)).toBe(1);
		expect(journal.lookup("client-a", "command-a")).toBeUndefined();

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "send_message")).toEqual({ status: "new" });
	});

	it("ages a completed entry from its result, not from a receipt that took a day to answer", () => {
		const path = createPath();
		// A long-running command: received yesterday, answered just now.
		const receivedAt = new Date(Date.now() - COMPLETED_ENTRY_TTL_MS * 12).toISOString();
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				type: "received",
				key: createCommandIdempotencyKey("client-a", "command-a"),
				clientId: "client-a",
				commandId: "command-a",
				commandType: "send_message",
				recordedAt: receivedAt,
			})}\n`,
		);
		const journal = new CommandRecoveryJournal(path);
		expect(journal.lookup("client-a", "command-a")).toEqual({ status: "pending" });
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "send_message",
			success: true,
		});

		// The result just landed, so a reconnect replay still gets the stored answer.
		expect(journal.sweepExpired(Date.now() + 60_000)).toBe(0);
		expect(journal.lookup("client-a", "command-a")?.status).toBe("complete");
		expect(journal.sweepExpired(Date.now() + COMPLETED_ENTRY_TTL_MS + 60_000)).toBe(1);
		expect(journal.lookup("client-a", "command-a")).toBeUndefined();
	});

	it("drops the oldest completed entries at the active bound and never a pending one", () => {
		const path = createPath();
		const over = MAX_ACTIVE_ENTRIES + 6;
		const seeded: string[] = [];
		const recordedAt = new Date().toISOString();
		// The unanswered command is seeded first, so it is the oldest entry in the
		// journal: a capacity pass that did not spare pending entries would take it
		// first, and a replay of that command would then execute it a second time.
		seeded.push(
			JSON.stringify({
				version: 1,
				type: "received",
				key: createCommandIdempotencyKey("client-seed", "command-pending"),
				clientId: "client-seed",
				commandId: "command-pending",
				commandType: "prompt",
				recordedAt,
			}),
		);
		for (let index = 0; index < over; index++) {
			const key = createCommandIdempotencyKey("client-seed", `command-${index}`);
			seeded.push(
				JSON.stringify({
					version: 1,
					type: "received",
					key,
					clientId: "client-seed",
					commandId: `command-${index}`,
					commandType: "prompt",
					recordedAt,
				}),
				JSON.stringify({
					version: 1,
					type: "result",
					key,
					response: { id: `command-${index}`, type: "response", command: "prompt", success: true },
					recordedAt,
				}),
			);
		}
		writeFileSync(path, `${seeded.join("\n")}\n`);

		const journal = new CommandRecoveryJournal(path);
		expect(journal.lookup("client-seed", "command-0")?.status).toBe("complete");
		// The next mutating command is what enforces the bound, so the journal can
		// never sit above it: past MAX_ACTIVE_ENTRIES every command would rewrite it.
		expect(journal.begin("client-new", "command-new", "prompt")).toEqual({ status: "new" });

		expect(journal.lookup("client-seed", "command-pending")).toEqual({ status: "pending" });
		expect(journal.lookup("client-new", "command-new")).toEqual({ status: "pending" });
		// Exactly the oldest completed entries went; the rest of the history is intact.
		const dropped = over + 1 + 1 - MAX_ACTIVE_ENTRIES;
		expect(dropped).toBeGreaterThan(0);
		for (let index = 0; index < dropped; index++) {
			expect(journal.lookup("client-seed", `command-${index}`), `command-${index}`).toBeUndefined();
		}
		expect(journal.lookup("client-seed", `command-${dropped}`)?.status).toBe("complete");
		expect(journal.lookup("client-seed", `command-${over - 1}`)?.status).toBe("complete");
		// The eviction is journaled and then compacted away together with the entries
		// it dropped, so the file holds the survivors only.
		expect(recordTypes(path).length).toBeLessThanOrEqual(2 * MAX_ACTIVE_ENTRIES);
		expect(recordTypes(path).filter((type) => type === "received")).toHaveLength(MAX_ACTIVE_ENTRIES);
	});

	it("answers a replay from a reconnecting client instead of executing the mutation twice", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		// A disconnect must not clear this: DaemonClient replays a recoverable
		// in-flight command verbatim (same clientId, same command id) once it
		// reconnects, and the recorded result is the only thing that keeps the replay
		// from running the mutation a second time. Only the TTL may drop it.
		expect(journal.sweepExpired(Date.now() + 60_000)).toBe(0);
		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: { id: "command-a", type: "response", command: "prompt", success: true },
		});
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});
});
