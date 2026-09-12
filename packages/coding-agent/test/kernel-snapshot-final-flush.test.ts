import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";
let snapshotPath = "";
let manifestPath = "";
let requestLogPath = "";

/**
 * A node stand-in for the REPL runtime that records every snapshot request it receives, so
 * these assertions are about what the host asked for. The runtime's replay shortcut is a
 * fingerprint (identity + epochs + on-disk facts), and an in-place mutation by a background
 * thread between two snapshots is invisible to it; the host therefore marks its terminal
 * dispose flush `final` and the runtime writes that one through.
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
			"send({ event: 'ready', protocol: Number(process.env.FAKE_PROTOCOL || 4), python: '3.11.0', capabilities: [] });",
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
			"  if (req.type === 'snapshot') {",
			"    fs.appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(req) + '\\n');",
			"    fs.writeFileSync(process.env.FAKE_SNAPSHOT_PATH, 'payload');",
			"    fs.writeFileSync(process.env.FAKE_MANIFEST_PATH, JSON.stringify({ savedNames: ['x'] }));",
			"    return send({ event: 'done', id: req.id, status: 'ok', saved: ['x'], skipped: [], bytes: 7 });",
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

function newManager(fakeKernel: string, env: Record<string, string> = {}): ReplKernelManager {
	return new ReplKernelManager({
		python: fakeKernel,
		cwd: tempDir,
		sessionId: "session-final-flush",
		env: {
			FAKE_SNAPSHOT_PATH: snapshotPath,
			FAKE_MANIFEST_PATH: manifestPath,
			FAKE_REQUEST_LOG: requestLogPath,
			...env,
		},
		snapshot: { path: snapshotPath, manifestPath },
	});
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-final-flush-"));
	snapshotPath = join(tempDir, "kernel-state.dill");
	manifestPath = join(tempDir, "kernel-state.json");
	requestLogPath = join(tempDir, "snapshot-requests.log");
});

afterEach(() => {
	if (tempDir) {
		chmodSync(tempDir, 0o755);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("terminal snapshot flush", () => {
	it("marks only the dispose flush final, leaving the hot paths replayable", async () => {
		const manager = newManager(writeFakeKernel());
		try {
			await manager.start();

			// Ordinary writes stay replayable: the per-cell debounce and an explicit save are
			// the requests the shortcut exists to skip.
			await expect(manager.snapshotState()).resolves.not.toBeNull();
			await expect(manager.pruneOversizedVariables()).resolves.not.toBeNull();
			const ordinary = snapshotRequests();
			expect(ordinary).toHaveLength(2);
			for (const request of ordinary) {
				expect("final" in request, JSON.stringify(request)).toBe(false);
			}
			expect(ordinary[1]?.prune_oversized).toBe(true);

			await manager.shutdown({ snapshot: true });
			const all = snapshotRequests();
			expect(all).toHaveLength(3);
			expect(all[2]?.final).toBe(true);
			expect(all[2]?.prune_oversized).toBe(false);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);

	it("sends final to a runtime that negotiated the older protocol too", async () => {
		// Deliberately ungated: a runtime without the replay shortcut has nothing to bypass,
		// so an ignored `final` degrades to the full write it already performs.
		const manager = newManager(writeFakeKernel(), { FAKE_PROTOCOL: "3" });
		try {
			await manager.start();
			await manager.shutdown({ snapshot: true });
			const all = snapshotRequests();
			expect(all).toHaveLength(1);
			expect(all[0]?.final).toBe(true);
		} finally {
			await manager.shutdown({});
		}
	}, 60_000);
});
