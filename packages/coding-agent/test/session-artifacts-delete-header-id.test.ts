import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	readSessionArtifactTombstones,
	resetSessionArtifactTombstoneCache,
} from "../src/core/session-artifact-tombstones.js";
import { deleteSessionFile } from "../src/core/session-file-actions.js";
import { SessionManager } from "../src/core/session-manager.js";

/**
 * A transcript's session id is the header's `id`, and that id - not the file name - names its
 * artifact directory. A file whose basename is not its header id therefore has to be located by
 * what the running session actually wrote. Before the fix the delete path derived the id from
 * `basename(file)`, so it aimed at a directory that never existed: the kernel snapshot, the
 * durable schedule and every sub-agent directory under the real id stayed forever, and the
 * tombstone was filed under the wrong id.
 */

let root = "";
let sessionsDir = "";
let artifactsRoot = "";
let savedAgentDirEnv: string | undefined;

beforeEach(() => {
	savedAgentDirEnv = process.env[ENV_AGENT_DIR];
	root = mkdtempSync(join(tmpdir(), "prime-artifact-header-id-"));
	sessionsDir = join(root, "sessions");
	artifactsRoot = join(root, "session-artifacts");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
	chmodSync(artifactsRoot, 0o700);
	process.env[ENV_AGENT_DIR] = root;
	resetSessionArtifactTombstoneCache();
});

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	resetSessionArtifactTombstoneCache();
	rmSync(root, { recursive: true, force: true });
	root = "";
});

/** A real transcript whose file name is `fileStem.jsonl` and whose header id is its own. */
function writeTranscript(fileStem: string, text: string): { path: string; headerId: string } {
	const scratch = join(root, `.scratch-${fileStem}`);
	mkdirSync(scratch, { recursive: true });
	const manager = SessionManager.create(root, scratch);
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	manager.flushNow();
	const headerId = manager.getSessionId();
	const created = manager.getSessionFile();
	if (!created) throw new Error("scratch transcript was never written");
	mkdirSync(sessionsDir, { recursive: true });
	const path = join(sessionsDir, `${fileStem}.jsonl`);
	renameInto(created, path);
	rmSync(scratch, { recursive: true, force: true });
	return { path, headerId };
}

/** Move a transcript to another path without touching its header, i.e. a rename. */
function renameInto(from: string, to: string): void {
	renameSync(from, to);
}

/** Everything a live session leaves in its artifact directory, incl. one sub-agent. */
function writeArtifacts(ownerId: string): string {
	const artifactDir = join(artifactsRoot, ownerId);
	mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	chmodSync(artifactDir, 0o700);
	writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");
	writeFileSync(join(artifactDir, "kernel-state.json"), "{}");
	writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');
	writeFileSync(join(artifactDir, "rlm-subagents.jsonl"), "");
	const childDir = join(artifactDir, "sub-01234567");
	mkdirSync(childDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(childDir, "child-transcript.jsonl"), "{}\n");
	// A grandchild artifact root hangs off the same directory, the way the runtime writes it.
	const grandchild = join(artifactDir, "session-artifacts", "child-session-id");
	mkdirSync(grandchild, { recursive: true, mode: 0o700 });
	writeFileSync(join(grandchild, "kernel-state.dill"), "payload");
	return artifactDir;
}

describe("session deletion resolves the artifact directory by header id", () => {
	it("clears the artifact tree of a transcript whose file name is not its session id (IT-2)", async () => {
		const { path, headerId } = writeTranscript("handoff-export", "original transcript");
		expect(headerId).not.toBe("handoff-export");
		const artifactDir = writeArtifacts(headerId);

		const result = await deleteSessionFile(path);

		expect(result.ok).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(artifactDir), "artifact dir named by the header id").toBe(false);
		expect(readdirSync(artifactsRoot).filter((entry) => entry === headerId)).toEqual([]);
		// The tombstone - what the cron store and the retention sweep read - must be filed under
		// the id the artifacts actually live at, not under the file stem.
		const tombstones = readSessionArtifactTombstones(artifactsRoot);
		expect(tombstones.get(headerId)?.reason).toBe("session-deleted");
		expect(tombstones.has("handoff-export")).toBe(false);
	});

	it("control: a transcript named after its id still deletes the same directory (IT-2)", async () => {
		const { path, headerId } = writeTranscript("plain", "control transcript");
		const nameAligned = join(sessionsDir, `${headerId}.jsonl`);
		renameInto(path, nameAligned);
		const artifactDir = writeArtifacts(headerId);

		const result = await deleteSessionFile(nameAligned);

		expect(result.ok).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
		expect(readSessionArtifactTombstones(artifactsRoot).get(headerId)?.reason).toBe("session-deleted");
	});

	it("control: an unreadable transcript still falls back to the file name", async () => {
		const legacy = join(sessionsDir, "legacy-stem.jsonl");
		writeFileSync(legacy, '{"type":"session"}\n');
		const artifactDir = writeArtifacts("legacy-stem");

		const result = await deleteSessionFile(legacy);

		expect(result.ok).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
	});
});
