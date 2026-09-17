import type * as FsModule from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * C4/铁则4: authority state (worker descriptors, supervisor config, shutdown
 * admissions, update manifests) must be durable across a power loss — a torn
 * startup fence makes the daemon for that socket unstartable. The merge keeps the
 * fork's unconditional fsync + directory fsync on top of the atomic util; these
 * pins exist so that "just call writeFileAtomicSync without the flags" goes red.
 */

const fsyncCalls = vi.hoisted(() => ({ file: 0, dir: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		fsyncSync: ((fd: number) => {
			// A directory fd answers fstatSync().isDirectory(); a file fd does not.
			const isDir = actual.fstatSync(fd).isDirectory();
			if (isDir) fsyncCalls.dir++;
			else fsyncCalls.file++;
			return actual.fsyncSync(fd);
		}) as typeof actual.fsyncSync,
	};
});

import { writeJsonAtomically } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon authority-state durability", () => {
	it("writeJsonAtomically fsyncs the temp file and its directory before and after the rename", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-authority-durability-"));
		tempDirs.push(dir);
		fsyncCalls.file = 0;
		fsyncCalls.dir = 0;
		const path = join(dir, "owner.json");
		writeJsonAtomically(path, { version: 1, pid: 123 });
		// Exactly one file fsync (the temp, pre-rename) and one directory fsync (post-rename).
		expect(fsyncCalls.file).toBe(1);
		expect(fsyncCalls.dir).toBe(1);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, pid: 123 });
		// Owner-only, re-asserted past the umask (fork policy #1249).
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});
});
