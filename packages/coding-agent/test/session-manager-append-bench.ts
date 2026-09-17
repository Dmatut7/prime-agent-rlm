/**
 * Bench for the session append hot path: the no-assistant guard must not
 * rescan every file entry on each append (upstream #2276's flip-once cache).
 *
 * Run directly (not under vitest):
 *   cd packages/coding-agent && npx tsx test/session-manager-append-bench.ts
 *
 * Red (pre-fix): per-append cost grows with the transcript size, because
 * `_persist` rescans fileEntries for an assistant message on every append.
 * Green (post-fix): flat across sizes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/core/session-manager.js";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

const SIZES = [1000, 5000, 20000];
const APPENDS = 200;

const tempDirs: string[] = [];
function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-append-bench-"));
	tempDirs.push(dir);
	return dir;
}

for (const size of SIZES) {
	const dir = createTempDir();
	const mgr = SessionManager.create(dir, join(dir, "sessions"));
	// No assistant message: every append is suppressed by the guard but still
	// indexed, so each one rescans the whole (growing) entry list for an
	// assistant match that never comes. That rescan is what the flip-once
	// cache (upstream #2276) removes from the append hot path.
	for (let i = 0; i < size; i++) {
		mgr.appendMessage(userMsg(`filler ${i}`));
	}
	const samples: number[] = [];
	for (let i = 0; i < APPENDS; i++) {
		const start = process.hrtime.bigint();
		mgr.appendMessage(userMsg(`bench ${i}`));
		samples.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	samples.sort((a, b) => a - b);
	const p50 = samples[Math.floor(samples.length * 0.5)]!;
	const p99 = samples[Math.floor(samples.length * 0.99)]!;
	console.log(
		`size=${size.toString().padStart(5)} appends=${APPENDS} p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
	);
	rmSync(dir, { recursive: true, force: true });
}
tempDirs.length = 0;
