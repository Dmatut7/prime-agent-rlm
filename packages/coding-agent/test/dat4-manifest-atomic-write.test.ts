import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const writeFileSync = ((target: import("node:fs").PathOrFileDescriptor, content: string) => {
		if (!torn.write) {
			return (actual.writeFileSync as unknown as (...args: unknown[]) => void)(target, content);
		}
		// The crash shape the direct write exposed: half the bytes land, then the
		// writer dies (short write / ENOSPC).
		const text = typeof content === "string" ? content : "";
		(actual.writeFileSync as unknown as (...args: unknown[]) => void)(
			target,
			text.slice(0, Math.floor(text.length / 2)),
		);
		throw new Error("simulated torn write");
	}) as typeof actual.writeFileSync;
	return { ...actual, writeFileSync };
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
