import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import {
	type RestoreResult,
	readSnapshotManifest,
	restoreNoticeLines,
	type SnapshotWritePolicyInput,
	snapshotWritePolicy,
} from "../src/core/kernel/state-snapshot.js";

let tempDir = "";
let entries: LogEntry[] = [];
let snapshotPath = "";
let manifestPath = "";
let requestLogPath = "";
const runsAsRoot = process.getuid?.() === 0;

/**
 * A node stand-in for the REPL runtime: it speaks the wire protocol (ready/done)
 * and records every snapshot request the host sends, so the assertions are about
 * what the host asked for rather than about Python.
 */
function writeFakeKernel(): string {
	const script = join(tempDir, "fake-kernel.cjs");
	writeFileSync(
		script,
		[
			"#!/usr/bin/env node",
			'"use strict";',
			"const fs = require('fs');",
			"const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			"const list = (value) => String(value || '').split(',').filter(Boolean);",
			"send({",
			"  event: 'ready',",
			"  protocol: Number(process.env.FAKE_PROTOCOL || 4),",
			"  python: '3.11.0',",
			"  capabilities: list(process.env.FAKE_CAPABILITIES),",
			"});",
			"let buffered = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => {",
			"  buffered += chunk;",
			"  let newline = buffered.indexOf('\\n');",
			"  while (newline !== -1) {",
			"    const line = buffered.slice(0, newline);",
			"    buffered = buffered.slice(newline + 1);",
			"    newline = buffered.indexOf('\\n');",
			"    if (line.trim()) handle(JSON.parse(line));",
			"  }",
			"});",
			"function handle(req) {",
			"  if (req.type === 'shutdown') return send({ event: 'done', id: req.id, status: 'ok' });",
			"  if (req.type === 'restore') {",
			"    if (process.env.FAKE_RESTORE_ERROR) {",
			"      return send({ event: 'done', id: req.id, status: 'error', reason: process.env.FAKE_RESTORE_ERROR });",
			"    }",
			"    return send({",
			"      event: 'done',",
			"      id: req.id,",
			"      status: 'ok',",
			"      restored: list(process.env.FAKE_RESTORE_RESTORED),",
			"      failed: list(process.env.FAKE_RESTORE_FAILED).map((name) => ({ name, reason: 'ModuleNotFoundError' })),",
			"    });",
			"  }",
			"  if (req.type === 'snapshot') {",
			"    fs.appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(req) + '\\n');",
			"    const preserved = list(req.preserve_names);",
			"    const dropped = process.env.FAKE_DROP_OLDEST_PRESERVED === '1' ? preserved.slice(0, 1) : [];",
			"    const kept = process.env.FAKE_DROP_OLDEST_PRESERVED === '1' ? preserved.slice(1) : preserved;",
			"    fs.writeFileSync(process.env.FAKE_SNAPSHOT_PATH, 'payload-' + Date.now());",
			"    fs.writeFileSync(",
			"      process.env.FAKE_MANIFEST_PATH,",
			"      JSON.stringify({ savedNames: ['fresh', ...kept], preserved: kept }),",
			"    );",
			"    return send({",
			"      event: 'done',",
			"      id: req.id,",
			"      status: 'ok',",
			"      saved: ['fresh', ...kept],",
			"      skipped: dropped.map((name) => ({ name, reason: 'exceeds aggregate snapshot size cap' })),",
			"      preserved: kept,",
			"      bytes: 32,",
			"    });",
			"  }",
			"  if (req.type === 'list_names') return send({ event: 'done', id: req.id, status: 'ok', names: [] });",
			"  send({ event: 'done', id: req.id, status: 'ok' });",
			"}",
			"",
		].join("\n"),
	);
	chmodSync(script, 0o755);
	return script;
}

function snapshotRequests(): Record<string, unknown>[] {
	if (!existsSync(requestLogPath)) return [];
	return readFileSync(requestLogPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function newManager(
	fakeKernel: string,
	env: Record<string, string>,
	options: { snapshot?: boolean } = {},
): ReplKernelManager {
	return new ReplKernelManager({
		python: fakeKernel,
		cwd: tempDir,
		sessionId: "session-policy",
		env: {
			FAKE_SNAPSHOT_PATH: snapshotPath,
			FAKE_MANIFEST_PATH: manifestPath,
			FAKE_REQUEST_LOG: requestLogPath,
			...env,
		},
		...(options.snapshot === false
			? {}
			: { snapshot: { path: snapshotPath, manifestPath, maxBytes: 4096, maxVariableBytes: 1024 } }),
	});
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-snapshot-policy-"));
	snapshotPath = join(tempDir, "kernel-state.dill");
	manifestPath = join(tempDir, "kernel-state.json");
	requestLogPath = join(tempDir, "snapshot-requests.log");
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
});

afterEach(() => {
	setLogSink(undefined);
	if (tempDir) {
		chmodSync(tempDir, 0o755);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("snapshot writes after a partial restore", () => {
	it("writes again and asks the runtime to preserve the unrestored names", async () => {
		const fakeKernel = writeFakeKernel();
		const manager = newManager(fakeKernel, {
			FAKE_CAPABILITIES: "preserve_names",
			FAKE_RESTORE_RESTORED: "kept",
			FAKE_RESTORE_FAILED: "gone",
		});

		try {
			await manager.start();
			expect(manager.kernelCapabilities?.preserveNames).toBe(true);

			const restore = await manager.restoreState();
			expect(restore?.restored).toEqual(["kept"]);
			expect(restore?.failed.map((failure) => failure.name)).toEqual(["gone"]);
			expect(restore?.snapshotPolicy).toBe("preserve-names");

			// A partial revive no longer bans every later write.
			const snapshot = await manager.snapshotState();
			expect(snapshot).not.toBeNull();
			expect(snapshot?.saved).toContain("fresh");
			expect(snapshot?.preserved).toEqual(["gone"]);

			const requests = snapshotRequests();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.preserve_names).toEqual(["gone"]);
			expect(requests[0]?.max_bytes).toBe(4096);
			expect(existsSync(snapshotPath)).toBe(true);
			expect(JSON.parse(readFileSync(manifestPath, "utf8")).preserved).toEqual(["gone"]);

			const preserved = entries.filter((entry) => entry.msg === "kernel state snapshot preserved unrestored names");
			expect(preserved).toHaveLength(1);
			expect(preserved[0]?.level).toBe("info");
			expect(preserved[0]?.names).toEqual(["gone"]);
			expect(preserved[0]?.sessionId).toBe("session-policy");

			// The final dispose snapshot keeps preserving too, instead of staying banned.
			await manager.shutdown({ snapshot: true });
			expect(snapshotRequests()).toHaveLength(2);
			expect(snapshotRequests()[1]?.preserve_names).toEqual(["gone"]);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("keeps writes banned while the runtime cannot preserve names", async () => {
		// A runtime that does not announce the capability would silently drop the
		// preserved blobs, so the pre-fix behaviour (no write at all) stays in force.
		const fakeKernel = writeFakeKernel();
		const manager = newManager(fakeKernel, {
			FAKE_CAPABILITIES: "",
			FAKE_PROTOCOL: "3",
			FAKE_RESTORE_RESTORED: "kept",
			FAKE_RESTORE_FAILED: "gone",
		});

		try {
			await manager.start();
			expect(manager.kernelCapabilities?.preserveNames).toBe(false);
			const onDisk = "previous payload";
			writeFileSync(snapshotPath, onDisk);

			const restore = await manager.restoreState();
			expect(restore?.failed.map((failure) => failure.name)).toEqual(["gone"]);
			expect(restore?.snapshotPolicy).toBe("write-blocked");

			await expect(manager.snapshotState()).resolves.toBeNull();
			expect(snapshotRequests()).toHaveLength(0);
			expect(readFileSync(snapshotPath, "utf8")).toBe(onDisk);

			const skipped = entries.filter((entry) => entry.msg === "kernel state snapshot skipped");
			expect(skipped.length).toBeGreaterThan(0);
			expect(skipped[0]?.level).toBe("warn");
			expect(skipped[0]?.reason).toBe("unrestored-names-without-preserve");
			expect(skipped[0]?.names).toEqual(["gone"]);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("clears the preserved set after a fully successful restore", async () => {
		const fakeKernel = writeFakeKernel();
		const manager = newManager(fakeKernel, {
			FAKE_CAPABILITIES: "preserve_names",
			FAKE_RESTORE_RESTORED: "kept,other",
		});

		try {
			await manager.start();
			const restore = await manager.restoreState();
			expect(restore?.failed).toEqual([]);
			expect(restore?.snapshotPolicy).toBeUndefined();

			const snapshot = await manager.snapshotState();
			expect(snapshot).not.toBeNull();
			expect(snapshot?.preserved).toBeUndefined();
			const requests = snapshotRequests();
			expect(requests).toHaveLength(1);
			expect("preserve_names" in (requests[0] ?? {})).toBe(false);
			expect(JSON.parse(readFileSync(manifestPath, "utf8")).preserved).toEqual([]);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("reports what the runtime actually preserved when the size cap drops a name", async () => {
		const fakeKernel = writeFakeKernel();
		const manager = newManager(fakeKernel, {
			FAKE_CAPABILITIES: "preserve_names",
			FAKE_RESTORE_RESTORED: "kept",
			FAKE_RESTORE_FAILED: "oldest,newer",
			FAKE_DROP_OLDEST_PRESERVED: "1",
		});

		try {
			await manager.start();
			const restore = await manager.restoreState();
			expect(restore?.failed.map((failure) => failure.name)).toEqual(["oldest", "newer"]);

			const snapshot = await manager.snapshotState();
			expect(snapshot).not.toBeNull();
			// The host repeats the runtime's answer instead of claiming every name survived.
			expect(snapshot?.preserved).toEqual(["newer"]);
			expect(snapshot?.skipped.map((entry) => entry.name)).toContain("oldest");
			expect(JSON.parse(readFileSync(manifestPath, "utf8")).preserved).toEqual(["newer"]);
			const preserved = entries.filter((entry) => entry.msg === "kernel state snapshot preserved unrestored names");
			expect(preserved).toHaveLength(1);
			expect(preserved[0]?.names).toEqual(["newer"]);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it.skipIf(runsAsRoot)(
		"blocks writes when a whole restore failed and the payload could not be isolated",
		async () => {
			const fakeKernel = writeFakeKernel();
			const manager = newManager(fakeKernel, {
				FAKE_CAPABILITIES: "preserve_names",
				FAKE_RESTORE_ERROR: "load failed: truncated payload",
			});
			writeFileSync(snapshotPath, "corrupt payload");

			try {
				await manager.start();
				// A read-only artifact directory makes the isolation rename fail, which is the
				// only case where a whole-load failure keeps writes banned.
				chmodSync(tempDir, 0o500);
				await expect(manager.restoreState()).resolves.toBeNull();

				await expect(manager.snapshotState()).resolves.toBeNull();
				expect(snapshotRequests()).toHaveLength(0);
				const skipped = entries.filter((entry) => entry.msg === "kernel state snapshot skipped");
				expect(skipped.length).toBeGreaterThan(0);
				expect(skipped[0]?.reason).toBe("restore-write-blocked");
			} finally {
				chmodSync(tempDir, 0o755);
				await manager.shutdown({});
			}
			expect(readFileSync(snapshotPath, "utf8")).toBe("corrupt payload");
		},
		60_000,
	);
});

describe("snapshot write policy", () => {
	const base: SnapshotWritePolicyInput = {
		hasSnapshotConfig: true,
		pendingRestore: false,
		restoreWriteBlocked: false,
		unrestoredNames: [],
		preserveNamesSupported: false,
	};

	const cases = [
		{
			name: "no snapshot target configured",
			input: { ...base, hasSnapshotConfig: false },
			expected: { write: false, reason: "no-snapshot-config" },
		},
		{
			name: "restore has not run yet (positive control: today's semantics)",
			input: { ...base, pendingRestore: true, unrestoredNames: ["bad"] },
			expected: { write: false, reason: "restore-pending" },
		},
		{
			name: "whole payload failed to load and could not be isolated",
			input: { ...base, restoreWriteBlocked: true },
			expected: { write: false, reason: "restore-write-blocked" },
		},
		{
			name: "unrestored names and a runtime that cannot preserve them",
			input: { ...base, unrestoredNames: ["bad"], preserveNamesSupported: false },
			expected: { write: false, reason: "unrestored-names-without-preserve" },
		},
		{
			name: "unrestored names and a runtime that preserves them",
			input: { ...base, unrestoredNames: ["bad", "worse"], preserveNamesSupported: true },
			expected: { write: true, preserveNames: ["bad", "worse"] },
		},
		{
			name: "fully restored namespace writes everything",
			input: { ...base, preserveNamesSupported: true },
			expected: { write: true, preserveNames: [] },
		},
		{
			name: "fully restored namespace writes everything on an older runtime too",
			input: { ...base, preserveNamesSupported: false },
			expected: { write: true, preserveNames: [] },
		},
		{
			name: "a pending restore outranks every other state",
			input: { ...base, pendingRestore: true, restoreWriteBlocked: true, preserveNamesSupported: true },
			expected: { write: false, reason: "restore-pending" },
		},
		{
			name: "an unisolated whole failure outranks preserve support",
			input: { ...base, restoreWriteBlocked: true, unrestoredNames: ["bad"], preserveNamesSupported: true },
			expected: { write: false, reason: "restore-write-blocked" },
		},
	] as const;

	it("decides per restore state and runtime capability", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(snapshotWritePolicy(testCase.input), testCase.name).toEqual(testCase.expected);
		}
	});

	it("does not let the caller mutate the policy's name list", () => {
		const names = ["bad"];
		const policy = snapshotWritePolicy({ ...base, unrestoredNames: names, preserveNamesSupported: true });
		expect(policy.write).toBe(true);
		if (policy.write) policy.preserveNames.push("injected");
		expect(names).toEqual(["bad"]);
	});
});

describe("restore notice wording", () => {
	const partial = (snapshotPolicy: RestoreResult["snapshotPolicy"]): RestoreResult => ({
		restored: ["kept"],
		failed: [{ name: "gone", reason: "ModuleNotFoundError" }],
		path: "/tmp/kernel-state.dill",
		...(snapshotPolicy ? { snapshotPolicy } : {}),
	});

	it("says the saved values are carried over when the runtime can preserve them", () => {
		const lines = restoreNoticeLines(partial("preserve-names"));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("These names are available again: kept.");
		expect(lines.join("\n")).toContain("must be recreated if needed: gone.");
		expect(lines.join("\n")).toContain("later snapshots carry them over as they are");
		expect(lines.join("\n")).not.toContain("writes stay paused");
	});

	it("says writes stay paused when the runtime cannot preserve them", () => {
		const lines = restoreNoticeLines(partial("write-blocked"));
		expect(lines.join("\n")).toContain("Snapshot writes stay paused for this session");
		expect(lines.join("\n")).not.toContain("carry them over");
	});

	it("names the names the snapshot never saved, with the reason the writer gave", () => {
		const lines = restoreNoticeLines({
			restored: ["kept"],
			failed: [],
			notSaved: [
				{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" },
				{ name: "huge", reason: "exceeds per-variable snapshot size cap" },
			],
			path: "/tmp/kernel-state.dill",
		});
		const text = lines.join("\n");
		expect(text).toContain("never saved into it");
		expect(text).toContain("gen (TypeError: cannot pickle 'generator' object)");
		expect(text).toContain("huge (exceeds per-variable snapshot size cap)");
		// A name the payload never held is not a restore failure, so it must not be described as one.
		expect(text).not.toContain("could not be restored");
	});

	it("keeps the fresh-start and whole-failure wording", () => {
		const lines = restoreNoticeLines({
			restored: [],
			failed: [],
			path: "/tmp/kernel-state.dill",
			error: "load failed: truncated payload",
		});
		expect(lines.join("\n")).toContain("could not be revived; the kernel is starting fresh");
		expect(lines.join("\n")).toContain("Restore failure: load failed: truncated payload.");
		expect(lines.join("\n")).not.toContain("must be recreated");
	});
});

describe("snapshot manifest reading", () => {
	it("reads the write's own record and drops the names the payload still holds", () => {
		const path = join(tempDir, "manifest.json");
		const stamp = "2026-01-02T03:04:05.000Z";
		writeFileSync(
			path,
			JSON.stringify({
				savedNames: ["kept"],
				skipped: [
					{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" },
					// Carried over verbatim from an older payload: it is in the payload, so calling it
					// unsaved would contradict the restore that reports it through failed/restored.
					{ name: "carried", reason: "preserved blob unavailable" },
				],
				preserved: ["carried"],
				timestamp: stamp,
			}),
		);
		const facts = readSnapshotManifest(path);
		expect(facts).not.toBeNull();
		expect(facts?.savedNames).toEqual(["kept"]);
		expect(facts?.notSaved).toEqual([{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" }]);
		expect(facts?.writtenAtMs).toBe(Date.parse(stamp));
	});

	it("returns null for a missing, torn, or foreign manifest instead of inventing facts", () => {
		expect(readSnapshotManifest(join(tempDir, "never-written.json"))).toBeNull();
		const torn = join(tempDir, "torn.json");
		writeFileSync(torn, "{ not json");
		expect(readSnapshotManifest(torn)).toBeNull();
		const foreign = join(tempDir, "foreign.json");
		writeFileSync(foreign, JSON.stringify({ hello: "world" }));
		const facts = readSnapshotManifest(foreign);
		expect(facts?.savedNames).toEqual([]);
		expect(facts?.notSaved).toEqual([]);
		expect(facts?.writtenAtMs).toBeUndefined();
	});
});
