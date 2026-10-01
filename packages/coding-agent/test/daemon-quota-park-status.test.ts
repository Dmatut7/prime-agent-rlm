import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { CustomEntry, SessionEntry } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import { readQuotaParkStatus } from "../src/modes/daemon/quota-park-status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 中断-10: quota park status heartbeats. A parked session (provider usage reset,
 * up to 24h) used to be invisible; the daemon now announces the park, heartbeats
 * the remaining wait, and closes with parked:false. The daemon-side reader
 * rebuilds the park facts from the persisted branch entries, mirroring
 * agent-session.ts's own _restoreQuotaPark walk.
 */

let entrySeq = 0;
function entryBase(): { id: string; parentId: string | null; timestamp: string } {
	entrySeq += 1;
	return {
		id: `e${entrySeq}`,
		parentId: entrySeq > 1 ? `e${entrySeq - 1}` : null,
		timestamp: new Date().toISOString(),
	};
}

function parkEntry(data: { resumeAt: string; parkCount: number; provider?: string }): CustomEntry {
	return { ...entryBase(), type: "custom", customType: "provider_quota_park", data };
}

function resumeEntry(): CustomEntry {
	return { ...entryBase(), type: "custom", customType: "provider_quota_resume", data: { outcome: "wake" } };
}

function parkedSession(branch: SessionEntry[], parked: { value: boolean } = { value: true }): AgentSession {
	return {
		get isQuotaParked() {
			return parked.value;
		},
		sessionManager: { getBranch: () => branch },
	} as unknown as AgentSession;
}

describe("readQuotaParkStatus", () => {
	it("returns undefined for a session that is not parked", () => {
		expect(
			readQuotaParkStatus(
				parkedSession([parkEntry({ resumeAt: new Date(Date.now() + 60_000).toISOString(), parkCount: 1 })], {
					value: false,
				}),
			),
		).toBeUndefined();
	});

	it("reads the active park's wake facts from the newest park entry", () => {
		const resumeAt = new Date(Date.now() + 3_600_000).toISOString();
		const branch: SessionEntry[] = [
			parkEntry({ resumeAt: new Date(Date.now() + 60_000).toISOString(), parkCount: 1, provider: "anthropic" }),
			resumeEntry(),
			parkEntry({ resumeAt, parkCount: 2 }),
		];

		expect(readQuotaParkStatus(parkedSession(branch))).toEqual({ resumeAtMs: Date.parse(resumeAt), parkCount: 2 });
	});

	it("treats a resume entry newer than every park entry as a spent park", () => {
		const branch: SessionEntry[] = [
			parkEntry({ resumeAt: new Date(Date.now() + 60_000).toISOString(), parkCount: 1 }),
			resumeEntry(),
		];

		expect(readQuotaParkStatus(parkedSession(branch))).toBeUndefined();
	});

	it("reports a parked session with no persisted entry (in-memory sessions) without facts", () => {
		expect(readQuotaParkStatus(parkedSession([]))).toEqual({});
	});

	it("keeps the provider when the park entry carries one", () => {
		const resumeAt = new Date(Date.now() + 60_000).toISOString();
		const status = readQuotaParkStatus(parkedSession([parkEntry({ resumeAt, parkCount: 3, provider: "openai" })]));

		expect(status).toEqual({ resumeAtMs: Date.parse(resumeAt), parkCount: 3, provider: "openai" });
	});

	it("ignores unparseable park entries and keeps walking", () => {
		const resumeAt = new Date(Date.now() + 60_000).toISOString();
		const branch: SessionEntry[] = [
			parkEntry({ resumeAt, parkCount: 1 }),
			{ ...entryBase(), type: "custom", customType: "provider_quota_park", data: { resumeAt: "not-a-date" } },
		];

		expect(readQuotaParkStatus(parkedSession(branch))).toEqual({});
	});
});

describe("quota_park_status wire registration", () => {
	it("pins the entry type literals against the agent-session source they mirror", () => {
		// The constants are module-private in agent-session.ts; a rename there must
		// fail here instead of silently blind the daemon reader.
		const source = readFileSync(resolve(__dirname, "../src/core/agent-session.ts"), "utf8");
		expect(source).toContain('QUOTA_PARK_CUSTOM_ENTRY_TYPE = "provider_quota_park"');
		expect(source).toContain('QUOTA_RESUME_CUSTOM_ENTRY_TYPE = "provider_quota_resume"');
	});

	it("advertises the capability in the default server set", () => {
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("quota_park_status");
	});

	it("registers the outbound event at its introducing revision", () => {
		expect(DAEMON_OUTBOUND_COMPATIBILITY.quota_park_status).toEqual({
			minProtocol: 7,
			minSchemaRevision: 42,
			capability: "quota_park_status",
		});
	});
});

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	noteQuotaParkTransition(state: ActiveSessionState): void;
	sweepQuotaParkStatus(): void;
}

function makeCapturingClient(
	id: string,
	activeSessionId: string,
): { client: DaemonSocketClient; frames: DaemonOutbound[] } {
	const frames: DaemonOutbound[] = [];
	const client = {
		id,
		socket: {
			destroyed: false,
			write: vi.fn((data: string | Uint8Array) => {
				frames.push(JSON.parse(String(data)) as DaemonOutbound);
				return true;
			}),
			writableLength: 0,
		},
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		capabilities: new Set<string>(),
	} as unknown as DaemonSocketClient;
	return { client, frames };
}

function makeParkedState(activeSessionId: string, session: AgentSession): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set<DaemonSocketClient>(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "gen-1",
		lastEventSequence: 0,
		runtime: {
			metadata: { kind: "top-level", createdAt: 1 },
			session,
		},
	} as unknown as ActiveSessionState;
}

function makeDaemon(): { daemon: AgentDaemon; internals: DaemonInternals } {
	const daemon = new AgentDaemon("/tmp/prime-agent-quota-park-test.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-quota-park-test-agent", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return { daemon, internals: daemon as unknown as DaemonInternals };
}

describe("daemon quota park status events", () => {
	it("announces a parked session with the remaining wait, then closes with parked:false", () => {
		const { internals } = makeDaemon();
		const resumeAtMs = Date.now() + 3_600_000;
		const branch: SessionEntry[] = [
			parkEntry({ resumeAt: new Date(resumeAtMs).toISOString(), parkCount: 1, provider: "anthropic" }),
		];
		const parked = { value: true };
		const session = parkedSession(branch, parked);
		const state = makeParkedState("active-1", session);
		const { client, frames } = makeCapturingClient("viewer", "active-1");
		state.clients.add(client);
		internals.sessions.set("active-1", state);

		internals.noteQuotaParkTransition(state);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "quota_park_status",
			activeSessionId: "active-1",
			parked: true,
			resumeAt: new Date(resumeAtMs).toISOString(),
			parkCount: 1,
			provider: "anthropic",
		});
		const remainingMs = (frames[0] as { remainingMs?: number }).remainingMs;
		expect(remainingMs).toBeGreaterThan(3_600_000 - 60_000);
		expect(remainingMs).toBeLessThanOrEqual(3_600_000);

		// An unchanged park does not re-announce off every event.
		internals.noteQuotaParkTransition(state);
		expect(frames).toHaveLength(1);

		// The park lifts: one terminal parked:false, then silence.
		parked.value = false;
		internals.noteQuotaParkTransition(state);
		expect(frames).toHaveLength(2);
		expect(frames[1]).toEqual({ type: "quota_park_status", activeSessionId: "active-1", parked: false });

		internals.noteQuotaParkTransition(state);
		expect(frames).toHaveLength(2);
	});

	it("heartbeats every sweep while the park lasts", () => {
		const { internals } = makeDaemon();
		const resumeAtMs = Date.now() + 3_600_000;
		const session = parkedSession([parkEntry({ resumeAt: new Date(resumeAtMs).toISOString(), parkCount: 2 })]);
		const state = makeParkedState("active-2", session);
		const { client, frames } = makeCapturingClient("viewer", "active-2");
		state.clients.add(client);
		internals.sessions.set("active-2", state);

		internals.sweepQuotaParkStatus();
		internals.sweepQuotaParkStatus();

		expect(frames).toHaveLength(2);
		for (const frame of frames) {
			expect(frame).toMatchObject({
				type: "quota_park_status",
				activeSessionId: "active-2",
				parked: true,
				parkCount: 2,
			});
		}
	});

	it("re-announces when the wake moves to a new reset time", () => {
		const { internals } = makeDaemon();
		const firstResumeAtMs = Date.now() + 3_600_000;
		const branch: SessionEntry[] = [parkEntry({ resumeAt: new Date(firstResumeAtMs).toISOString(), parkCount: 1 })];
		const session = parkedSession(branch);
		const state = makeParkedState("active-3", session);
		const { client, frames } = makeCapturingClient("viewer", "active-3");
		state.clients.add(client);
		internals.sessions.set("active-3", state);

		internals.noteQuotaParkTransition(state);
		// A wake that fails to resume re-parks under a new entry with a new wake.
		const secondResumeAtMs = Date.now() + 7_200_000;
		branch.push(parkEntry({ resumeAt: new Date(secondResumeAtMs).toISOString(), parkCount: 1 }));
		internals.noteQuotaParkTransition(state);

		expect(frames).toHaveLength(2);
		expect(frames[1]).toMatchObject({ parked: true, resumeAt: new Date(secondResumeAtMs).toISOString() });
	});
});
