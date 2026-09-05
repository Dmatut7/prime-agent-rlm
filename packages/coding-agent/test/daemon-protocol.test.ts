import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isDaemonSessionSummary } from "../src/cli/daemon-launch.js";
import {
	createDaemonCommandEnvelope,
	createDaemonEventEnvelope,
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_PLANE,
	DAEMON_CONTROL_PLANE_COMMANDS,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonCommandCompatibility,
	type DaemonDeclaredCapability,
	type DaemonOutbound,
	getDaemonCommandCompatibilities,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
	isSessionPlaneDaemonCommand,
	missingDeclaredCommandCapability,
	normalizeDeclaredCapabilities,
	salvageDaemonCommandId,
} from "../src/modes/daemon/daemon-protocol.js";
import {
	type DaemonWorkerDescriptor,
	durableDaemonWorkerDescriptor,
} from "../src/modes/daemon/daemon-worker-protocol.js";

describe("daemon protocol helpers", () => {
	it("serializes worker descriptors as identity-only version 2 state", () => {
		const descriptor = {
			version: 1,
			workerId: "worker",
			pid: 123,
			processStartId: "process-start",
			socketPath: "/tmp/worker.sock",
			recoveryJournalPath: "/state/recovery.jsonl",
			orphanProcessJournalPath: "/state/orphans.jsonl",
			supervisorSocketPath: "/tmp/supervisor.sock",
			authenticationToken: "local-worker-token",
			workerInstanceId: "instance-1",
			rootActiveSessionId: "active",
			sessionFile: "/sessions/root.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			lifecycle: "ready",
			createCommand: {
				type: "create",
				sessionPath: "/sessions/root.jsonl",
				config: {
					sessionDir: "/legacy/sessions",
					telemetryDisabled: true,
					apiKey: "secret-api-key",
					extensionFlagValues: { providerSecretKey: "secret-extension" },
				},
				env: { PROVIDER_TOKEN: "secret-client-env" },
				launchEnv: { PROVIDER_TOKEN: "secret-launch-env" },
				runtimeMetadata: { parentActiveSessionId: "secret-runtime" },
			},
			launchEnv: { PROVIDER_TOKEN: "secret-top-level-env" },
			consecutiveFailures: 0,
			lastError: "secret-error",
		} as unknown as DaemonWorkerDescriptor;

		const durable = durableDaemonWorkerDescriptor(descriptor);

		expect(durable.version).toBe(2);
		expect(durable.createCommand).toEqual({ type: "create", sessionPath: "/sessions/root.jsonl" });
		expect(durable).toMatchObject({
			workerId: "worker",
			workerInstanceId: "instance-1",
			sessionFile: "/sessions/root.jsonl",
			sessionDir: "/legacy/sessions",
			telemetryDisabled: true,
		});
		expect(JSON.stringify(durable)).not.toContain("secret-");
	});

	it("keeps the advertised schema identity synchronized with wire type shapes", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-protocol.ts"), "utf8");
		const commandSource = source.slice(
			source.indexOf("export type DaemonCommand ="),
			source.indexOf("type DaemonCommandName"),
		);
		const savedSessionSource = source.slice(
			source.indexOf("export interface DaemonSavedSessionInfo"),
			source.indexOf("export type DaemonDeleteSavedSessionResult"),
		);
		const outboundSource = source.slice(
			source.indexOf("export type DaemonOutbound ="),
			source.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"),
		);
		const digest = createHash("sha256")
			.update(`${commandSource}\n${savedSessionSource}\n${outboundSource}`)
			.digest("hex")
			.slice(0, 12);
		expect(DAEMON_SCHEMA_ID).toBe(`protocol-${DAEMON_PROTOCOL_VERSION}-schema-${DAEMON_SCHEMA_REVISION}-${digest}`);
	});

	it("requires compatibility metadata for the heartbeat protocol surface", () => {
		expect(DAEMON_PROTOCOL_VERSION).toBe(7);
		expect(DAEMON_SCHEMA_ID).toContain(`protocol-${DAEMON_PROTOCOL_VERSION}`);
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeats_list).toEqual({
			minProtocol: 7,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeat_manage).toEqual({
			minProtocol: 7,
			capability: "heartbeat_management",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.complete_owned_session).toEqual({
			minProtocol: 7,
			capability: "client_owned_sessions",
		});
		expect(DAEMON_OUTBOUND_COMPATIBILITY.heartbeats_changed).toEqual({
			minProtocol: 7,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["heartbeat_catalog", "heartbeat_management"]),
		);
	});

	it("capability-gates explicit subagent deletion instead of schema-gating it", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.delete_rlm_subagent).toEqual({
			minProtocol: 7,
			capability: "delete_rlm_subagent",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("delete_rlm_subagent");
	});

	it("capability- and schema-gates ACP MCP server replacement", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.replace_acp_mcp_servers).toEqual({
			minProtocol: 7,
			minSchemaRevision: 22,
			capability: "acp_mcp_servers",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("acp_mcp_servers");
	});

	it("capability-gates the optional model catalog surface", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_model_catalog).toEqual({
			minProtocol: 7,
			capability: "model_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("model_catalog");
	});

	it("capability- and schema-gates queued message mutation at its introducing revision", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.mutate_queued_message).toEqual({
			minProtocol: 7,
			minSchemaRevision: 15,
			capability: "queue_message_mutation",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("queue_message_mutation");
	});

	it("schema-gates the RLM max depth commands at their introducing revision", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_rlm_max_depth_status).toEqual({ minProtocol: 7, minSchemaRevision: 11 });
		expect(DAEMON_COMMAND_COMPATIBILITY.set_rlm_max_depth).toEqual({ minProtocol: 7, minSchemaRevision: 11 });
	});

	it("schema-gates session commands that carry the telemetry policy", () => {
		expect(getDaemonCommandCompatibilities({ type: "create", config: { cwd: "/tmp" } })).toEqual([
			{ minProtocol: 7 },
		]);
		expect(
			getDaemonCommandCompatibilities({ type: "create", config: { cwd: "/tmp", telemetryDisabled: true } }),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
		expect(getDaemonCommandCompatibilities({ type: "attach", activeSessionId: "active-1" })).toEqual([
			{ minProtocol: 7 },
		]);
		expect(
			getDaemonCommandCompatibilities({ type: "attach", activeSessionId: "active-1", telemetryDisabled: true }),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
		expect(
			getDaemonCommandCompatibilities({
				type: "reattach",
				activeSessionId: "active-1",
				targetActiveSessionId: "active-2",
				telemetryDisabled: true,
			}),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
	});

	it("capability-gates authoritative rosters and transient owned-session recovery context", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_rlm_children).toEqual({
			minProtocol: 7,
			minSchemaRevision: 17,
			capability: "authoritative_child_roster",
		});
		expect(
			getDaemonCommandCompatibilities({
				type: "attach",
				activeSessionId: "active-1",
				recoveryConfig: { cwd: "/tmp/fresh-owner" },
			}),
		).toEqual([
			{ minProtocol: 7, minSchemaRevision: 17, capability: "owned_session_recovery_context" },
			{ minProtocol: 7 },
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining([
				"authoritative_child_roster",
				"owned_session_recovery_context",
				"rlm_quiescence_barrier",
			]),
		);
	});

	it("gates the opt-in RLM quiescence wire field", () => {
		expect(
			getDaemonCommandCompatibilities({
				type: "wait_for_headless_completion",
				activeSessionId: "active-1",
				waitForRlmQuiescence: true,
			}),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 18, capability: "rlm_quiescence_barrier" }, { minProtocol: 7 }]);
		expect(
			getDaemonCommandCompatibilities({
				type: "wait_for_headless_completion",
				activeSessionId: "active-1",
			}),
		).toEqual([{ minProtocol: 7 }]);
	});

	it("capability- and schema-gates session input pause leases", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.acquire_session_input_pause).toEqual({
			minProtocol: 7,
			minSchemaRevision: 19,
			capability: "session_input_pause",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.release_session_input_pause).toEqual(
			DAEMON_COMMAND_COMPATIBILITY.acquire_session_input_pause,
		);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("session_input_pause");
	});

	it("version- and capability-gates prompt admission cancellation", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.cancel_prompt_admission).toEqual({
			minProtocol: 7,
			minSchemaRevision: 8,
			capability: "prompt_admission_cancellation",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("prompt_admission_cancellation");
	});

	it("capability-gates cancellation after prompt ownership", () => {
		const legacy = { type: "cancel_prompt_admission", activeSessionId: "active-1", admissionId: "a-1" } as const;
		expect(getDaemonCommandCompatibilities(legacy)).toEqual([DAEMON_COMMAND_COMPATIBILITY.cancel_prompt_admission]);
		expect(getDaemonCommandCompatibilities({ ...legacy, cancelOwned: true })).toEqual([
			{ minProtocol: 7, minSchemaRevision: 20, capability: "owned_prompt_cancellation" },
			DAEMON_COMMAND_COMPATIBILITY.cancel_prompt_admission,
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("owned_prompt_cancellation");
	});

	it("capability-gates list responses that omit streaming messages", () => {
		const legacy = { type: "list" } as const;
		expect(getDaemonCommandCompatibilities(legacy)).toEqual([DAEMON_COMMAND_COMPATIBILITY.list]);
		// An old daemon ignores the unknown field and answers with full rows, so
		// the gate exists to stop a sender from depending on the smaller payload.
		expect(getDaemonCommandCompatibilities({ ...legacy, omitStreamingMessages: true })).toEqual([
			{ minProtocol: 7, minSchemaRevision: 24, capability: "list_without_streaming_messages" },
			DAEMON_COMMAND_COMPATIBILITY.list,
		]);
		expect(getDaemonCommandCompatibilities({ ...legacy, omitStreamingMessages: false })).toEqual([
			DAEMON_COMMAND_COMPATIBILITY.list,
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("list_without_streaming_messages");
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(23);
	});

	it("gates honest worker-state reporting at its introducing schema revision", () => {
		// Revision 16 adds the "stopping" workerState and stops reporting
		// disconnected workers as "ready". The field is optional and old clients
		// ignore unknown values, so no capability gate is needed; the revision
		// lets version probes distinguish daemons with the old semantics.
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(16);
	});

	it("keeps refine failure events backward-compatible on the existing session event channel", () => {
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "refine_failed", error: "disk full" },
		};

		// Refine events remain on the original session-event channel across later schema revisions.
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(6);
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: 7 });
		expect(event).toMatchObject({ event: { type: "refine_failed", error: "disk full" } });
	});

	it("accepts legacy side-question and bash shapes in new daemons and clients", () => {
		const oldClientSideQuestion: DaemonCommand = {
			type: "start_side_question",
			activeSessionId: "active-1",
			sideQuestionId: "side-1",
			question: "What changed?",
		};
		const oldClientBash: DaemonCommand = {
			type: "execute_bash",
			activeSessionId: "active-1",
			command: "ls",
		};
		const oldDaemonBashStart: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "bash_start", command: "ls", excludeFromContext: false },
		};
		const oldDaemonBashEnd: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "bash_end", exitCode: 0, cancelled: false, truncated: false },
		};

		expect(DAEMON_COMMAND_COMPATIBILITY.start_side_question).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.execute_bash).toEqual({ minProtocol: 7 });
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: 7 });
		expect(oldClientSideQuestion).not.toHaveProperty("previousTurns");
		expect(oldClientBash).not.toHaveProperty("transient");
		expect(oldClientBash).not.toHaveProperty("runId");
		expect(oldDaemonBashStart.event).not.toHaveProperty("transient");
		expect(oldDaemonBashStart.event).not.toHaveProperty("runId");
		expect(oldDaemonBashEnd.event).not.toHaveProperty("transient");
		expect(oldDaemonBashEnd.event).not.toHaveProperty("runId");
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["side_question_transcript", "transient_bash"]),
		);
	});

	it("creates versioned command and event envelopes", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;
		const commandEnvelope = createDaemonCommandEnvelope(command, "cmd-1", "client-1");
		const eventMeta = createDaemonEventMeta("active-1", 3, "2026-01-01T00:00:00.000Z");
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "agent_end", messages: [] },
			meta: eventMeta,
		};

		expect(commandEnvelope).toEqual({
			type: "command",
			id: "cmd-1",
			protocol: DAEMON_PROTOCOL_INFO,
			clientId: "client-1",
			command,
		});
		expect(createDaemonEventEnvelope(event, eventMeta)).toEqual({
			type: "event",
			id: "active-1:3",
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: "active-1",
			sequence: 3,
			cursor: { generation: "active-1", sequence: 3 },
			emittedAt: "2026-01-01T00:00:00.000Z",
			event,
		});
		expect(eventMeta.cursor).toEqual({ generation: "active-1", sequence: 3 });
	});

	it("rejects command envelopes from pre-session-action protocols", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;

		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 7))).toBe(true);
		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 6))).toBe(false);
	});

	it("server-enforces capability-gated commands and control-plane auth without client-side shutdown breakage", () => {
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(26);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("control_plane");
		expect(DAEMON_FIRST_PARTY_SESSION_CAPABILITIES).not.toContain("control_plane");
		expect(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES).toContain("control_plane");
		expect([...DAEMON_CONTROL_PLANE_COMMANDS].sort()).toEqual(["prepare_update_restart", "restart", "shutdown"]);
		// Shutdown stays a legacy command so a new CLI can still stop an old daemon.
		expect(DAEMON_COMMAND_COMPATIBILITY.shutdown).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.restart).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.prepare_update_restart).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.declare_client_capabilities).toEqual({ minProtocol: 7 });
		expect(isDaemonMutatingCommand({ type: "declare_client_capabilities" })).toBe(false);
		expect(normalizeDeclaredCapabilities(["heartbeat_catalog", "not-a-cap", "heartbeat_catalog"] as never)).toEqual([
			"heartbeat_catalog",
		]);
		expect(missingDeclaredCommandCapability(undefined, undefined, { type: "shutdown" })).toBeUndefined();
		expect(missingDeclaredCommandCapability(true, new Set(), { type: "shutdown" })).toBe("control_plane");
		expect(missingDeclaredCommandCapability(true, new Set(["control_plane"]), { type: "shutdown" })).toBeUndefined();
		expect(missingDeclaredCommandCapability(true, new Set(["event_sequence"]), { type: "heartbeats_list" })).toBe(
			"heartbeat_catalog",
		);
		expect(
			missingDeclaredCommandCapability(true, new Set(["event_sequence"]), {
				type: "list",
				omitStreamingMessages: true,
			}),
		).toBe("list_without_streaming_messages");
	});

	it("keeps attachment routing and pure waits out of the durable mutation journal", () => {
		expect(isDaemonMutatingCommand({ type: "attach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "reattach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "wait_for_idle" })).toBe(false);
		// Journal replays after a reconnect would skip re-subscribing the new socket.
		expect(isDaemonMutatingCommand({ type: "roster_subscribe" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "roster_unsubscribe" })).toBe(false);
		// A pure wait must not hold the drain latch: a long headless-completion
		// barrier (RLM quiescence) would otherwise block update-restart and
		// idle eviction until it resolves.
		expect(isDaemonMutatingCommand({ type: "wait_for_headless_completion" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "switch_session" })).toBe(true);
	});

	it("keeps the roster push additive for pre-roster clients", () => {
		// Subscription commands and the push are capability-gated; a client that
		// never sends roster_subscribe is never written a roster_update.
		expect(DAEMON_COMMAND_COMPATIBILITY.roster_subscribe).toEqual({ minProtocol: 7, capability: "agent_roster" });
		expect(DAEMON_COMMAND_COMPATIBILITY.roster_unsubscribe).toEqual({ minProtocol: 7, capability: "agent_roster" });
		expect(DAEMON_OUTBOUND_COMPATIBILITY.roster_update).toEqual({ minProtocol: 7, capability: "agent_roster" });
		// list responses now carry rosterStatus/statusLabel/lastHeardFromAt; the
		// summary validator pre-roster clients shipped stays open to additive fields.
		expect(
			isDaemonSessionSummary({
				id: "session-1",
				activeSessionId: "active-1",
				rosterStatus: "running",
				statusLabel: "queued",
				lastHeardFromAt: "2026-08-01T12:00:00.000Z",
			}),
		).toBe(true);
	});

	it("capability-gates direct worker transport discovery as a supervisor-only surface", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_direct_worker_transport).toEqual({
			minProtocol: 7,
			minSchemaRevision: 25,
			capability: "direct_peer_transport",
		});
		// Only the supervisor issues tickets; workers and standalone daemons must not advertise it.
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).not.toContain("direct_peer_transport");
		expect(isDaemonMutatingCommand({ type: "get_direct_worker_transport" })).toBe(false);
	});

	it("keeps every command capability declarable by a first-party client", () => {
		const session = new Set<DaemonDeclaredCapability>(DAEMON_FIRST_PARTY_SESSION_CAPABILITIES);
		const control = new Set<DaemonDeclaredCapability>(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES);
		for (const [command, compatibility] of Object.entries(DAEMON_COMMAND_COMPATIBILITY) as [
			string,
			DaemonCommandCompatibility,
		][]) {
			if (compatibility.capability === undefined) continue;
			const set = DAEMON_CONTROL_PLANE_COMMANDS.has(command) ? control : session;
			expect(set.has(compatibility.capability), `${command} requires ${compatibility.capability}`).toBe(true);
		}
		// getDaemonCommandCompatibilities() adds this one conditionally (list + omitStreamingMessages),
		// so the loop above cannot see it. Drop this line only together with the wire field.
		expect(session.has("list_without_streaming_messages")).toBe(true);
		// A capability outside the known set is silently stripped before the gate ever sees it.
		expect(normalizeDeclaredCapabilities([...session])).toEqual([...session]);
		expect(normalizeDeclaredCapabilities([...control])).toEqual([...control]);
	});

	it("classifies every command plane and never defaults unknown commands to the session plane", () => {
		// A worker "list" means only that worker's sessions; the supervisor list is authoritative.
		expect(DAEMON_COMMAND_PLANE.list).toBe("control");
		expect(DAEMON_COMMAND_PLANE.prompt).toBe("session");
		expect(DAEMON_COMMAND_PLANE.declare_client_capabilities).toBe("control");
		expect(isSessionPlaneDaemonCommand("no_such_command")).toBe(false);
	});

	it("reports replay availability from resume cursors", () => {
		expect(createDaemonReplayInfo(undefined, 5, "generation-1")).toEqual({
			status: "complete",
			toSequence: 5,
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(
			createDaemonReplayInfo(
				{ activeSessionId: "active-1", generation: "generation-1", sequence: 5 },
				5,
				"generation-1",
			),
		).toEqual({
			status: "complete",
			fromSequence: 5,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 5 },
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 10 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 10,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 10 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "resume_cursor_ahead_of_session",
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 2 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 2,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 2 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "event_replay_not_available",
		});
		expect(createDaemonReplayInfo({ generation: "old", sequence: 5 }, 0, "new")).toMatchObject({
			status: "unavailable",
			reason: "event_generation_changed",
			fromCursor: { generation: "old", sequence: 5 },
			toCursor: { generation: "new", sequence: 0 },
		});
	});

	it("salvages command ids from rejected lines regardless of shape validity", () => {
		const oldEnvelope = JSON.stringify(
			createDaemonCommandEnvelope({ type: "list" } as DaemonCommand, "list-1", "old-client", 6),
		);
		expect(salvageDaemonCommandId(oldEnvelope)).toBe("list-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "list", id: "bare-1" }))).toBe("bare-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: null, id: "typeless-1" }))).toBe("typeless-1");
		expect(salvageDaemonCommandId(JSON.stringify({ id: "no-type" }))).toBe("no-type");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "command", id: 7 }))).toBeUndefined();
		expect(salvageDaemonCommandId(JSON.stringify("command"))).toBeUndefined();
		expect(salvageDaemonCommandId("{ not json")).toBeUndefined();
	});
});
