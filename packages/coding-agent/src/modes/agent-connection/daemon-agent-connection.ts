import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, ServiceTier, Transport } from "@earendil-works/pi-ai";
import { appendRotatingLog, getAgentDir, getAgentLogPath, getDaemonLogPath } from "../../config.js";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { AcpMcpServerConfig } from "../../core/mcp/acp-mcp-types.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { SessionStats } from "../../core/session-stats.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { AgentsViewRosterStore, STALE_ROSTER_DAEMON_MESSAGE } from "../agents-view/roster-store.js";
import { CompactAssistantStreamReconstructor } from "../daemon/compact-session-stream.js";
import {
	DaemonCapabilityUnavailableError,
	DaemonRequestTimeoutError,
	type DaemonTransportClient,
	getDaemonSocketCloseReason,
} from "../daemon/daemon-client.js";
import { deserializeDaemonError } from "../daemon/daemon-errors.js";
import {
	collectDaemonClientEnv,
	collectDaemonLaunchEnv,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonEventCursor,
	type DaemonOutbound,
	type DaemonReplayInfo,
	type DaemonSessionClosedReason,
	type DaemonSessionSnapshot,
	isUnknownDaemonCommandError,
} from "../daemon/daemon-protocol.js";
import {
	createDaemonSessionTransport,
	DaemonControlPlaneTransportError,
	DaemonDirectTransportClosedError,
	DaemonRoutedClient,
} from "../daemon/daemon-routed-client.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { DAEMON_BACKGROUND_RECONNECT_RETRY_MS, daemonReconnectBudgetMs } from "../daemon/daemon-timeouts.js";
import { listDaemonHeartbeats } from "../daemon/heartbeat-catalog.js";
import {
	deleteDaemonSavedSession,
	listDaemonSavedSessions,
	renameDaemonSavedSession,
} from "../daemon/saved-session-catalog.js";
import type { HeadlessCompletionResult } from "../headless-completion.js";
import type {
	AgentConnection,
	AgentConnectionBeforeSessionInvalidateListener,
	AgentConnectionDisposeOptions,
	AgentConnectionDisposeOutcome,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionExecuteBashOptions,
	AgentConnectionExtensionUiResponse,
	AgentConnectionForkOptions,
	AgentConnectionHeadlessCompletionOptions,
	AgentConnectionHeartbeat,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionModelCycleResult,
	AgentConnectionNavigateTreeOptions,
	AgentConnectionNavigateTreeResult,
	AgentConnectionNewSessionOptions,
	AgentConnectionPromptOptions,
	AgentConnectionQueuedMessageLane,
	AgentConnectionQueuedMessageMutation,
	AgentConnectionQueuedMessageMutationStatus,
	AgentConnectionQueueMode,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionHeader,
	AgentConnectionSessionInputPause,
	AgentConnectionSessionListCallbacks,
	AgentConnectionSessionTreeBound,
	AgentConnectionSessionTreeFlatNode,
	AgentConnectionSessionTreeFlatStats,
	AgentConnectionSessionTreeNode,
	AgentConnectionSessionWatcher,
	AgentConnectionSideQuestionEvent,
	AgentConnectionSideQuestionTurn,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";
import { AgentConnectionPromptAdmissionError } from "./types.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;
type DaemonSnapshotBegin = Extract<DaemonOutbound, { type: "session_snapshot_begin" }>;

interface DaemonSnapshotAssembly {
	begin?: DaemonSnapshotBegin;
	chunks: Map<number, AgentMessage[]>;
	promise: Promise<DaemonSessionSnapshot>;
	resolve: (snapshot: DaemonSessionSnapshot) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export const DAEMON_REFINE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * K3C-1: a compact request is only answered when the daemon's summarization
 * finishes (kimi-k3@max: 55-73s at 100k-150k tokens, ~100s at 590k;
 * deepseek-v4.1-flash: 37-50s), so the daemon client's 30s default reported
 * successful compactions as client-side timeouts.
 */
export const DAEMON_COMPACT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/**
 * P1-7b, 60s tier: the fast reconnect budget. It has to outlive the recovery
 * ladder it waits for, so it is derived from the adoption create budget rather
 * than restated (fix-plan appendix A: T3-3 and T4-2 are the same number). A
 * session still being adopted when this budget ends is not lost: the low-speed
 * background retry below keeps going and stops only on success, disposal, or a
 * terminal answer (I-9).
 */
export const DAEMON_RECONNECT_TIMEOUT_MS = daemonReconnectBudgetMs();
export const DAEMON_SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_IGNORED_SNAPSHOT_IDS = 128;
/**
 * Snapshot self-heal schedule. One failed full re-pull must not drop the user
 * offline: the connection degrades visibly, keeps the stale view on screen and
 * retries on this schedule.
 *
 * Honest limit, registered rather than papered over: when the whole budget is
 * spent, `recoverFailedSnapshot` still emits a terminal `closed`. That is
 * pre-existing behaviour, not something this schedule introduced - before it, a
 * single failed re-pull went straight to `closed`; this narrows that to three
 * attempts behind visible `reconnecting` status. It does not remove the path, so
 * a permanent catch-up failure the supervisor reports as `catchup_failed` can
 * still end in a terminal close. Closing that off means the client reconnecting
 * on its own instead of being told the session is gone, which is a capability
 * change belonging to the client-side budget work, not to this constant.
 */
const SNAPSHOT_RECOVERY_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** P0-5c: at most one gap line per window per connection; the rest are counted into the next one. */
const EVENT_GAP_LOG_THROTTLE_MS = 1_000;
/**
 * T4-4/F9: the breaker bounds on a gap-triggered re-pull. Either one opens it and
 * the connection falls back to log-only for the rest of its life: a real hole
 * that a re-pull cannot fix would otherwise loop "re-pull, still gapped, re-pull"
 * forever, which is a self-inflicted resync storm on top of the original fault.
 *
 * - the streak bound catches one incident repeating;
 * - the window bound catches incidents spaced far enough apart that the streak
 *   resets, so a long-lived connection still has a resync rate ceiling.
 */
const EVENT_GAP_RECOVERY_STREAK_LIMIT = 3;
/** Gaps further apart than this are separate incidents, so the streak restarts. */
const EVENT_GAP_RECOVERY_STREAK_RESET_MS = 5 * 60_000;
const EVENT_GAP_RECOVERY_WINDOW_MS = 10 * 60_000;
const EVENT_GAP_RECOVERY_WINDOW_LIMIT = 3;
let cachedEventGapRecoveryMode: "log" | "recover" | undefined;

/**
 * The shipped default is log-only (C11): the detector is evidence gathering until a
 * production window shows it does not misfire. Read once per process from settings.
 */
function configuredEventGapRecoveryMode(): "log" | "recover" {
	if (cachedEventGapRecoveryMode !== undefined) {
		return cachedEventGapRecoveryMode;
	}
	try {
		cachedEventGapRecoveryMode = SettingsManager.create(process.cwd(), getAgentDir()).getDaemonSupervisorSettings()
			.eventGapRecovery;
	} catch {
		cachedEventGapRecoveryMode = "log";
	}
	return cachedEventGapRecoveryMode;
}
const UPDATE_RECONNECT_TIMEOUT_MS = 120000;
const UPDATE_RECONNECT_RETRY_MS = 100;
const MAX_COMPLETED_SNAPSHOTS = 128;
const OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS = 10_000;
const updateTransportReconnects = new WeakMap<DaemonTransportClient, Promise<void>>();

const OWNED_SESSION_PROMOTE_RETRY_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorSentence(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).trim();
	if (!message) {
		return "Unknown daemon error.";
	}
	return /[.!?]$/.test(message) ? message : `${message}.`;
}

/**
 * I-9: the low-speed background retry has to be able to stop. These are answers
 * that do not change by being asked again — a session the failed-worker reaper
 * collected (C19 made the terminal answer reachable) or a daemon replaced by a
 * build that lacks the capability. Everything else keeps retrying.
 */
export function isTerminalReconnectError(error: unknown): boolean {
	if (error instanceof DaemonCapabilityUnavailableError) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return TERMINAL_RECONNECT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const TERMINAL_RECONNECT_ERROR_PATTERNS: readonly RegExp[] = [/^Unknown active session\b/];

function reconnectDaemonTransportAfterUpdate(client: DaemonTransportClient): Promise<void> {
	const existing = updateTransportReconnects.get(client);
	if (existing) {
		return existing;
	}
	const reconnectPromise = Promise.resolve()
		.then(async () => {
			client.disconnectForReconnect("update");
			const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
			let lastError: unknown;
			while (Date.now() < deadline) {
				try {
					await client.reconnect(1000);
					return;
				} catch (error) {
					lastError = error;
				}
				await delay(UPDATE_RECONNECT_RETRY_MS);
			}
			throw lastError ?? new Error("the updated daemon did not become available");
		})
		.finally(() => {
			if (updateTransportReconnects.get(client) === reconnectPromise) {
				updateTransportReconnects.delete(client);
			}
		});
	updateTransportReconnects.set(client, reconnectPromise);
	return reconnectPromise;
}

export interface DaemonAgentConnectionOptions {
	closeClientOnDispose?: boolean;
	/** Secondary watchers pass false to stay on the shared control-plane socket. */
	directTransport?: boolean;
	/** Restart/probe the detached supervisor after a transient socket loss. */
	recoverDaemon?: () => Promise<void>;
	/** Bound supervisor recovery before surfacing a fatal connection error. */
	reconnectTimeoutMs?: number;
	/** Interval of the low-speed retry that continues after `reconnectTimeoutMs` is spent. */
	backgroundReconnectRetryMs?: number;
	/** Bound an incomplete streamed snapshot before failing the attach or resync. */
	snapshotTimeoutMs?: number;
	/**
	 * Bound the attach request itself (P1-7a). Defaults to the snapshot budget: an
	 * attach that has not answered by then has a snapshot problem anyway, and
	 * naming the budget here keeps it off the transport's implicit default.
	 */
	attachTimeoutMs?: number;
	/** Overrides the full re-pull schedule used after a failed snapshot self-heal. */
	snapshotRecoveryRetryDelaysMs?: readonly number[];
	/**
	 * Overrides what the event-sequence gap detector does (P0-5c). Defaults to the
	 * `daemon.eventGapRecovery` setting, which itself defaults to "log": record the
	 * gap as evidence and change nothing. "recover" additionally re-pulls the
	 * session, and is only meant to be turned on after a zero-false-positive window.
	 */
	eventGapRecovery?: "log" | "recover";
	/**
	 * Send this client's allowlisted env (herdr pane identity) with attach so
	 * an env-less session (e.g. cron-created) adopts it. Set only by the
	 * primary interactive connection — the daemon adopts-if-absent, never
	 * rebinds, so watchers must not send env at all.
	 */
	sendClientEnv?: boolean;
	/** Advertise support for interactive extension dialogs. */
	supportsExtensionUi?: boolean;
	/** Dispose the connection by stopping its hidden worker instead of detaching. */
	ownedSession?: boolean;
	/** Fresh runtime context used only if the owned worker must be relaunched. */
	ownedSessionRecoveryConfig?: AgentSessionRuntimeConfig;
	/** Require the target worker to have been created with telemetry disabled. */
	telemetryDisabled?: true;
}

/**
 * AgentConnection adapter for the local daemon JSONL socket transport.
 *
 * InteractiveMode depends only on AgentConnection; local socket ownership and
 * daemon command details stay inside this adapter.
 */
export function buildSessionTreeFromFlatNodes(
	flatNodes: readonly AgentConnectionSessionTreeFlatNode[],
): AgentConnectionSessionTreeNode[] {
	const byId = new Map<string, AgentConnectionSessionTreeNode>();
	const roots: AgentConnectionSessionTreeNode[] = [];
	for (const flatNode of flatNodes) {
		byId.set(flatNode.entry.id, { ...flatNode, children: [] });
	}
	for (const flatNode of flatNodes) {
		const entry = flatNode.entry;
		const node = byId.get(entry.id)!;
		const parent = entry.parentId === null || entry.parentId === entry.id ? undefined : byId.get(entry.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	// Match SessionManager.getTree() ordering without recursively walking deep
	// chains: every node is already indexed, so sort each sibling array directly.
	for (const node of byId.values()) {
		node.children.sort(
			(left, right) => new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
		);
	}
	return roots;
}

export class DaemonAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly unsubscribeDaemonMessages: () => void;
	private readonly unsubscribeDaemonClose: () => void;
	private readonly clientId = `daemon-agent-connection:${randomUUID()}`;
	private readonly sessionInputPauses = new Map<string, Promise<AgentConnectionSessionInputPause>>();
	private sessionInputPauseGeneration = 0;
	private ownedSessionPromotionTail = Promise.resolve();
	private lastEventCursor: DaemonEventCursor | undefined;
	private readonly retiredEventGenerations = new Set<string>();
	/**
	 * Event-sequence gap detector state (P0-5c): the last cursor this client actually
	 * observed, disarmed after every reseed so a snapshot can never read as a gap.
	 */
	private eventGapBaseline: DaemonEventCursor | undefined;
	private eventGapArmed = false;
	private eventGapInFlight = false;
	private eventGapDetected = 0;
	private eventGapSuppressed = 0;
	private eventGapLastReportAt: number | undefined;
	private eventGapLastExpected: number | undefined;
	private eventGapLastGot: number | undefined;
	/** T4-4/F9 breaker state: consecutive re-pulls, their timestamps, and whether it opened. */
	private eventGapRecoveryStreak = 0;
	private eventGapLastRecoveryAt: number | undefined;
	private readonly eventGapRecoveryTimestamps: number[] = [];
	private eventGapBreakerOpen = false;
	private eventGapBreakerReason: string | undefined;
	private lastEventSequence: number | undefined;
	private childRosterSequence: number | undefined;
	private latestSnapshot: AgentConnectionSnapshot | undefined;
	private latestSnapshotIsFresh = false;
	/**
	 * Accumulates compact assistant_stream_delta events into the streaming
	 * assistant message, mirroring the supervisor-side reconstruction. Seeded
	 * from message_start events and from snapshots that carry a streamingMessage.
	 */
	private readonly streamReconstructor = new CompactAssistantStreamReconstructor();
	/** In-flight self-recovery after a delta arrived without a seed. */
	private streamResyncInFlight: Promise<void> | undefined;
	private attachedSessionId: string | undefined;
	private attachedSessionFile: string | undefined;
	private daemonLogPath: string | undefined;
	private updateRestartPending = false;
	private updateReconnectFailed = false;
	private terminalCloseEmitted = false;
	private updateReconnectPromise?: Promise<void>;
	private readonly activeSideQuestionIds = new Set<string>();
	private readonly snapshotAssemblies = new Map<string, DaemonSnapshotAssembly>();
	private readonly completedSnapshots = new Map<string, DaemonSessionSnapshot>();
	private readonly pendingReattachActiveSessionIds = new Set<string>();
	private readonly snapshotRecoveryPromises = new Map<string, Promise<void>>();
	private readonly ignoredSnapshotIds = new Set<string>();
	private rosterStore: AgentsViewRosterStore | undefined;
	private reconnectPromise?: Promise<void>;
	private backgroundReconnectPromise?: Promise<void>;
	private backgroundRetryWake?: () => void;
	private initialAttachPending = false;
	private initialControlPlaneClose?: Error;
	private readonly definitiveRequestErrors = new WeakSet<Error>();
	private disposing = false;
	private disposed = false;

	constructor(
		private readonly client: DaemonTransportClient,
		private activeSessionId: string,
		private readonly options: DaemonAgentConnectionOptions = {},
	) {
		if (options.recoverDaemon) {
			this.client.enableRequestRecovery();
		}
		this.unsubscribeDaemonMessages = this.client.onMessage((message) => {
			void this.handleDaemonMessage(message).catch((error: unknown) => {
				try {
					appendRotatingLog(
						getAgentLogPath(),
						`[${new Date().toISOString()}] daemon-message: ignored ${message.type} failure: ${String(error)}`,
					);
				} catch {
					// Logging failure must not turn an isolated message error into a connection failure.
				}
			});
		});
		this.captureDaemonLogPath();
		this.unsubscribeDaemonClose = this.client.onClose((error) => this.handleTransportClose(error));
	}

	private handleTransportClose(error: Error): void {
		const directSessionSurvives =
			this.client instanceof DaemonRoutedClient &&
			this.client.hasDirectTransport &&
			!(error instanceof DaemonDirectTransportClosedError);
		const invalidatedInputPause = !directSessionSurvives && this.sessionInputPauses.size > 0;
		if (!directSessionSurvives) {
			this.sessionInputPauses.clear();
			this.sessionInputPauseGeneration++;
			this.rejectSnapshotAssemblies(error);
		}
		if (this.initialAttachPending) {
			// attach() owns failure handling until the initial attach settles.
			if (directSessionSurvives) this.initialControlPlaneClose = error;
			return;
		}
		if (this.disposed || this.terminalCloseEmitted) {
			return;
		}
		// A lost direct link invalidates the fence (holders learn via the generation bump) yet the session falls back.
		if (invalidatedInputPause && !(error instanceof DaemonDirectTransportClosedError)) {
			this.terminalCloseEmitted = true;
			void this.emit({
				type: "closed",
				error: "Daemon connection closed while session input was paused; the fence was invalidated.",
			});
			return;
		}
		// An authoritative shutdown/update reason outranks the surviving direct link.
		const closeReason = getDaemonSocketCloseReason(error);
		if (closeReason === "shutdown") {
			this.terminalCloseEmitted = true;
			void this.emit({ type: "closed", error: this.formatDaemonSessionClosedError("shutdown") });
			return;
		}
		if ((this.updateRestartPending || closeReason === "update") && !this.updateReconnectFailed) {
			this.updateRestartPending = true;
			void this.reconnectAfterUpdate();
			return;
		}
		// A direct-transport loss is never itself a session loss: fall back through a supervisor re-attach.
		if (directSessionSurvives || error instanceof DaemonDirectTransportClosedError || this.options.recoverDaemon) {
			void this.reconnect(error);
			return;
		}
		this.terminalCloseEmitted = true;
		void this.emit({ type: "closed", error: this.formatDaemonConnectionClosedError(error) });
	}

	static async attach(
		client: DaemonTransportClient,
		activeSessionId: string,
		options?: DaemonAgentConnectionOptions,
	): Promise<DaemonAgentConnection> {
		const transport = await createDaemonSessionTransport(
			client,
			activeSessionId,
			options?.ownedSession === true || options?.directTransport === false,
		);
		const connection = new DaemonAgentConnection(transport, activeSessionId, options);
		connection.initialAttachPending = true;
		try {
			try {
				await connection.attach();
			} catch (error) {
				if (!(transport instanceof DaemonRoutedClient)) throw error;
				transport.fallbackToSupervisor();
				try {
					// This retry owns its failure; a parked request would pend the attach forever.
					await connection.attach({ recoverable: false });
				} catch (retryError) {
					// A control-plane close saved during the window is the authoritative cause.
					throw connection.initialControlPlaneClose ?? retryError;
				}
			}
			connection.initialAttachPending = false;
			const initialControlPlaneClose = connection.initialControlPlaneClose;
			connection.initialControlPlaneClose = undefined;
			if (initialControlPlaneClose) {
				// No listeners exist yet: a terminal close rejects the attach; the rest replays through the one handler.
				if (getDaemonSocketCloseReason(initialControlPlaneClose) === "shutdown") {
					throw initialControlPlaneClose;
				}
				connection.handleTransportClose(initialControlPlaneClose);
			}
			return connection;
		} catch (error) {
			connection.initialAttachPending = false;
			await connection.dispose();
			throw error;
		}
	}

	async attach(options?: { recoverable?: boolean }): Promise<void> {
		const supportsExtensionUi = this.options.supportsExtensionUi !== false;
		const result = await this.requestData<SessionSummary | DaemonAttachResult>(
			{
				type: "attach",
				activeSessionId: this.activeSessionId,
				supportsExtensionUi,
				clientId: this.clientId,
				capabilities: [
					"attach_snapshot",
					"event_sequence",
					...(supportsExtensionUi ? (["extension_ui"] as const) : []),
					"slim_attach",
					"chunked_snapshot",
					"streaming_deltas",
					"streaming_delta_fragments",
					...(this.options.ownedSession ? (["client_owned_sessions"] as const) : []),
				],
				env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
				launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : undefined,
				...(this.options.ownedSession &&
				this.options.ownedSessionRecoveryConfig &&
				this.client.supportsServerCapability("owned_session_recovery_context")
					? { recoveryConfig: this.options.ownedSessionRecoveryConfig }
					: {}),
				telemetryDisabled: this.options.telemetryDisabled,
				resumeCursor:
					this.lastEventCursor === undefined
						? undefined
						: {
								activeSessionId: this.activeSessionId,
								...this.lastEventCursor,
							},
			},
			this.options.attachTimeoutMs ?? DAEMON_SNAPSHOT_TIMEOUT_MS,
			options,
		);
		this.activeSessionId = getAttachActiveSessionId(result);
		const summary = "snapshot" in result ? result.snapshot.summary : result;
		this.attachedSessionId = summary.sessionId;
		this.attachedSessionFile =
			summary.sessionFile ?? ("snapshot" in result ? result.snapshot.state.sessionFile : undefined);
		this.captureDaemonLogPath();
		this.updateReconnectFailed = false;
		this.terminalCloseEmitted = false;
		const attachCursor = getAttachLastEventCursor(result);
		this.resetEventGapBaseline();
		if (attachCursor) {
			this.observeEventCursor(attachCursor);
		}
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, getAttachLastEventSequence(result));
		if ("snapshot" in result) {
			const snapshot = result.snapshotStream
				? await this.waitForSnapshot(result.snapshotStream.id)
				: result.snapshot;
			this.latestSnapshot = this.downgradeSnapshotStallState(mapDaemonSessionSnapshot(snapshot, result.replay));
			if (Array.isArray(snapshot.children)) this.childRosterSequence = snapshot.lastEventSequence;
			if (this.lastEventSequence !== undefined) {
				this.latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			if (this.lastEventCursor) {
				this.latestSnapshot.lastEventCursor = this.lastEventCursor;
			}
			this.latestSnapshotIsFresh = true;
		} else {
			this.latestSnapshot = undefined;
			this.latestSnapshotIsFresh = false;
		}
		this.reseedStreamReconstructor();
		// The roster bar is an accessory: its subscribe failure must never fail an
		// otherwise-recovered session. The bar degrades; the next reconnect or rebind
		// re-attaches through this same seam. The degradation is logged rather than
		// swallowed: a silent catch here is what left the bar permanently stale when
		// the daemon refused roster_subscribe.
		await this.attachRosterStore("attach");
	}

	async subscribeAgentRoster(
		listener: () => void,
	): Promise<{ summaries(): SessionSummary[]; dispose(): Promise<void> }> {
		this.rosterStore ??= new AgentsViewRosterStore();
		const store = this.rosterStore;
		if (!(await store.attach(this.client))) {
			throw new Error(STALE_ROSTER_DAEMON_MESSAGE);
		}
		const unsubscribe = store.onUpdate(listener);
		return {
			summaries: () => store.summaries(),
			dispose: async () => unsubscribe(),
		};
	}

	/**
	 * Re-binds the roster accessory without ever failing the session that carries it.
	 * Both degradation modes are logged instead of swallowed: `attach()` resolving
	 * false means the daemon never advertised `agent_roster`, and a rejection means
	 * the `roster_subscribe` round-trip itself failed. Silencing either is what let a
	 * capability refusal leave the agents-view roster bar permanently stale.
	 */
	private async attachRosterStore(where: string): Promise<void> {
		const store = this.rosterStore;
		if (!store) return;
		let detail: string | undefined;
		try {
			if (!(await store.attach(this.client))) detail = "daemon did not advertise agent_roster";
		} catch (error) {
			detail = String(error);
		}
		if (detail === undefined) return;
		try {
			appendRotatingLog(
				getAgentLogPath(),
				`[${new Date().toISOString()}] roster-attach: ${where} degraded: ${detail}`,
			);
		} catch {
			// A logging failure must not turn a degraded roster bar into a connection failure.
		}
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(_listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		return () => {};
	}

	async getState(): Promise<AgentConnectionState> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.state;
		}
		return this.requestData<AgentConnectionState>({
			type: "get_connection_state",
			activeSessionId: this.activeSessionId,
		});
	}

	async getInitialSnapshot(options?: { recoverable?: boolean }): Promise<AgentConnectionSnapshot> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot;
		}
		// The session tree is intentionally not fetched here: it is large on long
		// sessions and only needed when the user opens the tree/branch selector.
		// getSessionTree() fetches it lazily via get_session_tree on first use.
		const snapshotCursor = this.lastEventCursor;
		const snapshotSequence = this.lastEventSequence;
		const [state, messagesData, sessionContextData] = await Promise.all([
			this.requestData<AgentConnectionState>(
				{ type: "get_connection_state", activeSessionId: this.activeSessionId },
				undefined,
				options,
			),
			this.requestData<{ messages: AgentMessage[] }>(
				{ type: "get_messages", activeSessionId: this.activeSessionId },
				undefined,
				options,
			),
			this.requestData<{ context: AgentConnectionSessionContext }>(
				{ type: "get_session_context", activeSessionId: this.activeSessionId },
				undefined,
				options,
			),
		]);
		const children = this.latestSnapshot?.children;
		const streamingMessage = this.latestSnapshot?.streamingMessage;
		this.latestSnapshot = {
			state,
			messages: messagesData.messages,
			sessionContext: sessionContextData.context,
			...(children ? { children } : {}),
			...(streamingMessage ? { streamingMessage } : {}),
		};
		if (snapshotSequence !== undefined) {
			this.latestSnapshot.lastEventSequence = snapshotSequence;
		}
		if (snapshotCursor) {
			this.latestSnapshot.lastEventCursor = snapshotCursor;
		}
		this.latestSnapshotIsFresh =
			snapshotSequence === this.lastEventSequence &&
			snapshotCursor?.generation === this.lastEventCursor?.generation &&
			snapshotCursor?.sequence === this.lastEventCursor?.sequence;
		return this.latestSnapshot;
	}

	/**
	 * Downgrade subagent stall state when the daemon does not advertise
	 * `rlm_child_stall_activity` (revision 28 addition): "stalled" activity becomes
	 * "waiting" and the stall facts are dropped, so a client never renders a stall
	 * the server did not report.
	 */
	private downgradeChildStallState(child: AgentConnectionRlmChildAgentSnapshot): AgentConnectionRlmChildAgentSnapshot {
		if (this.client.supportsServerCapability("rlm_child_stall_activity")) return child;
		const stalled = child.activity?.kind === "stalled";
		if (!stalled && child.stall === undefined) return child;
		return { ...child, activity: stalled ? { kind: "waiting" } : child.activity, stall: undefined };
	}

	/** Single ingest point for a mapped daemon snapshot, so the roster downgrade cannot be missed. */
	private downgradeSnapshotStallState(snapshot: AgentConnectionSnapshot): AgentConnectionSnapshot {
		return snapshot.children
			? { ...snapshot, children: snapshot.children.map((child) => this.downgradeChildStallState(child)) }
			: snapshot;
	}

	async getRlmChildSnapshots(): Promise<AgentConnectionRlmChildAgentSnapshot[]> {
		if (!this.client.supportsServerCapability("authoritative_child_roster")) {
			throw new DaemonCapabilityUnavailableError("get_rlm_children", "authoritative_child_roster");
		}
		const data = await this.requestData<{
			children: AgentConnectionRlmChildAgentSnapshot[];
			eventSequence: number;
		}>({ type: "get_rlm_children", activeSessionId: this.activeSessionId });
		if (!Array.isArray(data.children) || !Number.isInteger(data.eventSequence)) {
			throw new Error("Daemon returned an invalid child roster");
		}
		const children = data.children.map((child) => this.downgradeChildStallState(child));
		if ((this.childRosterSequence ?? -1) > data.eventSequence) {
			return this.latestSnapshot?.children ?? children;
		}
		this.childRosterSequence = data.eventSequence;
		if (this.latestSnapshot) {
			this.latestSnapshot = { ...this.latestSnapshot, children };
		}
		return children;
	}

	async getMessages(): Promise<AgentMessage[]> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.messages;
		}
		const data = await this.requestData<{ messages: AgentMessage[] }>({
			type: "get_messages",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getSessionHeader(): Promise<AgentConnectionSessionHeader | undefined> {
		const data = await this.requestData<{ header?: AgentConnectionSessionHeader | null }>({
			type: "get_session_header",
			activeSessionId: this.activeSessionId,
		});
		return data.header ?? undefined;
	}

	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		const data = await this.requestData<{ commands: AgentConnectionSlashCommand[] }>({
			type: "get_commands",
			activeSessionId: this.activeSessionId,
		});
		return data.commands;
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return this.requestData<AgentConnectionResourceSnapshot>({
			type: "get_resource_snapshot",
			activeSessionId: this.activeSessionId,
		});
	}

	supportsAcpMcpServers(): boolean {
		return this.client.supportsServerCapability("acp_mcp_servers");
	}

	supportsRlmQuiescenceBarrier(): boolean {
		return this.client.supportsServerCapability("rlm_quiescence_barrier");
	}

	async replaceAcpMcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): Promise<void> {
		if (!this.supportsAcpMcpServers()) {
			throw new DaemonCapabilityUnavailableError("replace_acp_mcp_servers", "acp_mcp_servers");
		}
		await this.requestOk({
			type: "replace_acp_mcp_servers",
			activeSessionId: this.activeSessionId,
			ownerId,
			servers: [...servers],
		});
	}

	async releaseAcpMcpServers(ownerId: string, _serverNames: readonly string[]): Promise<void> {
		await this.replaceAcpMcpServers([], ownerId);
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		const data = await this.requestData<{ models: AgentConnectionModel[] }>({
			type: "get_available_models",
			activeSessionId: this.activeSessionId,
		});
		return data.models;
	}

	async getModelCatalog(): Promise<AgentConnectionModelCatalog> {
		if (!this.client.supportsServerCapability("model_catalog")) {
			const models = await this.getAvailableModels();
			return {
				models,
				configuredProviders: [...new Set(models.map((model) => model.provider))],
			};
		}
		return this.requestData<AgentConnectionModelCatalog>({
			type: "get_model_catalog",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.requestData<SessionStats>({
			type: "get_session_stats",
			activeSessionId: this.activeSessionId,
		});
	}

	async getContextTree(): Promise<ContextTreeNode> {
		return this.requestData<ContextTreeNode>({
			type: "get_context_tree",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionContext) {
			return this.latestSnapshot.sessionContext;
		}
		const data = await this.requestData<{ context: AgentConnectionSessionContext }>({
			type: "get_session_context",
			activeSessionId: this.activeSessionId,
		});
		return data.context;
	}

	async getSessionTree(): Promise<{
		tree: AgentConnectionSessionTreeNode[];
		leafId: string | null;
		bound?: AgentConnectionSessionTreeBound | AgentConnectionSessionTreeFlatStats;
	}> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionTree) {
			return this.latestSnapshot.sessionTree;
		}
		const data = await this.requestData<{
			flatNodes: AgentConnectionSessionTreeFlatNode[];
			leafId: string | null;
			// The daemon caps the flat tree at SESSION_TREE_FLAT_MAX_NODES nodes - the live
			// leaf's chain plus the newest entries - and reports the cap here; forwarding it
			// keeps the truncation visible at the client boundary instead of silent (the
			// stats are the flat bound, not the snapshot's depth bound).
			treeBound?: AgentConnectionSessionTreeFlatStats;
		}>({
			type: "get_session_tree",
			activeSessionId: this.activeSessionId,
		});
		return {
			tree: buildSessionTreeFromFlatNodes(data.flatNodes),
			leafId: data.leafId,
			bound: data.treeBound,
		};
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		return listDaemonSavedSessions(this.client, { activeSessionId: this.activeSessionId }, scope, callbacks);
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "get_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async mutateQueuedMessage(
		lane: AgentConnectionQueuedMessageLane,
		index: number,
		expectedText: string,
		mutation: AgentConnectionQueuedMessageMutation,
	): Promise<AgentConnectionQueuedMessageMutationStatus> {
		if (!this.client.supportsServerCapability("queue_message_mutation")) return "unsupported";
		const data = await this.requestData<{ status: AgentConnectionQueuedMessageMutationStatus }>({
			type: "mutate_queued_message",
			activeSessionId: this.activeSessionId,
			lane,
			index,
			expectedText,
			mutation,
		});
		return data.status;
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "clear_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async abortAndClearQueue(): Promise<AgentConnectionQueueState> {
		try {
			return await this.requestData<AgentConnectionQueueState>({
				type: "abort_and_clear_queue",
				activeSessionId: this.activeSessionId,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_and_clear_queue")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async acquireSessionInputPause(leaseKey: string): Promise<AgentConnectionSessionInputPause> {
		if (this.terminalCloseEmitted) throw new Error("Daemon connection is closed; cannot acquire an input pause.");
		const activeSessionId = this.activeSessionId;
		const generation = this.sessionInputPauseGeneration;
		const acquisitionKey = JSON.stringify([activeSessionId, leaseKey]);
		const existing = this.sessionInputPauses.get(acquisitionKey);
		if (existing) return existing;
		const acquisition = (async (): Promise<AgentConnectionSessionInputPause> => {
			const { pauseId } = await this.requestData<{ pauseId: string }>({
				type: "acquire_session_input_pause",
				activeSessionId,
				leaseKey,
			});
			if (generation !== this.sessionInputPauseGeneration || this.terminalCloseEmitted) {
				try {
					await this.requestData({
						type: "release_session_input_pause",
						activeSessionId,
						pauseId,
					});
				} catch {
					this.client.close();
				}
				throw new Error("Session input pause acquisition was invalidated by a daemon reconnect.");
			}
			let released = false;
			return {
				release: async () => {
					if (released) return;
					if (generation !== this.sessionInputPauseGeneration) {
						throw new Error("Session input pause was invalidated by a daemon reconnect.");
					}
					await this.requestData({
						type: "release_session_input_pause",
						activeSessionId,
						pauseId,
					});
					released = true;
					if (this.sessionInputPauses.get(acquisitionKey) === acquisition) {
						this.sessionInputPauses.delete(acquisitionKey);
					}
				},
			};
		})();
		this.sessionInputPauses.set(acquisitionKey, acquisition);
		try {
			return await acquisition;
		} catch (error) {
			if (this.sessionInputPauses.get(acquisitionKey) === acquisition)
				this.sessionInputPauses.delete(acquisitionKey);
			throw error;
		}
	}
	async resumeQueuedWork(): Promise<boolean> {
		try {
			await this.requestData({
				type: "resume_queue",
				activeSessionId: this.activeSessionId,
			});
			return true;
		} catch (error) {
			// The daemon reports an empty/unsuspended queue as a command failure;
			// that is a normal no-op here, while real errors keep propagating.
			if (error instanceof Error && error.message === "No queued work to resume") {
				return false;
			}
			throw error;
		}
	}

	async listCronJobs(options: { includeInactive?: boolean } = {}): Promise<AgentCronJob[]> {
		const data = await this.requestData<{ jobs: AgentCronJob[] }>({
			type: "cron_list",
			activeSessionId: this.activeSessionId,
			includeInactive: options.includeInactive,
		});
		return data.jobs;
	}

	async listHeartbeats(): Promise<AgentConnectionHeartbeat[]> {
		return listDaemonHeartbeats(this.client, this.options.ownedSession ? this.activeSessionId : undefined);
	}

	async manageHeartbeat(
		activeSessionId: string,
		jobId: string,
		action: AgentHeartbeatManagementAction,
	): Promise<AgentCronJob> {
		if (!this.client.supportsServerCapability("heartbeat_management")) {
			throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
		}
		try {
			const data = await this.requestData<{ heartbeat: AgentCronJob }>({
				type: "heartbeat_manage",
				activeSessionId,
				jobId,
				action,
			});
			return data.heartbeat;
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "heartbeat_manage")) {
				throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
			}
			throw error;
		}
	}

	async addCronJob(schedule: string, prompt: string): Promise<AgentCronJob> {
		return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			const data = await this.requestData<{ job: AgentCronJob }>({
				type: "cron_add",
				activeSessionId: this.activeSessionId,
				schedule,
				prompt,
				promoteOwnedSession,
			});
			return data.job;
		});
	}

	async cancelCronJob(jobId: string): Promise<AgentCronJob> {
		const data = await this.requestData<{ job: AgentCronJob }>({
			type: "cron_cancel",
			activeSessionId: this.activeSessionId,
			jobId,
		});
		return data.job;
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_get",
			activeSessionId: this.activeSessionId,
		});
		return data.heartbeat ?? undefined;
	}

	async setHeartbeat(
		schedule: string,
		instruction: string,
		deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob> {
		return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			const data = await this.requestData<{ heartbeat: AgentCronJob }>({
				type: "heartbeat_set",
				activeSessionId: this.activeSessionId,
				schedule,
				prompt: instruction,
				...(deliveryMode ? { deliveryMode } : {}),
				promoteOwnedSession,
			});
			return data.heartbeat;
		});
	}

	async updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_update",
			activeSessionId: this.activeSessionId,
			action,
		});
		return data.heartbeat ?? undefined;
	}

	async sendAgentMessage(targetActiveSessionId: string, message: string): Promise<AgentSessionMessageReceipt> {
		return this.requestData<AgentSessionMessageReceipt>({
			type: "send_message",
			targetActiveSessionId,
			message,
			fromActiveSessionId: this.activeSessionId,
		});
	}

	async getAgentMessageStatus(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_status",
			activeSessionId: this.activeSessionId,
		});
	}

	async pauseAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_pause",
			activeSessionId: this.activeSessionId,
		});
	}

	async resumeAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_resume",
			activeSessionId: this.activeSessionId,
		});
	}

	async clearAgentMessages(): Promise<number> {
		return this.requestData<number>({
			type: "agent_messages_clear",
			activeSessionId: this.activeSessionId,
		});
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		const data = await this.requestData<{ messages: AgentConnectionUserMessage[] }>({
			type: "get_user_messages_for_forking",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getLastAssistantText(): Promise<string | undefined> {
		const data = await this.requestData<{ text?: string | null }>({
			type: "get_last_assistant_text",
			activeSessionId: this.activeSessionId,
		});
		return data.text ?? undefined;
	}

	async getSystemPrompt(): Promise<string> {
		const data = await this.requestData<{ systemPrompt: string }>({
			type: "get_system_prompt",
			activeSessionId: this.activeSessionId,
		});
		return data.systemPrompt;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		const data = await this.requestData<{ toolDefinition?: AgentConnectionToolDefinition }>({
			type: "get_tool_definition",
			activeSessionId: this.activeSessionId,
			name,
		});
		return data.toolDefinition;
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		await this.requestOk({
			type: "set_session_entry_label",
			activeSessionId: this.activeSessionId,
			entryId,
			label,
		});
	}

	async respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void> {
		await this.requestOk({
			type: "extension_ui_response",
			activeSessionId: this.activeSessionId,
			requestId,
			response,
		});
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.promptWithAdmissionCancellation("prompt", message, options);
	}

	async promptAndWait(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.promptWithAdmissionCancellation("prompt_and_wait", message, options);
	}

	private async promptWithAdmissionCancellation(
		type: "prompt" | "prompt_and_wait",
		message: string,
		options?: AgentConnectionPromptOptions,
	): Promise<void> {
		const signal = options?.signal;
		if (signal?.aborted) {
			throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
		}
		if (!signal) {
			await this.requestData<unknown>(
				{
					type,
					activeSessionId: this.activeSessionId,
					message,
					images: options?.images,
					streamingBehavior: options?.streamingBehavior,
					queueIfBusy: options?.queueIfBusy,
					source: options?.source,
				},
				DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
			);
			return;
		}
		const admissionId = `prompt-admission:${randomUUID()}`;
		let resolveAbort = () => {};
		const aborted = new Promise<"abort">((resolve) => {
			resolveAbort = () => resolve("abort");
		});
		const onAbort = () => resolveAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before issuing the first request.
		if (signal.aborted) {
			signal.removeEventListener("abort", onAbort);
			throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
		}
		const command = {
			type,
			activeSessionId: this.activeSessionId,
			message,
			images: options.images,
			streamingBehavior: options.streamingBehavior,
			queueIfBusy: options.queueIfBusy,
			source: options.source,
			admissionId,
		} as Extract<DaemonCommandBody, { type: typeof type }>;
		let promptError: unknown;
		const promptRequest = this.requestData<unknown>(command, DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS).catch(
			(error: unknown) => {
				promptError =
					error instanceof DaemonCapabilityUnavailableError && !error.afterReconnect
						? new AgentConnectionPromptAdmissionError(error.message, "unsupported", { cause: error })
						: error;
				return "failed" as const;
			},
		);
		try {
			const first = await Promise.race([promptRequest.then(() => "settled" as const), aborted]);
			if (first === "settled" && promptError === undefined) return;
			if (first === "settled" && promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
			if (
				first === "settled" &&
				!signal.aborted &&
				promptError instanceof Error &&
				this.definitiveRequestErrors.has(promptError)
			) {
				throw promptError;
			}
			let status: "cancelled" | "owned" | "unknown" = "unknown";
			try {
				const result = await this.requestData<{ status: "cancelled" | "owned" | "unknown" }>({
					type: "cancel_prompt_admission",
					activeSessionId: this.activeSessionId,
					admissionId,
					...(this.client.supportsServerCapability("owned_prompt_cancellation") ? { cancelOwned: true } : {}),
				});
				status = result.status;
			} catch {
				// Timeout/transport is indistinguishable from accepted ownership.
			}
			await promptRequest;
			if (promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
			const definitiveFailure = promptError instanceof Error && this.definitiveRequestErrors.has(promptError);
			if (promptError === undefined || (status === "owned" && type === "prompt" && !definitiveFailure)) return;
			throw new AgentConnectionPromptAdmissionError(
				promptError instanceof Error ? promptError.message : "Prompt admission did not complete.",
				status,
				promptError === undefined ? undefined : { cause: promptError },
			);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async startSideQuestion(
		id: string,
		question: string,
		previousTurns?: AgentConnectionSideQuestionTurn[],
	): Promise<void> {
		if (previousTurns?.length && !this.client.supportsServerCapability("side_question_transcript")) {
			// An older daemon would silently ignore previousTurns and answer the
			// follow-up without the side-conversation context; fail loudly instead.
			throw new Error(
				"the daemon is running an older build without side-conversation follow-ups; restart the daemon and try again",
			);
		}
		this.activeSideQuestionIds.add(id);
		try {
			await this.requestOk({
				type: "start_side_question",
				activeSessionId: this.activeSessionId,
				sideQuestionId: id,
				question,
				previousTurns,
			});
		} catch (error) {
			this.activeSideQuestionIds.delete(id);
			if (isUnknownDaemonCommandError(error, "start_side_question")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async abortSideQuestion(id: string): Promise<boolean> {
		const data = await this.requestData<{ aborted: boolean }>({
			type: "abort_side_question",
			activeSessionId: this.activeSessionId,
			sideQuestionId: id,
		});
		this.activeSideQuestionIds.delete(id);
		return data.aborted;
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "steer", activeSessionId: this.activeSessionId, message, images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "follow_up", activeSessionId: this.activeSessionId, message, images });
	}

	async abort(): Promise<void> {
		await this.requestOk({ type: "abort", activeSessionId: this.activeSessionId });
	}

	/**
	 * Abort the active run and start every queued user steering message in one new turn.
	 *
	 * Degradation is loud, not silent (P5 ruling, merge-doc SS11.4): a daemon without
	 * abort_and_send_queued can only be asked for a plain abort, and the queued messages
	 * then stay queued. The caller asked for a different outcome and would otherwise
	 * never learn it got the narrower one, so the fallback logs the same
	 * daemon-connection diagnostic line the roster degradation uses. The
	 * abort_and_clear_queue precedent keeps its own shape (a loud refusal) because that
	 * command answers with visible data while this one's effect is a side effect.
	 */
	async abortAndSendQueued(): Promise<void> {
		if (!this.client.supportsServerCapability("abort_and_send_queued")) {
			this.logConnection(
				"abort-and-send-queued degraded: daemon did not advertise the capability; queued messages stay queued",
			);
			await this.abort();
			return;
		}
		try {
			await this.requestOk({ type: "abort_and_send_queued", activeSessionId: this.activeSessionId });
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_and_send_queued")) {
				this.logConnection(
					"abort-and-send-queued degraded: daemon answered Unknown daemon command; queued messages stay queued",
				);
				await this.abort();
				return;
			}
			throw error;
		}
	}

	async cancelRlmChild(childId: string): Promise<boolean> {
		try {
			const result = await this.requestData<{ cancelled: boolean }>({
				type: "cancel_rlm_child",
				activeSessionId: this.activeSessionId,
				childId,
			});
			return result.cancelled;
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "cancel_rlm_child")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async waitForIdle(): Promise<void> {
		await this.requestData<unknown>(
			{ type: "wait_for_idle", activeSessionId: this.activeSessionId },
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async waitForHeadlessCompletion(
		options?: AgentConnectionHeadlessCompletionOptions,
	): Promise<HeadlessCompletionResult> {
		if (options?.waitForRlmQuiescence && !this.client.supportsServerCapability("rlm_quiescence_barrier")) {
			throw new Error(
				"the daemon is running an older build without RLM quiescence barriers; restart the daemon and try again",
			);
		}
		return this.requestData<HeadlessCompletionResult>(
			{
				type: "wait_for_headless_completion",
				activeSessionId: this.activeSessionId,
				...(options?.waitForRlmQuiescence ? { waitForRlmQuiescence: true } : {}),
			},
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		if (options?.transient && !this.client.supportsServerCapability("transient_bash")) {
			// An older daemon would record the run into the session, leaking the
			// side conversation into the main transcript; fail loudly instead.
			throw new Error(
				"the daemon is running an older build without side-conversation bash; restart the daemon and try again",
			);
		}
		try {
			await this.requestOk({
				type: "execute_bash",
				activeSessionId: this.activeSessionId,
				command,
				excludeFromContext: options?.excludeFromContext,
				transient: options?.transient,
				runId: options?.runId,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "execute_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async executeBashAndWait(command: string): Promise<BashResult> {
		return this.requestData<BashResult>(
			{
				type: "execute_bash_and_wait",
				activeSessionId: this.activeSessionId,
				command,
			},
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async abortBash(): Promise<void> {
		try {
			await this.requestOk({ type: "abort_bash", activeSessionId: this.activeSessionId });
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		return this.requestData<AgentConnectionModel>({
			type: "set_model",
			activeSessionId: this.activeSessionId,
			provider,
			modelId,
		});
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined> {
		const result = await this.requestData<AgentConnectionModelCycleResult | null>({
			type: "cycle_model",
			activeSessionId: this.activeSessionId,
			direction,
		});
		return result ?? undefined;
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		await this.requestOk({
			type: "set_scoped_models",
			activeSessionId: this.activeSessionId,
			scopedModels,
		});
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.requestOk({ type: "set_thinking_level", activeSessionId: this.activeSessionId, level });
	}

	async setServiceTier(serviceTier: ServiceTier): Promise<void> {
		await this.requestOk({ type: "set_service_tier", activeSessionId: this.activeSessionId, serviceTier });
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const result = await this.requestData<{ level: ThinkingLevel } | null>({
			type: "cycle_thinking_level",
			activeSessionId: this.activeSessionId,
		});
		return result?.level;
	}

	async setTransport(transport: Transport): Promise<void> {
		await this.requestOk({ type: "set_transport", activeSessionId: this.activeSessionId, transport });
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_steering_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_follow_up_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		await this.requestOk({ type: "set_auto_compaction", activeSessionId: this.activeSessionId, enabled });
	}

	async setAutoRetryEnabled(enabled: boolean): Promise<void> {
		await this.requestOk({ type: "set_auto_retry", activeSessionId: this.activeSessionId, enabled });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		try {
			return await this.requestData<CompactionResult>(
				{
					type: "compact",
					activeSessionId: this.activeSessionId,
					customInstructions,
				},
				DAEMON_COMPACT_REQUEST_TIMEOUT_MS,
			);
		} catch (error) {
			// A timeout here means the client stopped waiting, not that the daemon
			// stopped compacting: the run continues server-side and a blind retry
			// would hit "Already compacted", so the error must say what is going on.
			if (error instanceof DaemonRequestTimeoutError) {
				throw new Error(
					`${error.message} The daemon is likely still compacting this session; the result will land with the next compaction_end event, so check the session state instead of retrying immediately.`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		const command: {
			type: "refine";
			activeSessionId: string;
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {
			type: "refine",
			activeSessionId: this.activeSessionId,
			instructions: options.instructions,
			rollbackId: options.rollbackId,
		};
		if (options.global !== undefined) {
			command.global = options.global;
		}
		return this.requestData<RefinementResult>(command, DAEMON_REFINE_REQUEST_TIMEOUT_MS);
	}

	async abortCompaction(): Promise<void> {
		await this.requestOk({ type: "abort_compaction", activeSessionId: this.activeSessionId });
	}

	async abortBranchSummary(): Promise<void> {
		await this.requestOk({ type: "abort_branch_summary", activeSessionId: this.activeSessionId });
	}

	async abortRetry(): Promise<void> {
		await this.requestOk({ type: "abort_retry", activeSessionId: this.activeSessionId });
	}

	async reload(): Promise<void> {
		await this.requestOk({ type: "reload", activeSessionId: this.activeSessionId });
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "new_session",
			activeSessionId: this.activeSessionId,
			parentSession: options?.parentSession,
		});
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		const sourceActiveSessionId = this.activeSessionId;
		try {
			return await this.requestData<{ cancelled: boolean }>({
				type: "switch_session",
				activeSessionId: sourceActiveSessionId,
				sessionPath,
				cwdOverride: options?.cwdOverride,
			});
		} catch (error) {
			if (!(error instanceof SessionAlreadyActiveError) || !error.activeSessionId) {
				throw error;
			}
			if (this.options.ownedSession) {
				throw error;
			}
			if (error.activeSessionId === sourceActiveSessionId) {
				return { cancelled: false };
			}
			return this.reattachSession(sourceActiveSessionId, error.activeSessionId);
		}
	}

	private async reattachSession(
		sourceActiveSessionId: string,
		targetActiveSessionId: string,
	): Promise<{ cancelled: false }> {
		const previousState = {
			lastEventCursor: this.lastEventCursor,
			lastEventSequence: this.lastEventSequence,
			latestSnapshot: this.latestSnapshot,
			latestSnapshotIsFresh: this.latestSnapshotIsFresh,
			retiredEventGenerations: new Set(this.retiredEventGenerations),
		};
		this.activeSessionId = targetActiveSessionId;
		this.lastEventCursor = undefined;
		this.lastEventSequence = undefined;
		this.resetEventGapBaseline();
		this.latestSnapshot = undefined;
		this.latestSnapshotIsFresh = false;
		this.retiredEventGenerations.clear();
		this.pendingReattachActiveSessionIds.add(targetActiveSessionId);
		let reattached = false;
		try {
			const supportsExtensionUi = this.options.supportsExtensionUi !== false;
			const result = await this.requestData<DaemonAttachResult>({
				type: "reattach",
				activeSessionId: sourceActiveSessionId,
				targetActiveSessionId,
				supportsExtensionUi,
				clientId: this.clientId,
				capabilities: [
					"attach_snapshot",
					"event_sequence",
					...(supportsExtensionUi ? (["extension_ui"] as const) : []),
					"slim_attach",
					"chunked_snapshot",
					"streaming_deltas",
					"streaming_delta_fragments",
					...(this.options.ownedSession ? (["client_owned_sessions"] as const) : []),
				],
				env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
				launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : undefined,
				telemetryDisabled: this.options.telemetryDisabled,
			});
			// Reattach rebinds the connection (and drops any direct link); pauses on the old session are gone.
			this.sessionInputPauses.clear();
			this.sessionInputPauseGeneration++;
			reattached = true;
			this.activeSessionId = result.activeSessionId;
			this.activeSideQuestionIds.clear();
			if (result.snapshotStream) {
				try {
					await this.waitForSnapshot(result.snapshotStream.id);
				} catch (snapshotError) {
					await this.snapshotRecoveryPromises.get(result.snapshotStream.id);
					if (!this.latestSnapshotIsFresh) {
						throw snapshotError;
					}
				}
			} else {
				this.applyReplacementSnapshot(result.snapshot, result.replay);
				await this.emit({
					type: "session_replaced",
					state: result.snapshot.state,
					messages: result.snapshot.messages,
				});
			}
			return { cancelled: false };
		} catch (error) {
			if (!reattached) {
				this.activeSessionId = sourceActiveSessionId;
				this.lastEventCursor = previousState.lastEventCursor;
				this.lastEventSequence = previousState.lastEventSequence;
				this.latestSnapshot = previousState.latestSnapshot;
				this.latestSnapshotIsFresh = previousState.latestSnapshotIsFresh;
				this.reseedStreamReconstructor();
				this.retiredEventGenerations.clear();
				for (const generation of previousState.retiredEventGenerations) {
					this.retiredEventGenerations.add(generation);
				}
			}
			throw error;
		} finally {
			this.pendingReattachActiveSessionIds.delete(targetActiveSessionId);
		}
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.requestData<{ cancelled: boolean; selectedText?: string }>({
			type: "fork",
			activeSessionId: this.activeSessionId,
			entryId,
			position: options?.position,
		});
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return this.requestData<AgentConnectionNavigateTreeResult>({
			type: "navigate_tree",
			activeSessionId: this.activeSessionId,
			targetId,
			summarize: options?.summarize,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		});
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "import_jsonl",
			activeSessionId: this.activeSessionId,
			inputPath,
			cwdOverride,
		});
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_html",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_jsonl",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async setSessionName(name: string): Promise<void> {
		await this.requestOk({ type: "set_session_name", activeSessionId: this.activeSessionId, name });
	}

	async getRlmMaxDepthStatus() {
		return this.requestData<{ maxDepth: number; source: "default" | "env" | "global" | "inherited" | "chat" }>({
			type: "get_rlm_max_depth_status",
			activeSessionId: this.activeSessionId,
		});
	}

	async setRlmMaxDepth(maxDepth: number, options?: { global?: boolean }) {
		return this.requestData<{
			maxDepth: number;
			source: "default" | "env" | "global" | "inherited" | "chat";
			globalSaved: boolean;
			globalError?: string;
		}>({
			type: "set_rlm_max_depth",
			activeSessionId: this.activeSessionId,
			maxDepth,
			global: options?.global,
		});
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		await renameDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath, name);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return deleteDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath);
	}

	async watchSession(activeSessionId: string): Promise<AgentConnectionSessionWatcher | undefined> {
		// A second connection on the shared client; each one filters to its own session id.
		// attach() rejects for an unknown/exited session — treat that as unreachable.
		let connection: DaemonAgentConnection;
		try {
			const watchClient =
				this.client instanceof DaemonRoutedClient ? this.client.controlPlaneTransport : this.client;
			connection = await DaemonAgentConnection.attach(watchClient, activeSessionId, {
				closeClientOnDispose: false,
				directTransport: false,
			});
		} catch {
			return undefined;
		}
		return {
			getMessages: () => connection.getMessages(),
			getCommands: () => connection.getCommands(),
			subscribe: (listener) => connection.subscribe(listener),
			getToolDefinition: (name) => connection.getToolDefinition(name),
			close: async () => {
				await connection.dispose();
			},
		};
	}

	async dispose(options?: AgentConnectionDisposeOptions): Promise<AgentConnectionDisposeOutcome | undefined> {
		if (this.disposed || this.disposing) {
			return;
		}
		this.disposing = true;
		// Stop a low-speed background retry at once instead of letting it wake after dispose.
		this.backgroundRetryWake?.();
		this.backgroundRetryWake = undefined;
		if (this.options.ownedSession && !this.client.isConnected && this.reconnectPromise) {
			await Promise.race([this.reconnectPromise, delay(OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS)]).catch(
				() => undefined,
			);
		}
		this.disposed = true;
		this.updateRestartPending = false;
		await Promise.allSettled([...this.activeSideQuestionIds].map((id) => this.abortSideQuestion(id)));
		await this.rosterStore?.dispose().catch(() => undefined);
		this.rosterStore = undefined;
		this.unsubscribeDaemonMessages();
		this.unsubscribeDaemonClose();
		// K3Q-1: a headless run that gave up waiting for still-running descendants
		// must not stop the worker - complete_owned_session's worker shutdown
		// cascades into aborting them. Promote the owned session to resident first
		// so it survives the detach; the descendants keep running and the session
		// can be re-attached.
		// K3R-1: a promote failure used to be swallowed and the dispose fell back
		// to complete_owned_session, silently running the exact cascade the
		// promotion exists to prevent. Retry the promote; if it still fails, take
		// the non-cascading detach path and report the failure so the caller's
		// "left running" message can match reality.
		let promoteFailure: string | undefined;
		if (this.options.ownedSession && options?.keepSessionRunning) {
			promoteFailure = await this.promoteToResidentForKeepRunning();
		}
		if (this.options.ownedSession && !promoteFailure) {
			await this.requestOk({ type: "complete_owned_session", activeSessionId: this.activeSessionId }).catch(
				() => undefined,
			);
		} else {
			await this.requestOk({ type: "detach", activeSessionId: this.activeSessionId }).catch(() => undefined);
		}
		if (this.options.closeClientOnDispose) {
			this.client.close();
		}
		this.rejectSnapshotAssemblies(new Error("Daemon connection disposed during snapshot transfer"));
		return options?.keepSessionRunning
			? { keepSessionRunning: { leftRunning: !promoteFailure, errorMessage: promoteFailure } }
			: undefined;
	}

	async promoteToResident(): Promise<void> {
		await this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			if (!promoteOwnedSession) return;
			await this.requestOk({ type: "promote_owned_session", activeSessionId: this.activeSessionId });
		});
	}

	private async promoteToResidentForKeepRunning(attempts = 3): Promise<string | undefined> {
		let lastError: unknown;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				await this.promoteToResident();
				return undefined;
			} catch (error) {
				lastError = error;
			}
			if (attempt < attempts - 1) {
				await delay(OWNED_SESSION_PROMOTE_RETRY_MS);
			}
		}
		return lastError instanceof Error ? lastError.message : String(lastError);
	}

	private withOwnedSessionPromotion<T>(operation: (promoteOwnedSession: boolean) => Promise<T>): Promise<T> {
		const run = this.ownedSessionPromotionTail.then(async () => {
			const promoteOwnedSession = this.options.ownedSession === true;
			const result = await operation(promoteOwnedSession);
			if (promoteOwnedSession) {
				this.options.ownedSession = false;
			}
			return result;
		});
		this.ownedSessionPromotionTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reconnect(cause: Error): Promise<void> {
		if (this.reconnectPromise) {
			return this.reconnectPromise;
		}
		this.reconnectPromise = (async () => {
			void this.emit({ type: "connection_status", status: "reconnecting", error: cause.message });
			const timeoutMs = this.options.reconnectTimeoutMs ?? DAEMON_RECONNECT_TIMEOUT_MS;
			let deadline: number | undefined;
			let attempt = 0;
			let lastError: Error = cause;
			while (!this.disposed) {
				// A held direct link owns session liveness: control-plane recovery retries unbounded,
				// and the bounded session-plane deadline arms only once the direct link is gone.
				const directSessionHeld = this.client instanceof DaemonRoutedClient && this.client.hasDirectTransport;
				if (directSessionHeld) {
					deadline = undefined;
				} else {
					deadline ??= Date.now() + timeoutMs;
					if (Date.now() >= deadline) break;
				}
				let controlPlaneHandshakeComplete = false;
				try {
					await this.options.recoverDaemon?.();
					if (this.disposed) {
						return;
					}
					await this.client.connect(1000);
					await this.client.waitForHello(3000);
					controlPlaneHandshakeComplete = true;
					if (directSessionHeld) {
						// The roster subscription is a control-plane accessory; its usual rebind seam (attach) is skipped while held.
						await this.attachRosterStore("reconnect-held-direct");
						// One check after the last await, against the close handler's own dispatch outputs:
						// terminal closes set terminalCloseEmitted, update closes set updateRestartPending
						// (restoration owns the client), and recoverable closes joined this loop.
						if (this.disposed || this.terminalCloseEmitted || this.updateRestartPending) {
							return;
						}
						if (this.client instanceof DaemonRoutedClient && this.client.hasDirectTransport) {
							void this.emit({ type: "connection_status", status: "connected" });
							return;
						}
						// The direct link died mid-recovery: rerun as a bounded session-plane reconnect.
						continue;
					}
					// This loop owns the retry: a socket close must reject these instead of parking them behind a hello it can never produce.
					await this.attach({ recoverable: false });
					if (!this.disposed) {
						const snapshot = await this.getInitialSnapshot({ recoverable: false });
						void this.emit({ type: "session_resynced", snapshot });
						void this.emit({ type: "connection_status", status: "connected" });
					}
					return;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (this.disposed) {
						return;
					}
					// A direct-half failure must not tear down a control-plane socket with a completed handshake.
					const shouldResetControlPlane =
						!(this.client instanceof DaemonRoutedClient) ||
						!controlPlaneHandshakeComplete ||
						error instanceof DaemonControlPlaneTransportError ||
						!this.client.isControlPlaneReady;
					if (shouldResetControlPlane) this.client.resetTransportForReconnect();
					if (deadline !== undefined && deadline - Date.now() <= 0) {
						break;
					}
					const delayMs = Math.min(
						...(deadline !== undefined ? [deadline - Date.now()] : []),
						2000,
						100 * 2 ** Math.min(attempt, 5),
					);
					attempt++;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
				}
			}
			if (!this.disposed) {
				this.sessionInputPauses.clear();
				this.sessionInputPauseGeneration++;
				// The budget ending is not the end of recovery: the transport is reset
				// (not closed, so the background retry can re-attach through it) and the
				// low-speed loop takes over. `closed` still goes out, because a caller
				// that treats the fast budget as terminal must be able to.
				this.terminalCloseEmitted = true;
				this.client.resetTransportForReconnect();
				this.logConnection(
					`reconnect budget extended: ${timeoutMs}ms exhausted for ${this.activeSessionId}, retrying every ${DAEMON_BACKGROUND_RECONNECT_RETRY_MS}ms (${lastError.message})`,
				);
				await this.emit({ type: "closed", error: `Daemon reconnection failed: ${lastError.message}` });
				this.startBackgroundReconnect(lastError);
			}
		})().finally(() => {
			this.reconnectPromise = undefined;
		});
		return this.reconnectPromise;
	}

	/**
	 * Low-speed retry after the fast reconnect budget is spent (P1-7b). One
	 * attempt every 30s, each a full re-attach plus snapshot, until it succeeds,
	 * the connection is disposed, or the target answers with a terminal error
	 * (I-9: a session the reaper collected will keep answering "Unknown active
	 * session", and retrying that forever is noise, not recovery).
	 */
	private startBackgroundReconnect(cause: Error): void {
		if (this.disposed || this.backgroundReconnectPromise) {
			return;
		}
		this.backgroundReconnectPromise = (async () => {
			let attempt = 0;
			let lastError = cause;
			while (!this.disposed) {
				await this.sleepBackgroundRetry();
				if (this.disposed) {
					return;
				}
				attempt++;
				void this.emit({
					type: "connection_status",
					status: "reconnecting",
					error: lastError.message,
					backgroundAttempt: attempt,
				});
				try {
					await this.options.recoverDaemon?.();
					if (this.disposed) {
						return;
					}
					await this.client.connect(1000);
					await this.client.waitForHello(3000);
					await this.attach({ recoverable: false });
					const snapshot = await this.getInitialSnapshot({ recoverable: false });
					if (this.disposed) {
						return;
					}
					this.terminalCloseEmitted = false;
					this.logConnection(`background reconnect re-attached ${this.activeSessionId} on attempt ${attempt}`);
					void this.emit({ type: "session_resynced", snapshot });
					void this.emit({ type: "connection_status", status: "connected" });
					return;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (this.disposed) {
						return;
					}
					if (isTerminalReconnectError(lastError)) {
						this.logConnection(
							`background reconnect stopped for ${this.activeSessionId}: terminal answer after ${attempt} attempt(s): ${lastError.message}`,
						);
						this.client.close();
						return;
					}
					this.logConnection(
						`background reconnect attempt ${attempt} failed for ${this.activeSessionId}: ${lastError.message}`,
					);
					this.client.resetTransportForReconnect();
				}
			}
		})().finally(() => {
			this.backgroundReconnectPromise = undefined;
		});
	}

	/** A background retry wait is interruptible, so dispose stops the loop at once. */
	private sleepBackgroundRetry(): Promise<void> {
		return new Promise((resolveSleep) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const wake = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				this.backgroundRetryWake = undefined;
				resolveSleep();
			};
			this.backgroundRetryWake = wake;
			timer = setTimeout(wake, this.options.backgroundReconnectRetryMs ?? DAEMON_BACKGROUND_RECONNECT_RETRY_MS);
		});
	}

	private logConnection(message: string): void {
		try {
			appendRotatingLog(getAgentLogPath(), `[${new Date().toISOString()}] daemon-connection: ${message}`);
		} catch {
			// Diagnostics must never become the failure they are describing.
		}
	}

	private async requestOk(command: DaemonCommandBody): Promise<void> {
		await this.requestData<unknown>(command);
	}

	private async requestData<T>(
		command: DaemonCommandBody,
		timeoutMs?: number,
		options?: Parameters<DaemonTransportClient["request"]>[2],
	): Promise<T> {
		const response = await this.client.request(command, timeoutMs, options);
		if (!response.success) {
			const error = deserializeDaemonError(response);
			this.definitiveRequestErrors.add(error);
			throw error;
		}
		if (invalidatesCachedSnapshot(command.type)) {
			this.latestSnapshotIsFresh = false;
		}
		return response.data as T;
	}

	private async handleDaemonMessage(message: DaemonOutbound): Promise<void> {
		if (message.type === "heartbeats_changed") {
			await this.emit({ type: "heartbeats_changed" });
			return;
		}
		if (!this.isMessageForActiveSession(message)) {
			return;
		}
		if ("snapshotId" in message && this.ignoredSnapshotIds.has(message.snapshotId)) {
			if (message.type === "session_snapshot_end" || message.type === "session_snapshot_failed") {
				this.ignoredSnapshotIds.delete(message.snapshotId);
			}
			return;
		}
		if (message.type === "session_snapshot_begin") {
			const assembly = this.getSnapshotAssembly(message.snapshotId);
			assembly.begin = message;
			return;
		}
		if (message.type === "session_snapshot_chunk") {
			this.getSnapshotAssembly(message.snapshotId).chunks.set(message.index, message.messages);
			return;
		}
		if (message.type === "session_snapshot_end") {
			await this.completeSnapshotAssembly(message);
			return;
		}
		if (message.type === "session_snapshot_failed") {
			const assembly = this.getSnapshotAssembly(message.snapshotId);
			// A failure with no begin frame (the supervisor gave up retrying a
			// catch-up) carries its own purpose; without it a client could not tell
			// that it must re-pull the session.
			const purpose = assembly.begin?.purpose ?? message.purpose ?? "attach";
			const snapshotError = new Error(message.error);
			const recoveryPromise =
				purpose === "replacement" || purpose === "resync"
					? this.recoverFailedSnapshot(purpose, snapshotError)
					: undefined;
			if (recoveryPromise) {
				this.snapshotRecoveryPromises.set(message.snapshotId, recoveryPromise);
			}
			this.rejectSnapshotAssembly(message.snapshotId, assembly, snapshotError);
			this.ignoreSnapshotId(message.snapshotId);
			if (recoveryPromise) {
				try {
					await recoveryPromise;
				} finally {
					this.snapshotRecoveryPromises.delete(message.snapshotId);
				}
			}
			return;
		}
		if (this.isStaleSequencedMessage(message)) {
			return;
		}
		this.observeEventSequenceGap(message);
		this.observeDaemonEventSequence(message);

		if (message.type === "assistant_stream_delta") {
			const reconstructed = this.streamReconstructor.reconstruct(message);
			// An unreconstructable delta means the seed was missed (attach raced
			// the stream). Drop the delta but actively re-fetch state; without a
			// resync the live stream would stay frozen until message_end.
			if (
				!reconstructed ||
				reconstructed.type !== "session_event" ||
				reconstructed.event.type !== "message_update"
			) {
				this.requestStreamResync();
				return;
			}
			// The reconstructor mutates one partial message in place; hand every
			// observer an independent snapshot, matching the old serialized wire
			// behavior where each update was a distinct object.
			// reconstruct() only rebuilds assistant streaming messages, but the
			// wire type is the wider AgentMessage union; narrow before cloning.
			const accumulated = reconstructed.event.message as AssistantMessage;
			const event = {
				...reconstructed.event,
				message: { ...accumulated, content: accumulated.content.map((block) => ({ ...block })) },
			};
			this.observeStreamingMessage(event);
			this.latestSnapshotIsFresh = false;
			await this.emit({ type: "session_event", event });
			return;
		}
		this.streamReconstructor.observe(message);

		if (message.type === "session_event") {
			// Child snapshots cross the capability gate before anything observes or
			// re-emits them, so the roster cache and the UI see the same downgrade.
			const sessionEvent =
				message.event.type === "rlm_child_update"
					? { ...message.event, child: this.downgradeChildStallState(message.event.child) }
					: message.event;
			if (
				sessionEvent.type !== "refine_complete" &&
				sessionEvent.type !== "refine_failed" &&
				sessionEvent.type !== "session_persist_failed"
			) {
				this.observeStreamingMessage(sessionEvent);
			}
			if (sessionEvent.type === "rlm_child_update") {
				this.childRosterSequence = maxEventSequence(this.childRosterSequence, getDaemonMessageSequence(message));
				this.observeRlmChildUpdate(sessionEvent.child);
			}
			this.latestSnapshotIsFresh = false;
			await this.emit({ type: "session_event", event: sessionEvent });
			return;
		}
		if (message.type === "side_question_event") {
			this.observeSideQuestionEvent(message.event);
			await this.emit({ type: "side_question_event", event: message.event });
			return;
		}
		if (message.type === "session_status") {
			// Keep a cached snapshot's recap current so a later re-attach seeds it.
			if (this.latestSnapshot) {
				this.latestSnapshot = {
					...this.latestSnapshot,
					state: { ...this.latestSnapshot.state, recap: message.recap },
				};
			}
			await this.emit({ type: "session_status", recap: message.recap });
			return;
		}
		if (message.type === "session_resynced") {
			this.resetEventGapBaseline();
			this.attachedSessionId = message.snapshot.state.sessionId;
			this.attachedSessionFile = message.snapshot.state.sessionFile;
			this.latestSnapshot = this.downgradeSnapshotStallState(mapDaemonSessionSnapshot(message.snapshot));
			if (Array.isArray(message.snapshot.children)) {
				this.childRosterSequence = message.snapshot.lastEventSequence;
			}
			if (this.lastEventSequence !== undefined) {
				this.latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			if (this.lastEventCursor) {
				this.latestSnapshot.lastEventCursor = this.lastEventCursor;
			}
			this.reseedStreamReconstructor();
			this.latestSnapshotIsFresh = true;
			await this.emit({ type: "session_resynced", snapshot: this.latestSnapshot });
			return;
		}
		if (message.type === "session_replaced") {
			this.attachedSessionId = message.state.sessionId;
			this.attachedSessionFile = message.state.sessionFile;
			if (message.snapshotFollows) {
				this.latestSnapshotIsFresh = false;
				return;
			}
			const latestSnapshot: AgentConnectionSnapshot = {
				state: message.state,
				messages: message.messages,
			};
			if (this.lastEventSequence !== undefined) {
				latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			if (this.lastEventCursor) {
				latestSnapshot.lastEventCursor = this.lastEventCursor;
			}
			this.latestSnapshot = latestSnapshot;
			this.reseedStreamReconstructor();
			this.childRosterSequence = undefined;
			this.latestSnapshotIsFresh = true;
			await this.emit({ type: "session_replaced", state: message.state, messages: message.messages });
			return;
		}
		if (message.type === "extension_ui_request") {
			await this.emit({
				type: "extension_ui_request",
				request: {
					id: message.id,
					method: message.method,
					payload: message.payload,
				},
			});
			return;
		}
		if (message.type === "extension_error") {
			await this.emit({
				type: "extension_error",
				extensionPath: message.extensionPath,
				event: message.event,
				error: message.error,
			});
			return;
		}
		if (message.type === "session_closed") {
			if (message.reason === "update") {
				this.captureDaemonLogPath();
				this.updateRestartPending = true;
				void this.reconnectAfterUpdate();
				return;
			}
			this.terminalCloseEmitted = true;
			await this.emit({ type: "closed", error: this.formatDaemonSessionClosedError(message.reason) });
		}
	}

	private captureDaemonLogPath(): void {
		const socketPath = this.client.hello?.socketPath;
		if (socketPath) {
			this.daemonLogPath = getDaemonLogPath(socketPath);
		}
	}

	private formatDaemonSessionClosedError(reason: DaemonSessionClosedReason): string {
		const explanation: Record<DaemonSessionClosedReason, string> = {
			killed:
				"The daemon stopped this agent session. Its transcript remains saved and can be reopened from Agents View.",
			shutdown:
				"The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
			completed:
				"The daemon closed this agent session after it completed. Its transcript remains available from Agents View.",
			replaced:
				"The daemon replaced this agent session with another session. Reopen the current session from Agents View.",
			update:
				"The Prime Agent daemon restarted for an update, but this window did not restore automatically. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
		};
		return `${explanation[reason]} ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatDaemonConnectionClosedError(error: Error): string {
		return `Lost connection to the Prime Agent daemon. Cause: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent or reopen the session from Agents View. ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatUpdateReconnectError(error: unknown): string {
		return `The Prime Agent daemon restarted for an update, but this window could not reconnect to its restored session before the recovery timeout expired. Last error: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent and reopen it from Agents View. ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatDaemonDiagnosticContext(): string {
		const details: string[] = [];
		if (this.attachedSessionId) {
			details.push(`Session ID: ${this.attachedSessionId}.`);
		}
		if (this.attachedSessionFile) {
			details.push(`Session file: ${this.attachedSessionFile}.`);
		}
		details.push(`Diagnostic log: ${this.daemonLogPath ?? getAgentLogPath()}.`);
		return details.join(" ");
	}

	private reconnectAfterUpdate(): Promise<void> {
		if (this.updateReconnectPromise) {
			return this.updateReconnectPromise;
		}
		void this.emit({
			type: "connection_status",
			status: "reconnecting",
			error: "The Prime Agent daemon is restarting for an update.",
		});
		const reconnectPromise = reconnectDaemonTransportAfterUpdate(this.client)
			.then(() => this.restoreConnectionAfterUpdate())
			.then(() => {
				if (!this.disposed) {
					void this.emit({ type: "connection_status", status: "connected" });
				}
			})
			.catch(async (error: unknown) => {
				this.updateRestartPending = false;
				this.updateReconnectFailed = true;
				if (!this.disposed) {
					this.terminalCloseEmitted = true;
					await this.emit({
						type: "closed",
						error: this.formatUpdateReconnectError(error),
					});
				}
			})
			.finally(() => {
				if (this.updateReconnectPromise === reconnectPromise) {
					this.updateReconnectPromise = undefined;
				}
			});
		this.updateReconnectPromise = reconnectPromise;
		return reconnectPromise;
	}

	private async restoreConnectionAfterUpdate(): Promise<void> {
		const sessionId = this.attachedSessionId;
		const sessionFile = this.attachedSessionFile;
		if (!sessionId && !sessionFile) {
			throw new Error("the previous session identity is unavailable");
		}
		const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
		let lastError: unknown;
		while (!this.disposed && Date.now() < deadline) {
			try {
				await this.client.reconnect(1000);
				if (this.disposed) {
					return;
				}
				// This loop owns the retry: a socket close must reject these instead of parking them behind a hello it can never produce.
				const response = await this.client.request({ type: "list" }, 30000, { recoverable: false });
				if (this.disposed) {
					return;
				}
				if (!response.success) {
					throw deserializeDaemonError(response);
				}
				const sessions = readSessionSummaries(response.data);
				const restored = sessions.find(
					(summary) =>
						summary.activeSessionId !== undefined &&
						((sessionFile !== undefined && summary.sessionFile === sessionFile) ||
							(sessionId !== undefined && summary.sessionId === sessionId)),
				);
				if (restored?.activeSessionId) {
					if (this.disposed) {
						return;
					}
					this.activeSessionId = restored.activeSessionId;
					this.lastEventSequence = undefined;
					this.lastEventCursor = undefined;
					this.retiredEventGenerations.clear();
					this.resetEventGapBaseline();
					await this.attach({ recoverable: false });
					if (this.disposed) {
						return;
					}
					const snapshot = await this.getInitialSnapshot({ recoverable: false });
					if (this.disposed) {
						return;
					}
					this.updateRestartPending = false;
					void this.emit({ type: "session_resynced", snapshot });
					return;
				}
			} catch (error) {
				lastError = error;
			}
			await delay(UPDATE_RECONNECT_RETRY_MS);
		}
		if (this.disposed) {
			return;
		}
		throw lastError ?? new Error("the restored session did not become available");
	}

	private getSnapshotAssembly(snapshotId: string): DaemonSnapshotAssembly {
		const existing = this.snapshotAssemblies.get(snapshotId);
		if (existing) {
			return existing;
		}
		let resolveSnapshot!: (snapshot: DaemonSessionSnapshot) => void;
		let rejectSnapshot!: (error: Error) => void;
		const promise = new Promise<DaemonSessionSnapshot>((resolve, reject) => {
			resolveSnapshot = resolve;
			rejectSnapshot = reject;
		});
		void promise.catch(() => undefined);
		const timeout = setTimeout(() => {
			const current = this.snapshotAssemblies.get(snapshotId);
			if (current) {
				current.reject(new Error(`Timed out waiting for snapshot ${snapshotId}`));
				this.snapshotAssemblies.delete(snapshotId);
				this.ignoreSnapshotId(snapshotId);
			}
		}, this.options.snapshotTimeoutMs ?? DAEMON_SNAPSHOT_TIMEOUT_MS);
		timeout.unref();
		const assembly: DaemonSnapshotAssembly = {
			chunks: new Map(),
			promise,
			resolve: resolveSnapshot,
			reject: rejectSnapshot,
			timeout,
		};
		this.snapshotAssemblies.set(snapshotId, assembly);
		return assembly;
	}

	private rejectSnapshotAssemblies(error: Error): void {
		for (const assembly of this.snapshotAssemblies.values()) {
			clearTimeout(assembly.timeout);
			assembly.reject(error);
		}
		this.snapshotAssemblies.clear();
		this.completedSnapshots.clear();
		this.snapshotRecoveryPromises.clear();
		this.ignoredSnapshotIds.clear();
	}

	private ignoreSnapshotId(snapshotId: string): void {
		this.ignoredSnapshotIds.add(snapshotId);
		while (this.ignoredSnapshotIds.size > MAX_IGNORED_SNAPSHOT_IDS) {
			const oldest = this.ignoredSnapshotIds.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.ignoredSnapshotIds.delete(oldest);
		}
	}

	private rejectSnapshotAssembly(snapshotId: string, assembly: DaemonSnapshotAssembly, error: Error): void {
		assembly.reject(error);
		clearTimeout(assembly.timeout);
		if (assembly.begin?.purpose && assembly.begin.purpose !== "attach") {
			this.snapshotAssemblies.delete(snapshotId);
		}
	}

	private async recoverFailedSnapshot(purpose: "replacement" | "resync", snapshotError: Error): Promise<void> {
		this.latestSnapshotIsFresh = false;
		if (purpose === "replacement") {
			this.latestSnapshot = undefined;
		}
		const retryDelays = this.options.snapshotRecoveryRetryDelaysMs ?? SNAPSHOT_RECOVERY_RETRY_DELAYS_MS;
		let recoveryError: unknown;
		for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
			if (attempt > 0) {
				const retryDelayMs = retryDelays[attempt - 1] ?? 0;
				// Degrade visibly but stay connected: the previous (now stale) view
				// stays on screen while the full re-pull is retried. A single failed
				// re-pull must not be enough to drop an unattended session offline.
				await this.emit({
					type: "connection_status",
					status: "reconnecting",
					error: `Daemon snapshot recovery failed; retrying in ${retryDelayMs}ms. Recovery error: ${formatErrorSentence(recoveryError)}`,
				});
				await delay(retryDelayMs);
				if (this.disposed) {
					return;
				}
			}
			try {
				const snapshot = await this.getInitialSnapshot();
				if (this.disposed) {
					return;
				}
				this.resetEventGapBaseline();
				this.attachedSessionId = snapshot.state.sessionId;
				this.attachedSessionFile = snapshot.state.sessionFile;
				if (purpose === "replacement") {
					await this.emit({ type: "session_replaced", state: snapshot.state, messages: snapshot.messages });
				} else {
					await this.emit({ type: "session_resynced", snapshot });
				}
				if (attempt > 0) {
					await this.emit({ type: "connection_status", status: "connected" });
				}
				return;
			} catch (error) {
				recoveryError = error;
			}
		}
		if (this.disposed) {
			return;
		}
		this.terminalCloseEmitted = true;
		await this.emit({
			type: "closed",
			error: `Failed to recover from a ${purpose} snapshot transfer after ${retryDelays.length + 1} attempts. Snapshot error: ${formatErrorSentence(snapshotError)} Recovery error: ${formatErrorSentence(recoveryError)} ${this.formatDaemonDiagnosticContext()}`,
		});
	}

	private async waitForSnapshot(snapshotId: string): Promise<DaemonSessionSnapshot> {
		const completed = this.completedSnapshots.get(snapshotId);
		if (completed) {
			this.completedSnapshots.delete(snapshotId);
			return completed;
		}
		const assembly = this.getSnapshotAssembly(snapshotId);
		try {
			return await assembly.promise;
		} finally {
			clearTimeout(assembly.timeout);
			this.snapshotAssemblies.delete(snapshotId);
			this.completedSnapshots.delete(snapshotId);
		}
	}

	private applyReplacementSnapshot(snapshot: DaemonSessionSnapshot, replay?: DaemonReplayInfo): void {
		this.resetEventGapBaseline();
		if (snapshot.lastEventCursor) {
			this.observeEventCursor(snapshot.lastEventCursor);
		}
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, snapshot.lastEventSequence);
		this.attachedSessionId = snapshot.state.sessionId;
		this.attachedSessionFile = snapshot.state.sessionFile;
		this.latestSnapshot = this.downgradeSnapshotStallState(mapDaemonSessionSnapshot(snapshot, replay));
		this.childRosterSequence = Array.isArray(snapshot.children) ? snapshot.lastEventSequence : undefined;
		this.reseedStreamReconstructor();
		this.latestSnapshotIsFresh = true;
	}

	private async completeSnapshotAssembly(
		message: Extract<DaemonOutbound, { type: "session_snapshot_end" }>,
	): Promise<void> {
		const assembly = this.getSnapshotAssembly(message.snapshotId);
		if (!assembly.begin) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(`Snapshot ${message.snapshotId} ended before it began`),
			);
			return;
		}
		if (assembly.chunks.size !== message.chunkCount) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(
					`Snapshot ${message.snapshotId} ended with ${assembly.chunks.size} of ${message.chunkCount} chunks`,
				),
			);
			return;
		}
		const messages: AgentMessage[] = [];
		for (let index = 0; index < message.chunkCount; index++) {
			const chunk = assembly.chunks.get(index);
			if (!chunk) {
				this.rejectSnapshotAssembly(
					message.snapshotId,
					assembly,
					new Error(`Snapshot ${message.snapshotId} is missing chunk ${index}`),
				);
				return;
			}
			messages.push(...chunk);
		}
		if (messages.length !== assembly.begin.messageCount) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(
					`Snapshot ${message.snapshotId} contained ${messages.length} of ${assembly.begin.messageCount} messages`,
				),
			);
			return;
		}
		const snapshot: DaemonSessionSnapshot = {
			...assembly.begin.snapshot,
			messages,
			lastEventSequence: message.lastEventSequence,
			lastEventCursor: message.lastEventCursor,
		};
		if (message.lastEventCursor) {
			this.observeEventCursor(message.lastEventCursor);
		}
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, message.lastEventSequence);
		this.attachedSessionId = snapshot.state.sessionId;
		this.attachedSessionFile = snapshot.state.sessionFile;
		this.latestSnapshot = this.downgradeSnapshotStallState(mapDaemonSessionSnapshot(snapshot));
		this.reseedStreamReconstructor();
		this.latestSnapshotIsFresh = true;
		assembly.resolve(snapshot);
		const purpose = assembly.begin.purpose ?? "attach";
		clearTimeout(assembly.timeout);
		if (purpose !== "attach") {
			this.snapshotAssemblies.delete(message.snapshotId);
			if (this.pendingReattachActiveSessionIds.has(message.activeSessionId)) {
				this.completedSnapshots.set(message.snapshotId, snapshot);
				while (this.completedSnapshots.size > MAX_COMPLETED_SNAPSHOTS) {
					const oldest = this.completedSnapshots.keys().next().value;
					if (oldest === undefined) {
						break;
					}
					this.completedSnapshots.delete(oldest);
				}
			}
		}
		if (purpose === "replacement") {
			await this.emit({ type: "session_replaced", state: snapshot.state, messages });
		} else if (purpose === "resync") {
			await this.emit({ type: "session_resynced", snapshot: this.latestSnapshot });
		}
	}

	private observeRlmChildUpdate(child: AgentConnectionRlmChildAgentSnapshot): void {
		if (!this.latestSnapshot) return;
		const children = this.latestSnapshot.children ?? [];
		const index = children.findIndex((candidate) => candidate.id === child.id);
		const updatedChildren = [...children];
		if (index === -1) {
			updatedChildren.push(child);
		} else {
			updatedChildren[index] = child;
		}
		this.latestSnapshot = { ...this.latestSnapshot, children: updatedChildren };
	}

	// The wire union's stall family may lack `diagnostics` (a daemon from before the
	// payload), so this takes the core union plus the wire union instead of erasing the
	// difference with a cast.
	private observeStreamingMessage(event: AgentSessionEvent | AgentConnectionSessionEvent): void {
		if (!this.latestSnapshot) {
			return;
		}
		if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
			this.latestSnapshot = { ...this.latestSnapshot, streamingMessage: event.message };
			return;
		}
		if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "agent_end") {
			const { streamingMessage: _streamingMessage, ...snapshot } = this.latestSnapshot;
			this.latestSnapshot = snapshot;
		}
	}

	/**
	 * Reseed the delta reconstructor after a snapshot replaced the streaming
	 * state: a snapshot carrying a streamingMessage becomes the accumulation
	 * seed, otherwise any stale partial state is dropped.
	 */
	private reseedStreamReconstructor(): void {
		const streamingMessage = this.latestSnapshot?.streamingMessage;
		if (streamingMessage && streamingMessage.role === "assistant") {
			this.streamReconstructor.seed(this.activeSessionId, streamingMessage);
			return;
		}
		this.streamReconstructor.clear(this.activeSessionId);
	}

	/**
	 * Self-requested catch-up for a delta that arrived without a seed. Refetches
	 * state and re-emits a resync (same recovery used for failed snapshot
	 * transfers), then reseeds the reconstructor from the refreshed snapshot. A
	 * stale carried-over streaming message is dropped unless the session is
	 * still streaming: while streaming it is the closest available seed (each
	 * block end replaces the full content anyway), otherwise it predates the
	 * desync and would corrupt later deltas.
	 */
	private requestStreamResync(): void {
		if (this.disposed || this.streamResyncInFlight) return;
		this.streamResyncInFlight = (async () => {
			try {
				await this.recoverFailedSnapshot("resync", new Error("Assistant stream delta arrived without a seed"));
				if (this.disposed) return;
				const snapshot = this.latestSnapshot;
				if (snapshot && !snapshot.state.isStreaming && snapshot.streamingMessage) {
					const { streamingMessage: _staleSeed, ...rest } = snapshot;
					this.latestSnapshot = rest;
				}
				this.reseedStreamReconstructor();
			} catch {
				// recoverFailedSnapshot emits the terminal close on failure.
			} finally {
				this.streamResyncInFlight = undefined;
			}
		})();
	}

	private isMessageForActiveSession(message: DaemonOutbound): boolean {
		if (!("activeSessionId" in message)) {
			return false;
		}
		return message.activeSessionId === this.activeSessionId;
	}

	private isStaleSequencedMessage(message: DaemonOutbound): boolean {
		const cursor = getDaemonMessageCursor(message);
		if (cursor) {
			if (this.retiredEventGenerations.has(cursor.generation)) {
				return true;
			}
			return (
				this.lastEventCursor?.generation === cursor.generation && cursor.sequence <= this.lastEventCursor.sequence
			);
		}
		const sequence = getDaemonMessageSequence(message);
		return sequence !== undefined && this.lastEventSequence !== undefined && sequence <= this.lastEventSequence;
	}

	/**
	 * P0-5c: detects a hole in one event generation's sequence. Log-only by default
	 * (C11) — the count and the log line are evidence for the switch to "recover",
	 * which is gated on a window without false positives. Four rules keep it quiet:
	 * the first frame after a reseed only re-arms the baseline, a generation change
	 * only re-baselines, a frame without a cursor is skipped, and reports are
	 * single-flighted and throttled.
	 */
	private observeEventSequenceGap(message: DaemonOutbound): void {
		const cursor = getDaemonMessageCursor(message);
		if (!cursor) {
			return;
		}
		const baseline = this.eventGapBaseline;
		this.eventGapBaseline = cursor;
		if (!this.eventGapArmed) {
			this.eventGapArmed = true;
			return;
		}
		if (!baseline || baseline.generation !== cursor.generation) {
			return;
		}
		if (cursor.sequence <= baseline.sequence + 1) {
			return;
		}
		this.reportEventGap(baseline.sequence + 1, cursor.sequence, cursor.generation);
	}

	/** A reseed (attach, resync, replacement, reconnect) is a new baseline, never a gap. */
	private resetEventGapBaseline(): void {
		this.eventGapArmed = false;
		this.eventGapBaseline = undefined;
		this.eventGapInFlight = false;
	}

	private eventGapRecoveryMode(): "log" | "recover" {
		return this.options.eventGapRecovery ?? configuredEventGapRecoveryMode();
	}

	/** Gap-detector evidence for tests and diagnostics; no private state to probe. */
	get eventGapDiagnostics(): {
		mode: "log" | "recover";
		detected: number;
		suppressed: number;
		lastExpected: number | undefined;
		lastGot: number | undefined;
		recoveryInFlight: boolean;
		/** Configured mode, which the breaker overrides to log-only once it opens. */
		configuredMode: "log" | "recover";
		breakerOpen: boolean;
		breakerReason: string | undefined;
		recoveryStreak: number;
		/** Gap re-pulls inside the breaker's sliding window. */
		recoveryInWindow: number;
	} {
		return {
			mode: this.eventGapBreakerOpen ? "log" : this.eventGapRecoveryMode(),
			configuredMode: this.eventGapRecoveryMode(),
			detected: this.eventGapDetected,
			suppressed: this.eventGapSuppressed,
			lastExpected: this.eventGapLastExpected,
			lastGot: this.eventGapLastGot,
			recoveryInFlight: this.eventGapInFlight,
			breakerOpen: this.eventGapBreakerOpen,
			breakerReason: this.eventGapBreakerReason,
			recoveryStreak: this.eventGapRecoveryStreak,
			recoveryInWindow: this.eventGapRecoveryTimestamps.length,
		};
	}

	private reportEventGap(expected: number, got: number, generation: string): void {
		this.eventGapDetected++;
		this.eventGapLastExpected = expected;
		this.eventGapLastGot = got;
		const detail = `event gap detected for ${this.activeSessionId}: expected sequence ${expected}, got ${got} (generation ${generation})`;
		if (this.eventGapRecoveryMode() === "recover" && !this.eventGapBreakerOpen) {
			// Single flight: one hole triggers one re-pull, not one per later frame.
			if (this.eventGapInFlight || this.disposed) {
				return;
			}
			this.eventGapInFlight = true;
			const streak = this.beginEventGapRecovery();
			this.appendEventGapLog(`${detail}; re-pulling the session (streak ${streak})`);
			// The catch is not optional: a rejection here would be an unhandled one,
			// which is exactly what the supervisor's crash handlers exist to isolate.
			void this.recoverFailedSnapshot("resync", new Error(detail))
				.catch((error: unknown) => {
					this.appendEventGapLog(
						`${detail}; re-pull failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => {
					this.eventGapInFlight = false;
				});
			this.tripEventGapRecoveryBreaker(detail);
			return;
		}
		const now = Date.now();
		if (this.eventGapLastReportAt !== undefined && now - this.eventGapLastReportAt < EVENT_GAP_LOG_THROTTLE_MS) {
			this.eventGapSuppressed++;
			return;
		}
		const suppressed = this.eventGapSuppressed;
		this.eventGapSuppressed = 0;
		this.eventGapLastReportAt = now;
		const breaker = this.eventGapBreakerOpen ? `; recovery circuit open (${this.eventGapBreakerReason})` : "";
		this.appendEventGapLog(
			`${detail}; log-only, no recovery attempted${breaker}${
				suppressed > 0 ? ` (+${suppressed} suppressed in the last ${EVENT_GAP_LOG_THROTTLE_MS}ms)` : ""
			}`,
		);
	}

	/**
	 * Counts one gap-triggered re-pull against both breaker bounds and returns the
	 * streak length. A gap that arrives long after the previous one starts a new
	 * incident, so an occasional hole on a long-lived connection never accumulates
	 * into a streak.
	 */
	private beginEventGapRecovery(): number {
		const now = Date.now();
		if (
			this.eventGapLastRecoveryAt !== undefined &&
			now - this.eventGapLastRecoveryAt > EVENT_GAP_RECOVERY_STREAK_RESET_MS
		) {
			this.eventGapRecoveryStreak = 0;
		}
		this.eventGapLastRecoveryAt = now;
		this.eventGapRecoveryStreak++;
		this.eventGapRecoveryTimestamps.push(now);
		while (
			this.eventGapRecoveryTimestamps.length > 0 &&
			now - (this.eventGapRecoveryTimestamps[0] ?? now) > EVENT_GAP_RECOVERY_WINDOW_MS
		) {
			this.eventGapRecoveryTimestamps.shift();
		}
		return this.eventGapRecoveryStreak;
	}

	/** F9: opens the breaker and drops this connection back to log-only, loudly. */
	private tripEventGapRecoveryBreaker(detail: string): void {
		if (this.eventGapBreakerOpen) {
			return;
		}
		const overStreak = this.eventGapRecoveryStreak >= EVENT_GAP_RECOVERY_STREAK_LIMIT;
		const overWindow = this.eventGapRecoveryTimestamps.length >= EVENT_GAP_RECOVERY_WINDOW_LIMIT;
		if (!overStreak && !overWindow) {
			return;
		}
		this.eventGapBreakerOpen = true;
		this.eventGapBreakerReason = overStreak
			? `${this.eventGapRecoveryStreak} consecutive gap re-pulls did not close the hole`
			: `${this.eventGapRecoveryTimestamps.length} gap re-pulls within ${EVENT_GAP_RECOVERY_WINDOW_MS}ms`;
		this.appendEventGapLog(
			`event gap recovery circuit OPEN for ${this.activeSessionId}: ${this.eventGapBreakerReason}; staying log-only until this connection is replaced (${detail})`,
		);
	}

	private appendEventGapLog(detail: string): void {
		try {
			appendRotatingLog(getAgentLogPath(), `[${new Date().toISOString()}] event-gap: ${detail}`);
		} catch {
			// A logging failure must not turn an observation into a connection failure.
		}
	}

	private observeDaemonEventSequence(message: DaemonOutbound): void {
		const cursor = getDaemonMessageCursor(message);
		if (cursor) {
			this.observeEventCursor(cursor);
			this.lastEventSequence = cursor.sequence;
			return;
		}
		const sequence = getDaemonMessageSequence(message);
		if (sequence === undefined) {
			return;
		}
		this.lastEventSequence =
			this.lastEventSequence === undefined ? sequence : Math.max(this.lastEventSequence, sequence);
		if (this.lastEventCursor) {
			this.lastEventCursor = {
				...this.lastEventCursor,
				sequence: Math.max(this.lastEventCursor.sequence, sequence),
			};
		}
	}

	private observeEventCursor(cursor: DaemonEventCursor): void {
		const current = this.lastEventCursor;
		if (current && current.generation !== cursor.generation) {
			this.retiredEventGenerations.add(current.generation);
		}
		if (!current || current.generation !== cursor.generation || cursor.sequence > current.sequence) {
			this.lastEventCursor = cursor;
		}
	}

	private async emit(event: AgentConnectionEvent): Promise<void> {
		const deliveries: Promise<void>[] = [];
		for (const listener of [...this.listeners]) {
			try {
				deliveries.push(Promise.resolve(listener(event)));
			} catch {
				// One attachment must not interrupt delivery or transport recovery for the others.
			}
		}
		await Promise.allSettled(deliveries);
	}

	private observeSideQuestionEvent(event: AgentConnectionSideQuestionEvent): void {
		if (event.status !== "running") {
			this.activeSideQuestionIds.delete(event.id);
		}
	}
}

function readSessionSummaries(value: unknown): SessionSummary[] {
	if (!value || typeof value !== "object" || !Array.isArray((value as { sessions?: unknown }).sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	return (value as { sessions: SessionSummary[] }).sessions;
}

function getAttachActiveSessionId(result: SessionSummary | DaemonAttachResult): string {
	if ("snapshot" in result) {
		return result.activeSessionId;
	}
	return result.activeSessionId ?? result.id;
}

function getAttachLastEventSequence(result: SessionSummary | DaemonAttachResult): number | undefined {
	if ("lastEventSequence" in result) {
		return result.lastEventSequence;
	}
	return undefined;
}

function getAttachLastEventCursor(result: SessionSummary | DaemonAttachResult): DaemonEventCursor | undefined {
	if ("lastEventCursor" in result) {
		return result.lastEventCursor;
	}
	return undefined;
}

function maxEventSequence(current: number | undefined, observed: number | undefined): number | undefined {
	if (current === undefined) {
		return observed;
	}
	if (observed === undefined) {
		return current;
	}
	return Math.max(current, observed);
}

function mapDaemonSessionSnapshot(snapshot: DaemonSessionSnapshot, replay?: DaemonReplayInfo): AgentConnectionSnapshot {
	const connectionSnapshot: AgentConnectionSnapshot = {
		state: snapshot.state,
		messages: snapshot.messages,
		...(snapshot.summary.streamingMessage ? { streamingMessage: snapshot.summary.streamingMessage } : {}),
		lastEventSequence: snapshot.lastEventSequence,
		lastEventCursor: snapshot.lastEventCursor,
	};
	if (snapshot.sessionContext) {
		connectionSnapshot.sessionContext = snapshot.sessionContext;
	}
	if (snapshot.sessionTree) {
		connectionSnapshot.sessionTree = snapshot.sessionTree;
	}
	if (snapshot.parent) {
		connectionSnapshot.parent = snapshot.parent;
	}
	if (snapshot.children) {
		connectionSnapshot.children = snapshot.children;
	}
	if (replay) {
		connectionSnapshot.replay = replay;
	}
	return connectionSnapshot;
}

function getDaemonMessageSequence(message: DaemonOutbound): number | undefined {
	if (!("meta" in message)) {
		return undefined;
	}
	return message.meta?.sequence;
}

function getDaemonMessageCursor(message: DaemonOutbound): DaemonEventCursor | undefined {
	if (!("meta" in message)) {
		return undefined;
	}
	return message.meta?.cursor;
}

function invalidatesCachedSnapshot(commandType: DaemonCommandBody["type"]): boolean {
	switch (commandType) {
		case "attach":
		case "reattach":
		case "detach":
		case "list":
		case "list_saved_sessions":
		case "wait_for_idle":
		case "get_state":
		case "get_connection_state":
		case "get_messages":
		case "get_session_stats":
		case "get_commands":
		case "get_resource_snapshot":
		case "get_model_catalog":
		case "get_available_models":
		case "get_queue":
		case "cron_list":
		case "heartbeats_list":
		case "get_session_context":
		case "get_session_tree":
		case "get_user_messages_for_forking":
		case "get_last_assistant_text":
		case "get_system_prompt":
		case "get_tool_definition":
		case "start_side_question":
		case "abort_side_question":
		case "export_html":
		case "export_jsonl":
			return false;
		default:
			return true;
	}
}
