import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";
let entries: LogEntry[] = [];
let snapshotPath = "";
let manifestPath = "";
let requestLogPath = "";

/** What a resumed session would find on disk: a payload that was never proven unloadable. */
const PAYLOAD = "payload from the previous session";
const MANIFEST = '{"savedNames":["df","model"]}';

function logMessages(message: string): LogEntry[] {
	return entries.filter((entry) => entry.msg === message);
}

/**
 * A node stand-in for the REPL runtime. A restore either hangs (so a teardown can interrupt it
 * mid-load) or, when the host interrupts it, answers the way an interrupted runtime does: a done
 * frame carrying an error. Every request it receives is logged, so the assertions are about what
 * the host asked for and what stayed on disk.
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
			"const log = (request) =>",
			"  fs.appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify({ type: request.type }) + '\\n');",
			"send({",
			"  event: 'ready',",
			"  protocol: Number(process.env.FAKE_PROTOCOL || 4),",
			"  python: '3.11.0',",
			"  capabilities: list(process.env.FAKE_CAPABILITIES),",
			"});",
			"let buffered = '';",
			"let pendingRestoreId = null;",
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
			"  log(req);",
			// The real runtime exits once its shutdown hook ran. The reply is flushed first: an
			// exit the host reads before the done frame would look like a death it did not order.
			"  if (req.type === 'shutdown') {",
			"    const frame = JSON.stringify({ event: 'done', id: req.id, status: 'ok' }) + '\\n';",
			"    process.stdout.write(frame, () => process.exit(0));",
			"    return undefined;",
			"  }",
			"  if (req.type === 'interrupt') {",
			"    if (pendingRestoreId === null) return undefined;",
			"    const id = pendingRestoreId;",
			"    pendingRestoreId = null;",
			"    return send({ event: 'done', id, status: 'error', reason: 'KeyboardInterrupt' });",
			"  }",
			"  if (req.type === 'restore') {",
			"    if (process.env.FAKE_RESTORE_ERROR) {",
			"      return send({ event: 'done', id: req.id, status: 'error', reason: process.env.FAKE_RESTORE_ERROR });",
			"    }",
			"    pendingRestoreId = req.id;",
			"    return undefined;",
			"  }",
			"  if (req.type === 'snapshot') {",
			"    fs.writeFileSync(process.env.FAKE_SNAPSHOT_PATH, 'payload of a namespace that never restored');",
			"    fs.writeFileSync(process.env.FAKE_MANIFEST_PATH, JSON.stringify({ savedNames: [] }));",
			"    return send({ event: 'done', id: req.id, status: 'ok', saved: [], skipped: [], bytes: 44 });",
			"  }",
			"  return send({ event: 'done', id: req.id, status: 'ok' });",
			"}",
			"",
		].join("\n"),
	);
	chmodSync(script, 0o755);
	return script;
}

function newManager(fakeKernel: string, env: Record<string, string>): ReplKernelManager {
	return new ReplKernelManager({
		python: fakeKernel,
		cwd: tempDir,
		sessionId: "session-restore-teardown",
		env: {
			FAKE_SNAPSHOT_PATH: snapshotPath,
			FAKE_MANIFEST_PATH: manifestPath,
			FAKE_REQUEST_LOG: requestLogPath,
			...env,
		},
		snapshot: { path: snapshotPath, manifestPath, restoreTimeoutMs: 20_000 },
	});
}

function requestTypes(): string[] {
	if (!existsSync(requestLogPath)) return [];
	return readFileSync(requestLogPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { type: string }).type);
}

/** Wait until the runtime has seen `count` requests of `type`, so a teardown lands mid-restore. */
async function waitForRequests(type: string, count = 1, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (requestTypes().filter((seen) => seen === type).length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${count} ${type} request(s); saw: ${JSON.stringify(requestTypes())}`);
}

function isolatedFiles(): string[] {
	return readdirSync(tempDir).filter((name) => name.includes(".corrupt-"));
}

/** The saved namespace is exactly what the previous session left, under its real name. */
function expectSnapshotUntouched(): void {
	expect(readFileSync(snapshotPath, "utf8")).toBe(PAYLOAD);
	expect(readFileSync(manifestPath, "utf8")).toBe(MANIFEST);
	expect(isolatedFiles()).toEqual([]);
}

function expectNoCorruptionVerdict(): void {
	expect(logMessages("kernel state restore failed; snapshot isolated")).toHaveLength(0);
	expect(logMessages("kernel state restore failed; snapshot could not be isolated")).toHaveLength(0);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-restore-teardown-"));
	snapshotPath = join(tempDir, "kernel-state.dill");
	manifestPath = join(tempDir, "kernel-state.json");
	requestLogPath = join(tempDir, "kernel-requests.log");
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
	writeFileSync(snapshotPath, PAYLOAD);
	writeFileSync(manifestPath, MANIFEST);
});

afterEach(() => {
	setLogSink(undefined);
	if (tempDir) {
		chmodSync(tempDir, 0o755);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("kernel teardown during a state restore", () => {
	it("keeps the snapshot when kill() interrupts the load", async () => {
		const manager = newManager(writeFakeKernel(), {});
		try {
			await manager.start();
			const restore = manager.restoreState();
			await waitForRequests("restore");

			await manager.kill();

			await expect(restore).resolves.toBeNull();
			expectSnapshotUntouched();
			expectNoCorruptionVerdict();
			expect(logMessages("kernel state restore interrupted by teardown; snapshot kept")).toHaveLength(1);
			expect(logMessages("kernel state restore interrupted by teardown; snapshot kept")[0]?.path).toBe(snapshotPath);
		} finally {
			await manager.shutdown({}).catch(() => undefined);
		}
	}, 60_000);

	it("keeps the snapshot when disposeSync() interrupts the load", async () => {
		const manager = newManager(writeFakeKernel(), {});
		try {
			await manager.start();
			const restore = manager.restoreState();
			await waitForRequests("restore");

			manager.disposeSync();

			await expect(restore).resolves.toBeNull();
			expectSnapshotUntouched();
			expectNoCorruptionVerdict();
			expect(logMessages("kernel state restore interrupted by teardown; snapshot kept")).toHaveLength(1);
		} finally {
			await manager.shutdown({}).catch(() => undefined);
		}
	}, 60_000);

	it("keeps the snapshot when a dispose flush interrupts the load, and does not overwrite it", async () => {
		// The interrupt answers as a failed load, which is the shape a corrupt payload has too:
		// the teardown must not be spent as a corruption verdict, and the final snapshot of a
		// namespace that never caught up with the payload must not replace it.
		const manager = newManager(writeFakeKernel(), { FAKE_CAPABILITIES: "preserve_names" });
		try {
			await manager.start();
			const restore = manager.restoreState();
			await waitForRequests("restore");

			await expect(manager.shutdown({ snapshot: true, drainHostRequests: true })).resolves.toBe(true);

			await expect(restore).resolves.toBeNull();
			expectSnapshotUntouched();
			expectNoCorruptionVerdict();
			expect(requestTypes()).not.toContain("snapshot");
			expect(logMessages("kernel state snapshot skipped")).toHaveLength(1);
			expect(logMessages("kernel state snapshot skipped")[0]?.reason).toBe("restore-write-blocked");
		} finally {
			await manager.shutdown({}).catch(() => undefined);
		}
	}, 60_000);

	it("still isolates a payload the runtime could not load", async () => {
		const manager = newManager(writeFakeKernel(), { FAKE_RESTORE_ERROR: "bad pickle" });
		try {
			await manager.start();

			await expect(manager.restoreState()).resolves.toBeNull();

			expect(logMessages("kernel state restore failed; snapshot isolated")).toHaveLength(1);
			expect(logMessages("kernel state restore interrupted by teardown; snapshot kept")).toHaveLength(0);
			expect(existsSync(snapshotPath)).toBe(false);
			expect(existsSync(manifestPath)).toBe(false);
			const isolated = isolatedFiles();
			expect(isolated).toHaveLength(2);
			const isolatedPayload = isolated.find((name) => name.startsWith("kernel-state.dill.corrupt-"));
			expect(isolatedPayload).toBeDefined();
			expect(readFileSync(join(tempDir, isolatedPayload!), "utf8")).toBe(PAYLOAD);
		} finally {
			await manager.shutdown({}).catch(() => undefined);
		}
	}, 60_000);
});
