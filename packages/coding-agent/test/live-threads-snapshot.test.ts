import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LIVE_THREADS_SNAPSHOT_FILE_NAME,
	liveThreadsSnapshotWriteGate,
	normalizeLiveThreads,
	readLiveThreadsSnapshot,
	writeLiveThreadsSnapshotIfChanged,
} from "../src/modes/daemon/live-threads-snapshot.js";

describe("live-threads snapshot", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "live-threads-"));
		file = join(dir, LIVE_THREADS_SNAPSHOT_FILE_NAME);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("normalizes: drops blank ids, dedupes first-wins, sorts by id, drops blank cwd/name", () => {
		const out = normalizeLiveThreads([
			{ id: "b" },
			{ id: "  " },
			{ id: "a", name: "first", cwd: "" },
			{ id: "a", name: "second" },
		]);
		expect(out.map((entry) => entry.id)).toEqual(["a", "b"]);
		expect(out[0]).toEqual({ id: "a", name: "first" });
	});

	it("writes once per change and reads back verbatim", () => {
		const at = new Date("2026-09-25T07:00:00.000Z");
		const first = writeLiveThreadsSnapshotIfChanged(file, [{ id: "a", cwd: "/tmp/x" }], undefined, at);
		expect(first.changed).toBe(true);
		const read = readLiveThreadsSnapshot(file);
		expect(read?.writtenAt).toBe(at.toISOString());
		expect(read?.threads).toEqual([{ id: "a", cwd: "/tmp/x" }]);

		// An unchanged set costs no disk write: the file's mtime must not move.
		const before = statSync(file).mtimeMs;
		const second = writeLiveThreadsSnapshotIfChanged(file, [{ id: "a", cwd: "/tmp/x" }], first.signature, at);
		expect(second.changed).toBe(false);
		expect(statSync(file).mtimeMs).toBe(before);

		// A changed set writes again and the reader sees the new body.
		const third = writeLiveThreadsSnapshotIfChanged(file, [{ id: "a" }, { id: "b" }], second.signature, at);
		expect(third.changed).toBe(true);
		expect(readLiveThreadsSnapshot(file)?.threads.map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	it("read tolerates a missing or corrupt file instead of throwing", () => {
		expect(readLiveThreadsSnapshot(join(dir, "nope.json"))).toBeUndefined();
		writeFileSync(file, "{ not json");
		expect(readLiveThreadsSnapshot(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ threads: [] }));
		expect(readLiveThreadsSnapshot(file)).toBeUndefined();
	});
});

describe("liveThreadsSnapshotWriteGate (W2 single writer)", () => {
	it("lets the socket owner write the whole-machine roster", () => {
		expect(liveThreadsSnapshotWriteGate({ ownsSocketPath: true, leaseCompromised: false })).toEqual({
			allowed: true,
			reason: "owner",
		});
	});

	it("blocks a supervisor that does not own the socket path", () => {
		// A standby/downgraded supervisor is a client, not the owner; two writers
		// is how the roster fragment (2 threads vs 4 real sessions) reaches boot restore.
		expect(liveThreadsSnapshotWriteGate({ ownsSocketPath: false, leaseCompromised: false })).toEqual({
			allowed: false,
			reason: "does-not-own-socket",
		});
	});

	it("blocks a compromised lease even while it still owns the path", () => {
		// The lease compromise is the louder fact: the path is about to belong to
		// another holder, so writing one more roster would overwrite the new owner's.
		expect(liveThreadsSnapshotWriteGate({ ownsSocketPath: true, leaseCompromised: true })).toEqual({
			allowed: false,
			reason: "lease-compromised",
		});
		expect(liveThreadsSnapshotWriteGate({ ownsSocketPath: false, leaseCompromised: true })).toEqual({
			allowed: false,
			reason: "lease-compromised",
		});
	});
});
