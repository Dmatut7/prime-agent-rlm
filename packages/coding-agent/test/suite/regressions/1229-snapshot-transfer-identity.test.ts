import { describe, expect, it } from "vitest";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";

/**
 * A snapshot id names one transfer. When it was derived from the event cursor
 * alone, two snapshots taken at the same cursor shared an id while holding
 * different bytes — live state moves on without advancing the sequence. The
 * supervisor reads a repeated id whose bytes differ as corruption, closes the
 * worker channel and leaves the worker recovering, which fails the
 * get_connection_state read behind the context indicator.
 */

function stateAtCursor(activeSessionId: string, eventGeneration: string, lastEventSequence: number) {
	return { activeSessionId, eventGeneration, lastEventSequence } as ActiveSessionState;
}

function nextSnapshotId(daemon: AgentDaemon, state: ActiveSessionState): string {
	return (daemon as unknown as { nextSnapshotId(state: ActiveSessionState): string }).nextSnapshotId(state);
}

function createDaemon(socket: string): AgentDaemon {
	return new AgentDaemon(socket, {
		defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unused");
		},
	} as never);
}

describe("ENG-1229 snapshot transfer identity", () => {
	it("gives two transfers at one cursor separate ids", () => {
		const daemon = createDaemon("/tmp/eng-1229-identity.sock");
		const state = stateAtCursor("active-1229", "generation-a", 4242);

		const first = nextSnapshotId(daemon, state);
		const second = nextSnapshotId(daemon, state);

		expect(first).not.toBe(second);
		// The cursor stays in the id so a log line still says where a transfer sat.
		expect(first).toContain("active-1229-generation-a-4242");
		expect(second).toContain("active-1229-generation-a-4242");
	});

	it("counts per session, so sessions cannot collide with each other", () => {
		const daemon = createDaemon("/tmp/eng-1229-per-session.sock");
		const one = stateAtCursor("active-one", "generation-a", 1);
		const two = stateAtCursor("active-two", "generation-a", 1);

		const ids = [nextSnapshotId(daemon, one), nextSnapshotId(daemon, two), nextSnapshotId(daemon, one)];

		expect(new Set(ids).size).toBe(3);
		expect(one.snapshotTransferSeq).toBe(2);
		expect(two.snapshotTransferSeq).toBe(1);
	});

	it("keeps ids safe to use as a spill directory name", () => {
		const daemon = createDaemon("/tmp/eng-1229-path-safe.sock");
		const state = stateAtCursor("active-1229", "generation-a", 7);

		// SnapshotTranscriptCache sanitizes anything else into "_", which would
		// fold distinct ids onto one directory.
		expect(nextSnapshotId(daemon, state)).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});
