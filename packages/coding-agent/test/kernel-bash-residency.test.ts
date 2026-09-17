/**
 * r44 form A: the kernel-liveness fact behind idle eviction has to be true while an *idle* kernel
 * hosts a background `bash()` script, and false once that script is gone.
 *
 * Both directions are load bearing. Eviction closes the session, closing the kernel, and the
 * kernel's shutdown SIGTERMs every live bash process group - so a false negative kills a script
 * nobody reports killing. A false positive never expires: an attestation that outlives the handle
 * it describes pins the session (and, through the whole-worker policy, its entire nest) forever,
 * which is the leak idle eviction exists to prevent.
 *
 * The heartbeat alone cannot serve either direction: a runtime emits frames only while a request is
 * in flight, so an idle kernel's newest frame is frozen on whatever the last in-flight window saw.
 * The orphan-process journal is the fresh source - enrolled at spawn (bash() fails closed when a
 * configured journal cannot enroll) and retired at exit - and the heartbeat remains a bounded
 * fallback for a host that has no journal configured.
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { kernelVouchedAlive } from "../src/core/turn-liveness.js";

const KERNEL_PROTOCOL_ENV_VAR = "PRIME_AGENT_KERNEL_PROTOCOL";

let tempDir = "";
let journalPath = "";
let entries: LogEntry[] = [];

/** A runtime that speaks protocol 4 and emits one attesting frame on the `attest` cell only. */
function fakeRuntimeSource(): string {
	return `#!/usr/bin/env node
const readline = require("node:readline");
const frame = (overrides) => ({
  event: "heartbeat",
  id: null,
  tick: 1,
  cpu_ms: 10,
  stream_bytes: 0,
  cells_done: 0,
  host_requests: 0,
  interval_ms: 5000,
  bash: { handles: 0, cell_handles: 0, buffered_bytes: 0, pipe_pending: 0 },
  ...overrides,
});
process.stdout.write(JSON.stringify({ event: "ready", protocol: 4, python: process.version }) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "attest") {
      // A short frame interval so the host's freshness window (3 intervals, floored at
      // gap + interval) is measurable inside a test: max(300, 1100) = 1100ms.
      process.stdout.write(
        JSON.stringify(frame({ id: request.id, interval_ms: 100, bash: { handles: 1, cell_handles: 1, buffered_bytes: 0, pipe_pending: 0 } })) + "\\n",
      );
    }
    process.stdout.write(JSON.stringify({ event: "done", id: request.id, status: "ok" }) + "\\n");
    return;
  }
  if (request.type === "shutdown") {
    process.stdout.write(JSON.stringify({ event: "done", id: request.id, status: "ok" }) + "\\n");
    process.exit(0);
  }
});
`;
}

function newManager(): ReplKernelManager {
	const python = join(tempDir, "python");
	writeFileSync(python, fakeRuntimeSource());
	chmodSync(python, 0o755);
	return new ReplKernelManager({ python, cwd: tempDir, env: {} });
}

/** One journal record, in the shape `bash()` writes: the host owns it, the kernel is named. */
function journalRecord(pid: number, kernelPid: number, active: boolean, recordedAt = new Date().toISOString()): string {
	return `${JSON.stringify({
		version: 1,
		pid,
		ownerPid: process.pid,
		kernelPid,
		processStartId: `ps:test-${pid}`,
		active,
		recordedAt,
	})}\n`;
}

/** A pid that was alive a moment ago and is not now: the stale-record shape D33 guards. */
async function deadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
		child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
		child.on("error", reject);
	});
}

/** One journal line padded to an exact byte length, so two contents can share a file identity. */
function sizedRecord(pid: number, kernelPid: number, length: number): string {
	const build = (pad: string): string =>
		`${JSON.stringify({
			version: 1,
			pid,
			ownerPid: process.pid,
			kernelPid,
			processStartId: `ps:${pad}`,
			active: true,
			recordedAt: new Date(1_800_000_000_000).toISOString(),
		})}\n`;
	let line = build("t3");
	while (line.length < length) line = build(`t3${"x".repeat(length - line.length)}`);
	if (line.length !== length) throw new Error(`cannot size a record to ${length} bytes`);
	return line;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bash-residency-"));
	journalPath = join(tempDir, "orphan-process-journal.jsonl");
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
	delete process.env[KERNEL_PROTOCOL_ENV_VAR];
});

afterEach(async () => {
	setLogSink(undefined);
	delete process.env[KERNEL_PROTOCOL_ENV_VAR];
	delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("kernel bash residency fact", () => {
	it("reports a journaled handle of an idle kernel and retires it when the handle exits", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid;
			expect(kernelPid).toBeDefined();
			// No frame was ever emitted: this is a kernel whose last cell finished, so the heartbeat
			// channel is silent by design and the journal is the only source that can still speak.
			expect(manager.kernelLiveness.latest).toBeUndefined();
			expect(manager.isKernelBashRunning).toBe(false);

			// The residency reader probes each candidate pid (D33): a journaled handle only
			// counts while its process exists, so the record has to name a pid that is alive.
			// This test process is the cheapest one that is guaranteed to be.
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid as number, true));
			expect(manager.isKernelBashRunning).toBe(true);
			// Residency that is not an eviction must still be attributable (T2(ii)-1): the transition
			// is logged once, with enough fields to tell which kernel and how many handles.
			const pinned = entries.filter((entry) => entry.msg === "kernel bash handles now hold this session resident");
			expect(pinned.length).toBe(1);
			expect(pinned[0]).toMatchObject({ level: "info", liveBashHandles: 1, kernelPid, probeCapped: false });

			// The script exited and retired its record: the fact must go with it, or the session it
			// belongs to is pinned - and with it every sibling in its worker - forever.
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid as number, false));
			expect(manager.isKernelBashRunning).toBe(false);
			// And the release is logged too, so an operator can see the session became reclaimable
			// rather than inferring it from the absence of a line.
			const released = entries.filter(
				(entry) => entry.msg === "kernel bash residency released; the session is reclaimable again",
			);
			expect(released.length).toBe(1);
			expect(released[0]).toMatchObject({ level: "info", liveBashHandles: 0 });
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("ignores records journaled by a sibling kernel", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid as number;
			// Both records name a live pid on purpose: if the sibling record named a dead one,
			// this case would pass because of the pid probe instead of the kernelPid filter, and
			// the filter it exists to pin would be untested.
			appendFileSync(journalPath, journalRecord(process.ppid, kernelPid + 1, true));
			expect(manager.isKernelBashRunning).toBe(false);
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid, true));
			expect(manager.isKernelBashRunning).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("bounds a heartbeat attestation to its freshness window when no journal is configured", async () => {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const manager = newManager();
		try {
			await manager.start();
			await manager.execute("attest");
			// Fresh frame, no journal to consult: the attestation is worth exactly its window.
			expect(manager.kernelLiveness.latest?.bashHandles).toBe(1);
			expect(manager.isKernelBashRunning).toBe(true);

			// Past max(3 intervals, sample gap + interval) = 1100ms the frozen frame stops being a
			// fact about now. This is the latch that would otherwise pin an idle session forever.
			await new Promise((resolve) => setTimeout(resolve, 1_400));
			expect(manager.kernelLiveness.latest?.bashHandles).toBe(1);
			expect(manager.isKernelBashRunning).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	}, 20_000);

	it("treats a configured but absent journal as no live handle", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(tempDir, "never-written.jsonl");
		const manager = newManager();
		try {
			await manager.start();
			expect(manager.isKernelBashRunning).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("does not pin on a journaled handle whose process is gone (D33)", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid as number;
			// The self-sustaining shape: a handle killed without retiring its record. Nothing else
			// would ever retire it - the reaper runs when the kernel dies, and this fact is what
			// keeps the kernel alive - so an unprobed count would pin the session forever.
			appendFileSync(journalPath, journalRecord(await deadPid(), kernelPid, true));
			expect(manager.isKernelBashRunning).toBe(false);

			// Positive control: the same file plus one record whose pid is alive does pin.
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid, true));
			expect(manager.isKernelBashRunning).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("prefers a journaled handle over a stale frame and a fresh frame over no journal", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid as number;
			await manager.execute("attest");
			expect(manager.kernelLiveness.latest?.bashHandles).toBe(1);

			// Matrix, journal row present: live handle + fresh frame.
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid, true));
			expect(manager.isKernelBashRunning).toBe(true);

			// Live handle + a frame that has aged out of its freshness window: the journal carries it.
			await new Promise((resolve) => setTimeout(resolve, 1_400));
			expect(kernelVouchedAlive(manager.kernelLiveness, Date.now()).state).toBe("stale");
			expect(manager.isKernelBashRunning).toBe(true);

			// No live handle + a stale frame: nothing attests, so nothing pins (r44 latch, direction a).
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid, false));
			expect(manager.isKernelBashRunning).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	}, 20_000);

	it("fails open on an unreadable journal and on a kernel that is gone", async () => {
		const manager = newManager();
		try {
			// A directory where the journal file should be: the read fails, and the fact falls back
			// to the heartbeat instead of throwing inside a sweep or a summary build.
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(tempDir, "not-a-journal");
			mkdirSync(process.env[ORPHAN_PROCESS_JOURNAL_ENV] as string);
			await manager.start();
			expect(manager.isKernelBashRunning).toBe(false);
			await manager.execute("attest");
			expect(manager.isKernelBashRunning).toBe(true);

			// Kernel gone: the journal branch has no pid to scope to and the samples are cleared, so
			// a row that was never retired for that kernel cannot keep reporting work (T2① zombie).
			const kernelPid = manager.kernelPid as number;
			writeFileSync(join(tempDir, "journal.jsonl"), journalRecord(process.pid, kernelPid, true));
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(tempDir, "journal.jsonl");
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
			expect(manager.kernelPid).toBeUndefined();
			expect(manager.isKernelBashRunning).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true }).catch(() => undefined);
		}
	});

	it("keeps a day-old handle resident and says so once (T2 ruling a)", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid as number;
			const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
			appendFileSync(journalPath, journalRecord(process.pid, kernelPid, true, old));

			// Alive means resident, however old: the age buys a warn, never an eviction.
			expect(manager.isKernelBashRunning).toBe(true);
			const warns = entries.filter((entry) => entry.level === "warn");
			expect(warns.length).toBe(1);
			expect(warns[0]?.msg).toContain("holding its session resident");
			expect(warns[0]).toMatchObject({
				kernelPid,
				liveBashHandles: 1,
				probeCapped: false,
			});
			expect(Number(warns[0]?.oldestHandleAgeMs)).toBeGreaterThan(24 * 60 * 60 * 1000);

			// Throttled: a second read inside the warn gap does not repeat the line.
			expect(manager.isKernelBashRunning).toBe(true);
			expect(entries.filter((entry) => entry.level === "warn").length).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	});

	it("re-reads a journal whose content changed behind an unchanged identity (T3)", async () => {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = newManager();
		try {
			await manager.start();
			const kernelPid = manager.kernelPid as number;
			const dead = await deadPid();
			// Same byte length, same mtime restored by hand: identity alone cannot see this change,
			// which is why the cached count also expires on a TTL in both directions.
			const length = Math.max(
				sizedRecord(dead, kernelPid, 260).length,
				sizedRecord(process.pid, kernelPid, 260).length,
			);
			// A whole-second stamp, because utimesSync cannot restore sub-millisecond precision: the
			// point of the fixture is an *exactly* unchanged (size, mtime) pair.
			const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
			writeFileSync(journalPath, sizedRecord(dead, kernelPid, length));
			utimesSync(journalPath, stamp, stamp);
			const identity = statSync(journalPath);
			// Prime the cache with the dead handle's zero count.
			expect(manager.isKernelBashRunning).toBe(false);

			writeFileSync(journalPath, sizedRecord(process.pid, kernelPid, length));
			utimesSync(journalPath, stamp, stamp);
			const after = statSync(journalPath);
			expect(after.size).toBe(identity.size);
			expect(after.mtimeMs).toBe(identity.mtimeMs);

			await vi.waitFor(() => expect(manager.isKernelBashRunning).toBe(true), {
				timeout: 15_000,
				interval: 250,
			});
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	}, 30_000);
});
