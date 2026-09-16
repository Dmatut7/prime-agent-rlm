import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteSessionFile } from "../src/core/session-file-actions.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import * as sessionManagerModule from "../src/core/session-manager.js";
import { RlmSpawnLedger, tombstoneSavedSessionDelete } from "../src/modes/daemon/rlm-ledger.js";

const { SessionManager } = sessionManagerModule;

function makeRoots(root: string) {
	const sessionsDir = join(root, "sessions");
	const parent = SessionManager.create(root, sessionsDir);
	parent.newSession();
	parent.appendSessionInfo("parent");
	parent.flushNow();
	const parentFile = parent.getSessionFile();
	if (!parentFile) throw new Error("Missing parent session file");
	return { sessionsDir, parent, parentFile };
}

function makeChildSession(root: string, dir: string, parentFile: string, depth: number, name: string) {
	const manager = SessionManager.create(root, dir);
	manager.newSession({ parentSession: parentFile, rlmDepth: depth });
	manager.appendSessionInfo(name);
	manager.flushNow();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing child session file");
	return { manager, file };
}

// r38 LIFE-1: deleting a saved root session removes the whole artifact tree,
// including every child transcript, without any child-level delete path running.
// The ledger used to keep those child edges raw-live forever (225 edges / 10
// parents on the real machine), so the live edge count never fell back.
describe("rlm ledger - root teardown child edges (r38 LIFE-1)", () => {
	it("tombstones the deleted root's child edges so the live edge count falls back", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-root-teardown-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing parent artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "worker");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "worker",
			});
			// Positive control precondition: while the child directory exists the edge
			// is live in the raw and the reconciled view alike.
			expect(await ledger.edges()).toHaveLength(1);

			// The saved-root delete path: tombstone policy first, then the transcript
			// and the recursive artifact-tree remove.
			await tombstoneSavedSessionDelete(ledger, parentFile, { runtimeKind: "top-level" });
			const result = await deleteSessionFile(parentFile);
			expect(result.ok).toBe(true);
			expect(existsSync(child.file)).toBe(false);

			// Red before the fix: the child edge stays live forever because nothing
			// tombstoned it and the raw view never reconciles.
			expect(await ledger.edges()).toHaveLength(0);
			// The durable record: a parent-teardown delete for the child edge, not a
			// silent gap the next reader has to heal.
			const raw = readFileSync(ledger.ledgerPath, "utf8");
			expect(raw).toContain('"parent-teardown"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops edges whose child session directory is gone, read-side, without rewriting the ledger", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-dead-dir-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const other = SessionManager.create(root, sessionsDir);
			other.newSession();
			other.appendSessionInfo("other-root");
			other.flushNow();
			const otherFile = other.getSessionFile();
			if (!otherFile) throw new Error("Missing other session file");
			const artifactDir = parent.getSessionArtifactDir();
			const otherArtifactDir = other.getSessionArtifactDir();
			if (!artifactDir || !otherArtifactDir) throw new Error("Missing artifact dirs");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "worker");
			const survivor = makeChildSession(root, join(otherArtifactDir, "sub-22222222"), otherFile, 1, "survivor");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "worker",
			});
			await ledger.appendSpawn({
				childId: "sub-22222222",
				parent: otherFile,
				child: survivor.file,
				depth: 1,
				name: "survivor",
			});

			// The legacy-debt form: the child directory disappears with no tombstone,
			// exactly what a root teardown left behind before parent-teardown records.
			rmSync(join(artifactDir, "sub-11111111"), { recursive: true, force: true });

			// Red before the fix: both edges come back live. After: the gone-directory
			// edge is dropped from the live view while the survivor stays (positive
			// control: a live edge whose directory exists is served as-is).
			const edges = await ledger.edges();
			expect(edges.map((edge) => edge.name)).toEqual(["survivor"]);
			expect(edges[0]?.parent && canonicalSessionPath(edges[0]!.parent)).toBe(canonicalSessionPath(otherFile));
			// The judgement is read-side only: the durable ledger record still carries
			// both edges, so a cleanup retry can still tombstone the dead one.
			const raw = (await ledger.edges(true)).filter((edge) => !edge.deleted);
			expect(raw).toHaveLength(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
