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
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	type DaemonAttachResult,
	type DaemonOutbound,
	type DaemonSessionSnapshotQuotaPark,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { quotaParkWireFacts, readQuotaParkStatus } from "../src/modes/daemon/quota-park-status.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

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

function parkEntry(data: {
	resumeAt: string;
	parkCount: number;
	provider?: string;
	quotaResumeAt?: string;
}): CustomEntry {
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

	it("prefers the real quota reset (quotaResumeAt) over the next probe wake (resumeAt)", () => {
		// 再审1-#4: a parked session probes before the provider's actual reset;
		// counting down to the probe would show a wake that does not restore quota.
		const probeAt = new Date(Date.now() + 60_000).toISOString();
		const quotaResumeAt = new Date(Date.now() + 3_600_000).toISOString();
		const branch: SessionEntry[] = [parkEntry({ resumeAt: probeAt, parkCount: 1, quotaResumeAt })];

		expect(readQuotaParkStatus(parkedSession(branch))).toEqual({
			resumeAtMs: Date.parse(quotaResumeAt),
			parkCount: 1,
		});
	});

	it("falls back to the probe wake when the entry carries no usable quotaResumeAt", () => {
		const resumeAt = new Date(Date.now() + 60_000).toISOString();
		const withInvalid = parkedSession([parkEntry({ resumeAt, parkCount: 1, quotaResumeAt: "not-a-date" })]);
		expect(readQuotaParkStatus(withInvalid)).toEqual({ resumeAtMs: Date.parse(resumeAt), parkCount: 1 });

		// Entries written before quotaResumeAt existed keep their old meaning.
		const legacy = parkedSession([parkEntry({ resumeAt, parkCount: 2 })]);
		expect(readQuotaParkStatus(legacy)).toEqual({ resumeAtMs: Date.parse(resumeAt), parkCount: 2 });
	});
});

describe("quotaParkWireFacts", () => {
	it("maps the park status into the shared wire shape", () => {
		const now = Date.now();
		expect(quotaParkWireFacts({ resumeAtMs: now + 60_000, parkCount: 3, provider: "openai" }, now)).toEqual({
			parked: true,
			resumeAt: new Date(now + 60_000).toISOString(),
			remainingMs: 60_000,
			parkCount: 3,
			provider: "openai",
		});
	});

	it("clamps remainingMs at 0 while the wake is firing", () => {
		const now = Date.now();
		expect(quotaParkWireFacts({ resumeAtMs: now - 1_000 }, now).remainingMs).toBe(0);
	});

	it("carries parked:true alone when the park has no persisted facts", () => {
		expect(quotaParkWireFacts({})).toEqual({ parked: true });
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

	it("makes quota_park_status client-declarable for the rev-43 snapshot field", () => {
		// R3-3: DaemonSessionSnapshot.quotaPark is filled only for clients that
		// declared the capability on attach, so it must survive normalization.
		expect(DAEMON_SUPPORTED_CLIENT_CAPABILITIES).toContain("quota_park_status");
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(43);
	});
});

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	noteQuotaParkTransition(state: ActiveSessionState, force?: boolean): void;
	announceQuotaParkAfterAttach(state: ActiveSessionState): void;
	sweepQuotaParkStatus(): void;
	quotaParkForSnapshot(
		state: ActiveSessionState,
		capabilities: ReadonlySet<string>,
	): DaemonSessionSnapshotQuotaPark | undefined;
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

describe("quota park snapshot field (R3-3)", () => {
	it("fills the attach snapshot park facts only for clients that declared the capability", () => {
		const { internals } = makeDaemon();
		const resumeAtMs = Date.now() + 3_600_000;
		const session = parkedSession([
			parkEntry({ resumeAt: new Date(resumeAtMs).toISOString(), parkCount: 2, provider: "anthropic" }),
		]);
		const state = makeParkedState("active-qp", session);
		internals.sessions.set("active-qp", state);

		const facts = internals.quotaParkForSnapshot(state, new Set(["quota_park_status"]));
		expect(facts).toMatchObject({
			parked: true,
			resumeAt: new Date(resumeAtMs).toISOString(),
			parkCount: 2,
			provider: "anthropic",
		});
		expect(facts?.remainingMs).toBeGreaterThan(3_600_000 - 60_000);
		expect(facts?.remainingMs).toBeLessThanOrEqual(3_600_000);

		// Clients that never declared the capability (and older daemons, which never
		// fill the field) see no key at all - absence reads as "not parked at
		// snapshot time" on both sides of a mixed-version pair.
		expect(internals.quotaParkForSnapshot(state, new Set(["slim_attach"]))).toBeUndefined();
		expect(internals.quotaParkForSnapshot(state, new Set())).toBeUndefined();
	});

	it("omits the snapshot field for a session that is not parked", () => {
		const { internals } = makeDaemon();
		const state = makeParkedState("active-qp-idle", parkedSession([], { value: false }));
		internals.sessions.set("active-qp-idle", state);

		expect(internals.quotaParkForSnapshot(state, new Set(["quota_park_status"]))).toBeUndefined();
	});

	it("forces a re-announce of an unchanged park after attach", () => {
		const { internals } = makeDaemon();
		const resumeAtMs = Date.now() + 3_600_000;
		const session = parkedSession([parkEntry({ resumeAt: new Date(resumeAtMs).toISOString(), parkCount: 1 })]);
		const state = makeParkedState("active-qp-attach", session);
		const { client, frames } = makeCapturingClient("viewer", "active-qp-attach");
		state.clients.add(client);
		internals.sessions.set("active-qp-attach", state);

		// The park was announced while nobody was attached (or before this client
		// joined): dedup suppresses a plain re-note, but the attach-time announce
		// must reach the client immediately instead of waiting out the sweep.
		internals.noteQuotaParkTransition(state);
		internals.announceQuotaParkAfterAttach(state);

		expect(frames).toHaveLength(2);
		expect(frames[1]).toMatchObject({
			type: "quota_park_status",
			parked: true,
			resumeAt: new Date(resumeAtMs).toISOString(),
		});
	});

	it("announces nothing after attach when the session is not parked or already gone", () => {
		const { internals } = makeDaemon();
		const idleState = makeParkedState("active-qp-idle-2", parkedSession([], { value: false }));
		internals.sessions.set("active-qp-idle-2", idleState);
		const { client, frames } = makeCapturingClient("viewer", "active-qp-idle-2");
		idleState.clients.add(client);

		internals.announceQuotaParkAfterAttach(idleState);
		expect(frames).toHaveLength(0);

		// A session that closed between attach and the deferred announce is dropped.
		const goneState = makeParkedState(
			"active-qp-gone",
			parkedSession([parkEntry({ resumeAt: new Date(Date.now() + 60_000).toISOString(), parkCount: 1 })]),
		);
		const { client: goneClient, frames: goneFrames } = makeCapturingClient("viewer-2", "active-qp-gone");
		goneState.clients.add(goneClient);
		internals.announceQuotaParkAfterAttach(goneState);
		expect(goneFrames).toHaveLength(0);
	});
});

describe("supervisor attach park-field gating", () => {
	const activeSessionId = "active-qp-serve";

	function makeSupervisorFixture() {
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-qp",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		const quotaPark: DaemonSessionSnapshotQuotaPark = {
			parked: true,
			resumeAt: new Date(Date.now() + 3_600_000).toISOString(),
			remainingMs: 3_600_000,
			parkCount: 1,
			provider: "anthropic",
		};
		// The supervisor's internal load declares quota_park_status, so the worker
		// fills the field and the cached snapshot carries it.
		const cached = {
			activeSessionId,
			snapshot: { summary, messages: [], quotaPark },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-qp", lifecycle: "ready", pid: 1234 },
			// A connected transport: requireAvailableWorkerClient refuses a client
			// whose socket is gone, which is the state this fixture must not be in.
			client: { isConnected: true },
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, cached]]),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed: vi.fn(), hasPartial: vi.fn(() => false), clear: vi.fn() },
			syncWorkerExtensionUi: vi.fn(async () => {}),
		}) as {
			attachClient(
				attachClient: typeof client,
				command: { type: "attach"; activeSessionId: string; capabilities?: string[] },
			): Promise<{ result: DaemonAttachResult }>;
		};
		seedSupervisorRoster(supervisor, worker);
		return { supervisor, worker, client, quotaPark };
	}

	it("keeps snapshot.quotaPark for a client that declared the capability", async () => {
		const { supervisor, client, quotaPark } = makeSupervisorFixture();
		const { result } = await supervisor.attachClient(client, {
			type: "attach",
			activeSessionId,
			capabilities: ["attach_snapshot", "event_sequence", "quota_park_status"],
		});
		expect(result.snapshot.quotaPark).toEqual(quotaPark);
	});

	it("strips snapshot.quotaPark for a client that never declared it, without mutating the cache", async () => {
		const { supervisor, worker, client, quotaPark } = makeSupervisorFixture();
		const { result } = await supervisor.attachClient(client, {
			type: "attach",
			activeSessionId,
			capabilities: ["attach_snapshot", "event_sequence"],
		});
		expect(result.snapshot.quotaPark).toBeUndefined();
		expect("quotaPark" in result.snapshot).toBe(false);
		// The cached snapshot keeps the field: a later capable attach is served from it.
		const cachedResult = worker.snapshotCache.get(activeSessionId) as DaemonAttachResult;
		expect(cachedResult.snapshot.quotaPark).toEqual(quotaPark);
	});
});
