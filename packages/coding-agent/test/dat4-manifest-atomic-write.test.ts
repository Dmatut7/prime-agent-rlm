import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonUpdateRestartManifest } from "../src/modes/daemon/daemon-protocol.js";
import { writeUpdateRestartManifestFile } from "../src/modes/daemon/update-restart-manifest.js";

/**
 * DAT-4: the update-restart manifest used to be written directly to its final path.
 * prompt-admission.ts promises queued work "must survive into the restart manifest",
 * and the supervisor's reader swallows a parse error as "no manifest" - so a write torn
 * mid-way left half a manifest at the final path and silently dropped every queued
 * session across the restart. The writer must be atomic: a torn write leaves the old
 * manifest intact, never a partial file at the final path.
 */

const torn = vi.hoisted(() => ({ write: false }));

/**
 * The injection targets the syscall the writer actually makes. `writePrivateFileAtomic`
 * fills a temp file with openSync + writeSync + fsyncSync and renames it into place; it
 * never calls `writeFileSync`. Mocking `writeFileSync` therefore injected nothing once
 * the writer switched to the looping `writeAllSync` (upstream #2276 append half,
 * 69fb8ead6): the assertion failed with "expected [Function] to throw" - the injection
 * was dead, not the writer torn - in CI and in an isolated run alike. Injecting at
 * `writeSync` keeps the original crash shape (half the bytes land, then the writer dies)
 * pointed at the code that now performs the write.
 */
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const rawWriteSync = actual.writeSync as unknown as (...args: unknown[]) => number;
	const writeSync = ((...args: unknown[]) => {
		if (!torn.write) return rawWriteSync(...args);
		// Half the bytes land, then the writer dies (short write / ENOSPC).
		// `writeAllSync` loops on a short *count*, so the death has to be the throw -
		// the same shape the original injection spelled.
		const [fd, buffer, offset, length] = args as [number, Uint8Array, number, number];
		rawWriteSync(fd, buffer, offset, Math.floor(length / 2));
		throw new Error("simulated torn write");
	}) as typeof actual.writeSync;
	return { ...actual, writeSync };
});

function manifest(sessionId: string): DaemonUpdateRestartManifest {
	return {
		formatVersion: 1,
		sessions: [
			{
				activeSessionId: sessionId,
				sessionFile: `/tmp/sessions/${sessionId}.jsonl`,
			},
		],
	} as DaemonUpdateRestartManifest;
}

const roots: string[] = [];

afterEach(() => {
	torn.write = false;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("writeUpdateRestartManifestFile", () => {
	it("keeps the previous manifest intact when the write is torn mid-way", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-dat4-"));
		roots.push(root);
		const path = join(root, "manifest.json");
		writeFileSync(path, `${JSON.stringify(manifest("old-session"))}\n`);
		torn.write = true;

		// Positive control: the injection really tears a payload that is written straight
		// at its target - the shape this writer used to have - so the green below is the
		// writer's temp-and-rename atomicity and not an injection that fired nothing,
		// which is exactly how the previous injection rotted unnoticed.
		const controlPath = join(root, "direct-write.json");
		const controlBytes = Buffer.from(`${JSON.stringify(manifest("new-session"))}\n`);
		const controlFd = openSync(controlPath, "w", 0o600);
		try {
			expect(() => writeSync(controlFd, controlBytes, 0, controlBytes.length)).toThrow("simulated torn write");
		} finally {
			closeSync(controlFd);
		}
		const tornBytes = readFileSync(controlPath);
		expect(tornBytes.length).toBeGreaterThan(0);
		expect(tornBytes.length).toBeLessThan(controlBytes.length);
		expect(controlBytes.subarray(0, tornBytes.length).equals(tornBytes)).toBe(true);

		expect(() => writeUpdateRestartManifestFile(path, manifest("new-session"))).toThrow("simulated torn write");

		// The final path holds a complete manifest - the old one, never a prefix.
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as DaemonUpdateRestartManifest;
		expect(onDisk.sessions[0]?.activeSessionId).toBe("old-session");
		// No temp residue: the writer cleans up after a failed write.
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("writes the new manifest when the write completes", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-dat4-"));
		roots.push(root);
		const path = join(root, "manifest.json");

		writeUpdateRestartManifestFile(path, manifest("new-session"));

		const onDisk = JSON.parse(readFileSync(path, "utf8")) as DaemonUpdateRestartManifest;
		expect(onDisk.sessions[0]?.activeSessionId).toBe("new-session");
	});
});
