import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LIVE_THREADS_SNAPSHOT_FILE_NAME,
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
