/**
 * Which journal records the residency reader is allowed to count.
 *
 * Division of labour, so the two files do not drift into testing each other's contract:
 * test/turn-liveness.test.ts owns the reader's own guarantees - pid probing (D33), a real
 * dead/live pid, the age warn instead of a release (T2 ruling a), the probe-cost bound, and the
 * fail-open shapes. This file owns the *selection* rule: whose records count at all. That rule is
 * what stops one kernel's handle from pinning another kernel's session, and stops a retired or
 * self-referential record from reading as work.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { readKernelBashResidency } from "../src/core/turn-liveness.js";

const KERNEL_PID = 4242;
const NOW = 1_800_000_000_000;

let tempDir = "";
let journalPath = "";

function record(pid: number, overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		version: 1,
		pid,
		ownerPid: process.pid,
		kernelPid: KERNEL_PID,
		processStartId: `ps:test-${pid}`,
		active: true,
		recordedAt: new Date(NOW).toISOString(),
		...overrides,
	})}\n`;
}

function write(...lines: string[]): void {
	writeFileSync(journalPath, lines.join(""));
}

const allAlive = () => true;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kernel-bash-residency-reader-"));
	journalPath = join(tempDir, "orphan-process-journal.jsonl");
	process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
});

afterEach(() => {
	delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

describe("readKernelBashResidency", () => {
	it("ignores a sibling kernel's records, the kernel's own record, and retired records", () => {
		write(
			record(1001, { kernelPid: KERNEL_PID + 1 }), // sibling kernel
			record(KERNEL_PID), // the kernel itself is not a bash handle
			record(1002, { active: false }), // retired
			record(1003), // the only candidate
		);
		const facts = readKernelBashResidency(KERNEL_PID, { now: () => NOW, isPidAlive: allAlive });
		expect(facts).toMatchObject({ liveBashHandles: 1, probed: 1 });
	});
});
