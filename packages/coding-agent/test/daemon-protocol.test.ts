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
	DURABLE_LAST_ERROR_MAX_CHARS,
	durableDaemonWorkerDescriptor,
	durableWorkerLastError,
	FALLBACK_FAILED_WORKER_LAST_ERROR,
} from "../src/modes/daemon/daemon-worker-protocol.js";

// X-6: the DAEMON_SCHEMA_ID digest recipe is single-sourced in these two helpers so the
// identity assertion and the shape-sensitivity assertion below cannot drift apart. Every
// slice is recomputed from the same source files the production shapes live in.
interface DaemonSchemaSliceSources {
	command: string;
	savedSession: string;
	outbound: string;
	treeWire: string;
	stallEvent: string;
	stallDiagnostics: string;
	stallKernel: string;
	stallExemption: string;
	snapshotWrapper: string;
	treeAssembly: string;
	connectionTreeContract: string;
	connectionSnapshotWrapper: string;
	connectionStallContract: string;
	headlessResult: string;
	quiescenceOutcome: string;
	responseEnvelope: string;
}

function readDaemonSchemaSliceSources(): DaemonSchemaSliceSources {
	const daemonProtocolSource = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-protocol.ts"), "utf8");
	const sessionManagerSource = readFileSync(resolve(__dirname, "../src/core/session-manager.ts"), "utf8");
	const agentSessionSource = readFileSync(resolve(__dirname, "../src/core/agent-session.ts"), "utf8");
	const stallDiagnosticsModule = readFileSync(resolve(__dirname, "../src/core/stall-diagnostics.ts"), "utf8");
	const stallWatchdogSource = readFileSync(resolve(__dirname, "../src/core/stall-watchdog.ts"), "utf8");
	// X-6: the wrapper and contract layers of the session-tree and stall families live
	// outside the slices above. DaemonSessionSnapshot.sessionTree is the snapshot wire
	// wrapper (its field set is not the session-manager stats it carries),
	// agent-connection/types.ts owns the connection-facing tree DTOs, the snapshot
	// wrapper contract and the stall event wire DTO, and daemon-mode.ts assembles the
	// actual get_session_tree response. Until rev35 an edit to any of those rode an
	// unchanged DAEMON_SCHEMA_ID (the rev34 comment admitted the types.ts stall DTO was
	// "not an identity" for exactly this reason), so they join the hashed source.
	const connectionTypesSource = readFileSync(resolve(__dirname, "../src/modes/agent-connection/types.ts"), "utf8");
	const headlessCompletionSource = readFileSync(resolve(__dirname, "../src/modes/headless-completion.ts"), "utf8");
	const daemonModeSource = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-mode.ts"), "utf8");
	return {
		command: daemonProtocolSource.slice(
			daemonProtocolSource.indexOf("export type DaemonCommand ="),
			daemonProtocolSource.indexOf("type DaemonCommandName"),
		),
		savedSession: daemonProtocolSource.slice(
			daemonProtocolSource.indexOf("export interface DaemonSavedSessionInfo"),
			daemonProtocolSource.indexOf("export type DaemonDeleteSavedSessionResult"),
		),
		outbound: daemonProtocolSource.slice(
			daemonProtocolSource.indexOf("export type DaemonOutbound ="),
			daemonProtocolSource.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"),
		),
		// CM-2: response payload shapes do not live in daemon-protocol.ts (DaemonResponse
		// types its data as unknown), so hashing only the three request/event slices let
		// any response-shape edit ride an unchanged DAEMON_SCHEMA_ID. The session tree
		// wire family - node shapes plus both bound stats (session_snapshot's
		// sessionTree.bound and get_session_tree's flatNodes/treeBound) - lives in
		// core/session-manager.ts, so its slice joins the digest.
		treeWire: sessionManagerSource.slice(
			sessionManagerSource.indexOf("export interface SessionTreeFlatNode"),
			sessionManagerSource.indexOf("export interface SessionContext"),
		),
		// K3X-1: the stall event family is a wire shape too, but it lives in the
		// session-event union and the diagnostics payload modules, none of which the
		// three request/event slices or the session-tree slice cover. An edit to the
		// stall event or payload shape (DO-1 added `diagnostics` as a required field)
		// used to leave DAEMON_SCHEMA_ID unchanged, so a mixed old-daemon/new-client
		// pair passed the handshake with mismatched stall events.
		stallEvent: agentSessionSource.slice(
			agentSessionSource.indexOf('| {\n\t\t\ttype: "stall_warning"'),
			agentSessionSource.indexOf("export type AgentSessionEventListener"),
		),
		stallDiagnostics: stallDiagnosticsModule.slice(
			stallDiagnosticsModule.indexOf("export interface StallDiagnostics"),
		),
		stallKernel: stallWatchdogSource.slice(
			stallWatchdogSource.indexOf("export interface StallKernelDiagnostics"),
			stallWatchdogSource.indexOf("export interface StallExemptionSnapshot"),
		),
		stallExemption: stallWatchdogSource.slice(
			stallWatchdogSource.indexOf("export interface StallExemptionDiagnostics"),
			stallWatchdogSource.indexOf("export type StallExemptionEventKind"),
		),
		snapshotWrapper: daemonProtocolSource.slice(
			daemonProtocolSource.indexOf("export interface DaemonSessionSnapshot"),
			daemonProtocolSource.indexOf("export interface DaemonAttachResult"),
		),
		treeAssembly: daemonModeSource.slice(
			daemonModeSource.indexOf('case "get_session_tree": {'),
			daemonModeSource.indexOf('case "get_user_messages_for_forking": {'),
		),
		connectionTreeContract: connectionTypesSource.slice(
			connectionTypesSource.indexOf("export interface AgentConnectionSessionTreeFlatNode"),
			connectionTypesSource.indexOf("export interface AgentConnectionSessionContext"),
		),
		connectionSnapshotWrapper: connectionTypesSource.slice(
			connectionTypesSource.indexOf("export interface AgentConnectionSnapshot"),
			connectionTypesSource.indexOf("export interface AgentConnectionScopedModel"),
		),
		connectionStallContract: connectionTypesSource.slice(
			connectionTypesSource.indexOf('| {\n\t\t\ttype: "stall_warning"'),
			connectionTypesSource.indexOf("export type AgentConnectionEvent"),
		),
		// K3Q-1: the wait_for_headless_completion response is a wire shape too. Its
		// optional rlmQuiescence field rides the rlm_quiescence_barrier capability, but
		// the shapes live in headless-completion.ts and agent-session.ts, outside every
		// prior slice; an edit would otherwise ride an unchanged DAEMON_SCHEMA_ID.
		headlessResult: headlessCompletionSource.slice(
			headlessCompletionSource.indexOf("export interface HeadlessCompletionResult"),
			headlessCompletionSource.indexOf("export async function waitForHeadlessCompletion"),
		),
		quiescenceOutcome: agentSessionSource.slice(
			agentSessionSource.indexOf("/** Outcome of a quiescence barrier wait"),
			agentSessionSource.indexOf("/** How long failure-class terminal notices are collected"),
		),
		// PROT-2/F3: the response envelope is a wire shape too, but it sits between the
		// command, savedSession and outbound slices in daemon-protocol.ts, so no slice
		// covered it. Rev29 added response.retryAfterMs through exactly that gap (the
		// number moved, the digest did not), and a future envelope field that forgets
		// the bump would pass the handshake on a mismatched envelope. The failure
		// envelope's errorInfo payload (DaemonErrorInfo) is the same family, so the
		// slice spans both declarations.
		responseEnvelope: daemonProtocolSource.slice(
			daemonProtocolSource.indexOf("export type DaemonResponse ="),
			daemonProtocolSource.indexOf("export type DaemonSessionClosedReason ="),
		),
	};
}

function daemonSchemaDigest(sources: DaemonSchemaSliceSources): string {
	// K3R2-2: a lost or reordered slice marker collapses `slice(start, end)` to ""
	// or to stray comment text while the other families still hash, and the
	// recovery ritual this file's header documents is to recalculate
	// DAEMON_SCHEMA_ID over whatever the slices now return. Before this guard
	// that ritual froze the unusable slice into the advertised identity (r31 F1:
	// the whole DaemonCommand union could fall out of the digest with every test
	// green), so an unusable slice fails loudly here instead of being hashed.
	for (const [key, text] of Object.entries(sources)) {
		const codeOnly = text
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		if (codeOnly.length === 0) {
			throw new Error(
				`daemon schema slice "${key}" is empty or comment-only: its start/end markers are lost or ` +
					`reordered, so that wire family is about to fall out of DAEMON_SCHEMA_ID. Fix the slice ` +
					`markers in readDaemonSchemaSliceSources instead of recalculating the constant.`,
			);
		}
	}
	return createHash("sha256")
		.update(
			[
				sources.command,
				sources.savedSession,
				sources.outbound,
				sources.treeWire,
				sources.stallEvent,
				sources.stallDiagnostics,
				sources.stallKernel,
				sources.stallExemption,
				sources.snapshotWrapper,
				sources.treeAssembly,
				sources.connectionTreeContract,
				sources.connectionSnapshotWrapper,
				sources.connectionStallContract,
				sources.headlessResult,
				sources.quiescenceOutcome,
				sources.responseEnvelope,
			].join("\n"),
		)
		.digest("hex")
		.slice(0, 12);
}

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
		const sources = readDaemonSchemaSliceSources();
		// The slice markers must be found: a silent -1 would hash an empty string
		// and let a family fall back out of the digest unnoticed.
		// K3R2-2: command/savedSession/outbound were the only three families
		// without content pins, so the r31 F1 freeze walkthrough (a lost or
		// reordered marker plus the documented DAEMON_SCHEMA_ID recalculation)
		// dropped the whole DaemonCommand union out of the digest with every test
		// green. Each pin anchors the start marker, the tail of the slice (which
		// an end marker sliding earlier must drop) and core wire members.
		expect(sources.command).toContain("export type DaemonCommand =");
		expect(sources.command).toContain('type: "prompt";');
		expect(sources.command).toContain('type: "get_session_tree";');
		expect(sources.command).toContain('type: "declare_client_capabilities";');
		expect(sources.savedSession).toContain("export interface DaemonSavedSessionInfo");
		expect(sources.savedSession).toContain("messageCount: number;");
		expect(sources.savedSession).toContain("usage?: SessionUsageSummary;");
		expect(sources.outbound).toContain("export type DaemonOutbound =");
		expect(sources.outbound).toContain("| DaemonResponse");
		expect(sources.outbound).toContain('type: "daemon_hello";');
		expect(sources.outbound).toContain('type: "session_snapshot_begin";');
		expect(sources.outbound).toContain("| CompactAssistantDelta;");
		expect(sources.stallEvent).toContain('type: "stall_warning"');
		expect(sources.stallEvent).toContain('type: "stall_unsettled"');
		expect(sources.stallDiagnostics).toContain("export interface StallDiagnostics");
		expect(sources.stallKernel).toContain("export interface StallKernelDiagnostics");
		expect(sources.stallExemption).toContain("export interface StallExemptionDiagnostics");
		expect(sources.snapshotWrapper).toContain("export interface DaemonSessionSnapshot");
		expect(sources.snapshotWrapper).toContain("bound?: SessionTreeDepthStats");
		expect(sources.treeAssembly).toContain('case "get_session_tree"');
		// The assembly slice must carry the actual response keys, not just the case label:
		// a renamed key with a stale marker would otherwise hash unrelated text.
		expect(sources.treeAssembly).toContain("treeBound: bounded.stats");
		expect(sources.connectionTreeContract).toContain("export interface AgentConnectionSessionTreeBound");
		expect(sources.connectionTreeContract).toContain("export interface AgentConnectionSessionTreeFlatStats");
		expect(sources.connectionSnapshotWrapper).toContain("export interface AgentConnectionSnapshot");
		expect(sources.connectionSnapshotWrapper).toContain("bound?: AgentConnectionSessionTreeBound");
		expect(sources.connectionStallContract).toContain('type: "stall_warning"');
		expect(sources.connectionStallContract).toContain('type: "stall_unsettled"');
		expect(sources.connectionStallContract).toContain("diagnostics?: StallDiagnostics");
		const digest = daemonSchemaDigest(sources);
		expect(sources.headlessResult).toContain("rlmQuiescence");
		expect(sources.quiescenceOutcome).toContain("export interface RlmQuiescenceOutcome");
		expect(sources.responseEnvelope).toContain("retryAfterMs?: number;");
		expect(sources.responseEnvelope).toContain("errorInfo?: DaemonErrorInfo;");
		// K3R2-2: pin the envelope slice's marker end points as well. It starts at
		// the DaemonResponse declaration and ends where DaemonSessionClosedReason
		// begins, so the last text it may capture is DaemonErrorInfo's final arm:
		// an end marker that slides earlier (a moved declaration or a matching
		// comment) drops the errorInfo family out of the digest with only the
		// digest line left to notice.
		expect(sources.responseEnvelope).toContain("export type DaemonResponse =");
		expect(sources.responseEnvelope).toContain("export type DaemonErrorInfo =");
		expect(sources.responseEnvelope).toContain('code: "command_result_uncertain"');
		expect(DAEMON_SCHEMA_ID).toBe(`protocol-${DAEMON_PROTOCOL_VERSION}-schema-${DAEMON_SCHEMA_REVISION}-${digest}`);
	});

	it("refuses to freeze an empty or comment-only slice into the schema identity", () => {
		// K3R2-2 (r31 F1): a lost start marker (indexOf -> -1, so start lands after
		// end) or an end marker reordered ahead of its start collapses a slice to ""
		// - or to stray comment text when a comment swallows the end marker. The
		// digest then moves and the header's documented recovery ritual is to
		// recalculate DAEMON_SCHEMA_ID, which before this guard silently froze the
		// hole into the advertised identity: the r31 F1 walkthrough moved
		// DaemonCommandName above DaemonCommand, recalculated, and all 31 tests
		// stayed green with the whole request union out of the digest. The digest
		// must refuse an unusable slice instead of hashing it.
		const sources = readDaemonSchemaSliceSources();
		const unusable: Array<{ name: string; key: keyof DaemonSchemaSliceSources; text: string }> = [
			{ name: "start marker lost: slice(-1, end) is empty", key: "command", text: "" },
			{ name: "end marker reordered before start", key: "responseEnvelope", text: "" },
			{ name: "savedSession markers collapsed", key: "savedSession", text: "" },
			{
				name: "end-marker comment truncated the slice to comments only",
				key: "outbound",
				text: "\t// DAEMON_OUTBOUND_COMPATIBILITY moved\n\t/** stray doc comment */\n",
			},
		];
		expect(unusable.length).toBeGreaterThan(0);
		for (const entry of unusable) {
			expect(
				() => daemonSchemaDigest({ ...sources, [entry.key]: entry.text }),
				`${entry.name}: the digest must refuse an unusable slice`,
			).toThrow(/empty or comment-only/);
		}
	});

	it("counts wrapper, contract and assembly shape edits as identity changes", () => {
		// X-6: until rev35 the digest covered only free-text type declarations of the
		// request/event hemisphere plus the core session-manager shapes. Each mutation
		// below is one of the holes that admitted: a wrapper field-set change, an
		// assembly-layer response key rename, and the stall DTO optionality flip the
		// rev34 comment explicitly disclaimed. Applied in memory, every one of them must
		// move the digest, or a mixed old-daemon/new-client pair again passes the
		// handshake with shapes the identity does not cover.
		const sources = readDaemonSchemaSliceSources();
		const baseline = daemonSchemaDigest(sources);
		const mutations: Array<{ name: string; key: keyof DaemonSchemaSliceSources; apply: (text: string) => string }> = [
			{
				name: "DaemonSessionSnapshot.sessionTree wrapper field set (N1)",
				key: "snapshotWrapper",
				apply: (text) =>
					text.replace(
						"bound?: SessionTreeDepthStats;",
						"treeBound: SessionTreeDepthStats;\n\t\twidthCap: number;",
					),
			},
			{
				name: "get_session_tree response key rename (N2)",
				key: "treeAssembly",
				apply: (text) => text.replace("treeBound: bounded.stats,", "treeLimit: bounded.stats,"),
			},
			{
				name: "connection tree bound stats field set",
				key: "connectionTreeContract",
				apply: (text) => text.replace("depthLimit: number;", "depthLimit: number;\n\twidthCap: number;"),
			},
			{
				name: "AgentConnectionSnapshot.sessionTree wrapper field set",
				key: "connectionSnapshotWrapper",
				apply: (text) =>
					text.replace("bound?: AgentConnectionSessionTreeBound;", "treeBound: AgentConnectionSessionTreeBound;"),
			},
			{
				name: "stall event wire contract diagnostics optionality (X-12 shape)",
				key: "connectionStallContract",
				apply: (text) => text.replace("diagnostics?: StallDiagnostics;", "diagnostics: StallDiagnostics;"),
			},
			{
				// Positive control: a mutation inside a family the digest has covered since
				// rev32, proving this method detects a covered-shape edit and is not simply
				// asserting that any mutation anywhere changes nothing.
				name: "core session-manager tree stats field set (covered since rev32)",
				key: "treeWire",
				apply: (text) => text.replace("leafIncluded: boolean;", "leafIncluded: boolean;\n\twidthCap: number;"),
			},
			{
				// PROT-2/F3: the response envelope was outside every slice until rev37, so
				// an envelope field edit rode an unchanged identity (rev29's retryAfterMs
				// moved the number, not the digest). This is the mutation that guards the
				// new responseEnvelope slice.
				name: "response envelope field set (covered since rev37)",
				key: "responseEnvelope",
				apply: (text) =>
					text.replace("retryAfterMs?: number;", "retryAfterMs?: number;\n\t\t\tprobeAfterMs?: number;"),
			},
		];
		expect(mutations.length).toBeGreaterThan(0);
		for (const mutation of mutations) {
			const mutatedText = mutation.apply(sources[mutation.key]);
			expect(mutatedText, `${mutation.name}: mutation marker must apply`).not.toBe(sources[mutation.key]);
			const digest = daemonSchemaDigest({ ...sources, [mutation.key]: mutatedText });
			expect(digest, `${mutation.name}: shape edit must change the schema identity`).not.toBe(baseline);
		}
	});

	it("replays the rev30 unbounded-to-bounded session-tree wire change as an identity change", () => {
		// F1 (r30 protocol-chain): commit 55bae7c50 (2026-09-15, rev30 window, ~50
		// minutes before a5edee5ee claimed 31) bounded the session tree on the wire:
		// the snapshot wrappers' sessionTree gained `bound`, get_session_tree's
		// response gained `treeBound`, and the bound stats interfaces joined
		// core/session-manager.ts. The digest then hashed only the daemon-protocol.ts
		// request/event hemisphere, so the wire changed and DAEMON_SCHEMA_ID did not -
		// 55bae7c50 and its parent advertise the identical protocol-7-schema-30-
		// 66299858b8b4, and a mixed old-daemon/new-client pair passed the handshake on
		// mismatched tree shapes. This test replays that exact diff shape, inverted onto
		// the current text (each mutation restores the pre-55bae7c50 wire): every one
		// must move the digest under the current recipe, or the F1 blind window reopens.
		const sources = readDaemonSchemaSliceSources();
		const baseline = daemonSchemaDigest(sources);
		// The digest recipe exactly as it stood at 55bae7c50: only the three
		// daemon-protocol.ts request/event slices (the test file at that commit hashed
		// command, savedSession and outbound and nothing else). DaemonSessionSnapshot -
		// one of the commit's edit sites, in the same file - sat outside all three
		// ranges, which is how the incident slipped through.
		const rev30Digest = (s: DaemonSchemaSliceSources): string =>
			createHash("sha256").update([s.command, s.savedSession, s.outbound].join("\n")).digest("hex").slice(0, 12);

		const replay: Array<{ name: string; key: keyof DaemonSchemaSliceSources; apply: (text: string) => string }> = [
			{
				// The historical edit, verbatim inverted: DaemonSessionSnapshot.sessionTree
				// collapsed back to the pre-55bae7c50 shape (the wrapper slice only
				// joined the digest at rev35).
				name: "55bae7c50: DaemonSessionSnapshot.sessionTree.bound leaves the wire",
				key: "snapshotWrapper",
				apply: (text) =>
					text.replace(
						"sessionTree?: {\n\t\ttree: AgentConnectionSessionTreeNode[];\n\t\tleafId: string | null;\n\t\t/** Present when the tree was depth-bounded; says what the bound left out. */\n\t\tbound?: SessionTreeDepthStats;\n\t};",
						"sessionTree?: { tree: AgentConnectionSessionTreeNode[]; leafId: string | null };",
					),
			},
			{
				name: "55bae7c50: AgentConnectionSnapshot.sessionTree.bound leaves the wire",
				key: "connectionSnapshotWrapper",
				apply: (text) =>
					text.replace(
						"sessionTree?: {\n\t\ttree: AgentConnectionSessionTreeNode[];\n\t\tleafId: string | null;\n\t\t/** Present when the tree was depth-bounded; says what the bound left out. */\n\t\tbound?: AgentConnectionSessionTreeBound;\n\t};",
						"sessionTree?: { tree: AgentConnectionSessionTreeNode[]; leafId: string | null };",
					),
			},
			{
				// The daemon-side assembly edit: the response the commit started shipping.
				name: "55bae7c50: get_session_tree response loses treeBound",
				key: "treeAssembly",
				apply: (text) => text.replace("treeBound: bounded.stats,", ""),
			},
			{
				// The commit also added the whole SessionTreeDepthStats/SessionFlatTreeStats
				// family (the treeWire slice only joined at rev32); one historically added
				// field leaving that family replays the class.
				name: "55bae7c50: SessionTreeDepthStats.depthLimit leaves the wire",
				key: "treeWire",
				apply: (text) => text.replace("depthLimit: number;", ""),
			},
		];
		expect(replay.length).toBeGreaterThan(0);
		for (const mutation of replay) {
			const mutatedText = mutation.apply(sources[mutation.key]);
			expect(mutatedText, `${mutation.name}: replay marker must apply`).not.toBe(sources[mutation.key]);
			const mutated = { ...sources, [mutation.key]: mutatedText };
			// Red control - the incident, reproduced: under the rev30 recipe the same edit
			// leaves the identity unchanged. For the snapshotWrapper mutation this is the
			// exact historical miss (an edit inside daemon-protocol.ts, outside the three
			// hashed ranges); for the others the recipe never hashed their files at all.
			expect(rev30Digest(mutated), `${mutation.name}: the rev30 recipe must miss the edit`).toBe(
				rev30Digest(sources),
			);
			// Guard - the current recipe must catch it, or the digest gate has a hole
			// of the F1 class again.
			expect(daemonSchemaDigest(mutated), `${mutation.name}: bound edit must change the schema identity`).not.toBe(
				baseline,
			);
		}
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

it("carries the real failure reason into the durable descriptor, bounded to one line", () => {
	const cases = [
		{
			name: "real reason",
			lastError: "worker exited unexpectedly (signal SIGKILL)",
			expected: "worker exited unexpectedly (signal SIGKILL)",
		},
		{ name: "no reason", lastError: undefined, expected: FALLBACK_FAILED_WORKER_LAST_ERROR },
		{ name: "blank reason", lastError: "   ", expected: FALLBACK_FAILED_WORKER_LAST_ERROR },
		// A stack tail can carry an environment dump; only the first line survives.
		{
			name: "secret in the tail",
			lastError: "spawn failed\nenv: PROVIDER_TOKEN=secret-token-value",
			expected: "spawn failed",
		},
		{
			name: "overlong reason",
			lastError: "x".repeat(DURABLE_LAST_ERROR_MAX_CHARS + 50),
			expected: `${"x".repeat(DURABLE_LAST_ERROR_MAX_CHARS - 1)}…`,
		},
	];
	expect(cases.length).toBeGreaterThan(0);
	for (const testCase of cases) {
		expect(durableWorkerLastError({ lastError: testCase.lastError }), testCase.name).toBe(testCase.expected);
		expect(JSON.stringify(durableWorkerLastError({ lastError: testCase.lastError })), testCase.name).not.toContain(
			"secret-",
		);
	}
	// Wired through the descriptor a restart actually re-adopts, so the reaper's
	// archive line names a cause instead of a placeholder.
	const durable = durableDaemonWorkerDescriptor({
		version: 2,
		workerId: "worker-failed",
		pid: 4242,
		rootActiveSessionId: "active-failed",
		createdAt: "2026-09-11T00:00:00.000Z",
		updatedAt: "2026-09-11T00:00:00.000Z",
		lifecycle: "failed",
		lastError: "kernel died: out of memory\nstack: secret-frame",
		consecutiveFailures: 3,
		createCommand: { type: "create", sessionPath: "/sessions/root.jsonl" },
	} as unknown as DaemonWorkerDescriptor);
	expect(durable.lastError).toBe("kernel died: out of memory");
	expect(JSON.stringify(durable)).not.toContain("secret-");
});
