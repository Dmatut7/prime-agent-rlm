import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import type { SessionHeader } from "../src/core/session-manager.js";
import { AgentRoster } from "../src/modes/daemon/agent-roster.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { ResidentWorker } from "../src/modes/daemon/daemon-supervisor.js";
import {
	DaemonRosterSyncState,
	type DaemonSupervisorRosterSyncHost,
	seedAdoptingWorkerRosterRows,
} from "../src/modes/daemon/daemon-supervisor-roster-sync.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "roster-seed-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * A hand-written transcript in the on-disk format `readSessionInfo` scans, so the
 * seed's session-file read runs against the real scanner on real bytes.
 */
function writeSessionFile(dir: string, id: string, messages: number, name?: string): string {
	const header: SessionHeader = {
		type: "session",
		id,
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp/project",
	};
	const lines: string[] = [JSON.stringify(header)];
	if (name !== undefined) {
		lines.push(JSON.stringify({ type: "session_info", id: `${id}-name`, parentId: null, name }));
	}
	for (let index = 0; index < messages; index++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${id}-${index}`,
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
			}),
		);
	}
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return path;
}

function makeWorker(options: { workerId: string; rootSessionId: string; sessionFile?: string }): ResidentWorker {
	const descriptor: DaemonWorkerDescriptor = {
		version: 2,
		workerId: options.workerId,
		pid: 123,
		socketPath: "/tmp/worker.sock",
		recoveryJournalPath: "/tmp/recovery.jsonl",
		supervisorSocketPath: "/tmp/supervisor.sock",
		authenticationToken: "token",
		rootActiveSessionId: `active-${options.workerId}`,
		rootSessionId: options.rootSessionId,
		...(options.sessionFile !== undefined ? { sessionFile: options.sessionFile } : {}),
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lifecycle: "recovering",
		createCommand: { type: "create" },
		consecutiveFailures: 0,
	};
	return {
		descriptor,
		descriptorPath: "/tmp/worker.json",
		summaries: new Map<string, SessionSummary>(),
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	} as ResidentWorker;
}

/**
 * The roster-sync host with only the members the seed path reads, over a real
 * AgentRoster store; the supervisor-facing types are structural seams, not the
 * class under test, so the fixture builds them directly.
 */
function makeHost(...workers: ResidentWorker[]): { host: DaemonSupervisorRosterSyncHost; roster: AgentRoster } {
	const roster = new AgentRoster(canonicalSessionPath);
	const host = {
		rosterSyncState: new DaemonRosterSyncState(),
		workers: new Map(workers.map((worker) => [worker.descriptor.workerId, worker])),
		clients: new Set(),
		shuttingDown: false,
		defaultSessionConfig: { cwd: "/tmp/project" },
		log: () => {},
		background: () => {},
		write: () => {},
		isVisibleWorker: () => true,
		isWorkerStopping: () => false,
		rlmSpawnLedger: () => ({ liveEdges: async () => [] }),
		hydratedSeedEntry: async <T>(entry: T) => entry,
		persistWorker: () => {},
		refreshWorkerSummaries: async () => {},
		evictEmptySessionOnLastDetach: async () => {},
		ensureRosterStore: () => roster,
		consumeWorkerRosterDelta: () => {},
	} as unknown as DaemonSupervisorRosterSyncHost;
	return { host, roster };
}

function seededEntry(roster: AgentRoster, sessionId: string) {
	return [...roster.values()].find((entry) => entry.summary.sessionId === sessionId);
}

describe("seedAdoptingWorkerRosterRows", () => {
	it("seeds a zero-message worker root as a draft so a named draft never flashes live", async () => {
		const dir = makeTempDir();
		const draftFile = writeSessionFile(dir, "named-draft", 0, "named draft");
		const { host, roster } = makeHost(
			makeWorker({ workerId: "w1", rootSessionId: "named-draft", sessionFile: draftFile }),
		);

		await seedAdoptingWorkerRosterRows(host);

		const entry = seededEntry(roster, "named-draft");
		expect(entry).toBeDefined();
		// The row is still born (park path / adoption dedup) and still recovering;
		// only its durable lifecycle is honest now.
		expect(entry?.statusLabel).toBe("recovering");
		expect(entry?.summary.lifecycle).toBe("draft");
		expect(entry?.summary.messageCount).toBe(0);
	});

	it("keeps a seeded row live when the worker's session has messages", async () => {
		const dir = makeTempDir();
		const liveFile = writeSessionFile(dir, "live-root", 2, "real work");
		const { host, roster } = makeHost(
			makeWorker({ workerId: "w2", rootSessionId: "live-root", sessionFile: liveFile }),
		);

		await seedAdoptingWorkerRosterRows(host);

		const entry = seededEntry(roster, "live-root");
		expect(entry).toBeDefined();
		expect(entry?.summary.lifecycle).toBe("live");
		expect(entry?.summary.messageCount).toBe(2);
		expect(entry?.statusLabel).toBe("recovering");
	});

	it("falls back to live when the worker's session file cannot be read", async () => {
		const { host, roster } = makeHost(
			makeWorker({ workerId: "w3", rootSessionId: "unreadable", sessionFile: "/tmp/does-not-exist.jsonl" }),
		);

		await seedAdoptingWorkerRosterRows(host);

		const entry = seededEntry(roster, "unreadable");
		expect(entry).toBeDefined();
		// An unreadable transcript for a registered, recovering worker keeps the
		// L3 visibility intent: the row must still show while adoption settles.
		expect(entry?.summary.lifecycle).toBe("live");
	});
});
