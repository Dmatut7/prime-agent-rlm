import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import {
	AgentsViewMode,
	type AgentsViewPersistentState,
	buildAgentsViewUsageLayout,
	combineAgentsViewStartupNotices,
	createInitialAgentsViewPersistentState,
	resolvePendingChildOpenSummary,
	runAgentsViewMode,
	waitThroughDaemonUpdateRestart,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
} from "../src/modes/agents-view/agents-view-state.js";
import { type AgentsViewRosterStore, STALE_ROSTER_DAEMON_MESSAGE } from "../src/modes/agents-view/roster-store.js";
import type { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DaemonSessionRecoveringError, DaemonUpdateRestartingError } from "../src/modes/daemon/daemon-errors.js";
import {
	DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
	type DaemonDeclaredCapability,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonControlPlaneTransportError } from "../src/modes/daemon/daemon-routed-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher, theme } from "../src/modes/interactive/theme/theme.js";

const modeMocks = vi.hoisted(() => ({
	interactiveRun: vi.fn<() => Promise<never>>(),
	teardownSessionUi: vi.fn(async () => undefined),
	dispose: vi.fn(async () => undefined),
	connectionPrompt: vi.fn(async () => undefined),
	clientRequest: vi.fn<() => Promise<unknown>>(),
	// vi.clearAllMocks() does not empty a plain array, so tests reset this themselves.
	clientConstructions: [] as { socketPath: string; declaredCapabilities?: readonly unknown[] }[],
}));

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();
	return { ...actual, appendRotatingLog: vi.fn() };
});

vi.mock("../src/modes/daemon/daemon-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/daemon/daemon-client.js")>();
	return {
		...actual,
		DaemonClient: class {
			constructor(socketPath: string, options?: { declaredCapabilities?: readonly DaemonDeclaredCapability[] }) {
				modeMocks.clientConstructions.push({ socketPath, declaredCapabilities: options?.declaredCapabilities });
			}
			connect = vi.fn(async () => undefined);
			close = vi.fn();
			request = modeMocks.clientRequest;
			isConnected = true;
			reconnect = vi.fn(async () => undefined);
			onMessage = vi.fn(() => () => {});
			onClose = vi.fn(() => () => {});
		},
		getDaemonSocketCloseReason: vi.fn(),
	};
});

vi.mock("../src/modes/agent-connection/daemon-agent-connection.js", () => ({
	DaemonAgentConnection: Object.assign(function DaemonAgentConnection() {}, {
		attach: vi.fn(async () => ({ prompt: modeMocks.connectionPrompt, dispose: modeMocks.dispose })),
	}),
}));

vi.mock("../src/modes/interactive/interactive-mode.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/interactive-mode.js")>();
	return {
		...actual,
		InteractiveMode: class {
			run = modeMocks.interactiveRun;
			teardownSessionUi = modeMocks.teardownSessionUi;
		},
	};
});

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "scope-active",
		activeSessionId: "scope-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "scope-session",
		sessionFile: "/tmp/scope.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

const settingsManager = {
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	getEditorPaddingX: () => 0,
	getAutocompleteMaxVisible: () => 5,
};

describe("AgentsViewMode", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));
	beforeEach(() => vi.clearAllMocks());

	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			savedSearchFetchStarted: true,
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
			armSavedSearchFetch(): void {
				invoke("armSavedSearchFetch", self);
			},
		};

		invoke("queryChanged", self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
	});

	it("loads the saved catalog on view entry without a search query", () => {
		const self = {
			savedSearchFetchStarted: false,
			persistentState: {},
			refreshSavedSessions: vi.fn(async () => true),
		};

		invoke("armSavedSearchFetch", self);

		expect(self.refreshSavedSessions).toHaveBeenCalledOnce();
		expect(self.savedSearchFetchStarted).toBe(true);
	});

	it("stops instead of deleting when an idle row's subtree still works", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		const idleWithBusyCrew = {
			kind: "subagent",
			section: "idle",
			runningSubagentCount: 1,
			summary: summary({ id: "crew-parent", activeSessionId: "crew-parent", sessionId: "crew-parent-session" }),
		};

		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "crew-parent-child" },
			idleWithBusyCrew,
		);

		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "crew-parent-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
	});

	it("re-resolves subagent state before choosing stop or delete intent", async () => {
		const child = summary({
			id: "passive-child-session",
			activeSessionId: undefined,
			sessionId: "passive-child-session",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const request = vi.fn(async (command: { type: string }) => ({
			success: true as const,
			data: command.type === "cancel_rlm_child" ? { cancelled: false } : { deleted: true },
		}));
		const client = { request, supportsServerCapability: vi.fn(() => true) };
		const self = {
			rows: [
				{
					kind: "subagent",
					section: "running",
					summary: child,
					selectable: true,
					identity: "child-row",
					parentIdentity: "root-row",
				},
				{
					kind: "agent",
					section: "idle",
					summary: summary({ id: "root-active", activeSessionId: "root-active", sessionId: "root-session" }),
					selectable: true,
					identity: "root-row",
				},
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			pendingKillSubagent: undefined,
			deleteConfirmExpiresAt: 0,
			deleteConfirmTimer: undefined,
			ui: { requestRender: vi.fn() },
			requireClient: () => client,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			handleKillSubagentSelected(row: unknown) {
				return invoke("handleKillSubagentSelected", self, row);
			},
			findSubagentRootRow(row: unknown) {
				return invoke("findSubagentRootRow", self, row);
			},
			isDeleteConfirmationVisible() {
				return invoke("isDeleteConfirmationVisible", self);
			},
			showDeleteConfirmation() {
				return invoke("showDeleteConfirmation", self);
			},
			clearDeleteConfirmation(options: unknown) {
				return invoke("clearDeleteConfirmation", self, options);
			},
			killSubagent(pending: unknown, row: unknown) {
				return invoke("killSubagent", self, pending, row);
			},
		};

		await invoke("handleDeleteSelected", self);
		expect(request).not.toHaveBeenCalled();

		// The child finishes during confirmation. The second keypress must use the
		// current row state rather than the original running state.
		self.rows[0]!.section = "inactive";
		await invoke("handleDeleteSelected", self);
		expect(request).toHaveBeenCalledWith({
			type: "delete_rlm_subagent",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_rlm_child" }));
		expect(self.setStatusMessage).toHaveBeenCalledWith("子代理已删除", { render: false });
	});

	it("uses cancel when an inactive subagent starts running during confirmation", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "running" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
	});

	it("falls back to cancel-only when subagent deletion is unsupported", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: false } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => false }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "inactive", runningSubagentCount: 0, summary: summary() },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(self.setStatusMessage).toHaveBeenCalledWith("后台服务不支持删除子代理，没有改动", {
			render: false,
			tone: "warning",
		});
	});

	it("checks telemetry policy before replying from an opted-out agents view", async () => {
		const client = { close: vi.fn() };
		const connectDedicatedClient = vi.fn(async () => client);
		const self = {
			options: {
				config: { telemetryDisabled: true },
				recoverDaemon: vi.fn(async () => undefined),
				reconnectTimeoutMs: 1234,
			},
			connectDedicatedClient,
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "followUp");

		expect(connectDedicatedClient).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(client, "active-1", {
			closeClientOnDispose: true,
			supportsExtensionUi: false,
			recoverDaemon: self.options.recoverDaemon,
			reconnectTimeoutMs: 1234,
			telemetryDisabled: true,
		});
		expect(modeMocks.connectionPrompt).toHaveBeenCalledWith("private prompt", {
			streamingBehavior: "followUp",
		});
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
	});

	it("keeps direct agents-view replies when telemetry is enabled", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: undefined }));
		const self = {
			options: { config: {} },
			requireClient: () => ({ request }),
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "steer");

		expect(request).toHaveBeenCalledWith({
			type: "prompt",
			activeSessionId: "active-1",
			message: "private prompt",
			streamingBehavior: "steer",
		});
		expect(DaemonAgentConnection.attach).not.toHaveBeenCalled();
	});

	it("uses the opened session as the crash-path back target", async () => {
		const opened = summary({ sessionName: "opened" });
		const previous = summary({ id: "previous", activeSessionId: "previous", sessionId: "previous" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockResolvedValueOnce({ type: "open", summary: opened })
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.backSession).toMatchObject({ sessionId: opened.sessionId });
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockRejectedValueOnce(new Error("post-attach crash"));

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp", telemetryDisabled: true } as never,
			initialSession: previous,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		expect(modeMocks.teardownSessionUi).toHaveBeenCalledWith({ preserveAltScreen: true });
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(
			expect.anything(),
			opened.activeSessionId,
			expect.objectContaining({ telemetryDisabled: true }),
		);
		runView.mockRestore();
	});

	it("invalidates the persisted scope root after popping a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [
					{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } },
					{ scope: { sessionId: child.sessionId, activeSessionId: child.activeSessionId } },
				];
				state.scopeRootSummary = child;
				return Promise.resolve({
					type: "scope_back",
					selection: child,
					expandedAncestorSessionIds: [],
					hasChildren: false,
				});
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(1);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});

		await runAgentsViewMode({
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("invalidates the persisted scope root after pushing a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } }];
				state.scopeRootSummary = parent;
				return Promise.resolve({ type: "open", summary: child });
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(2);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockResolvedValueOnce({
			type: "scoped_agents_view",
			source: {
				activeSessionId: child.activeSessionId,
				sessionFile: child.sessionFile,
				sessionId: child.sessionId,
				sessionName: child.sessionName,
				cwd: child.cwd,
			},
		} as never);

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("does not discard scope while the saved-session refresh is in flight", async () => {
		let finishRefresh: ((value: { success: true; data: { sessions: unknown[] } }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: { sessions: unknown[] } }>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		const scopeSummary = summary();
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: scopeSummary.sessionId, activeSessionId: scopeSummary.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			options: { config: { cwd: "/tmp" } },
			persistentState,
			savedCatalogGeneration: 0,
			savedCatalogReady: true,
			savedCatalogRefreshPending: false,
			lastSuccessfulSavedSessions: [],
			savedSessions: [],
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
			reconcileCatalogs: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
		};

		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		expect(self.savedCatalogReady).toBe(false);

		Object.assign(self, {
			lastListedSummaries: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			takeCatalogReconcileScope: () => invoke("takeCatalogReconcileScope", self),
		});
		self.reconcileCatalogs = () => invoke("reconcileCatalogs", self);
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeFrames).toHaveLength(1);

		const saved: AgentConnectionSavedSessionInfo = {
			path: "/tmp/scope.jsonl",
			id: "scope-session",
			cwd: "/tmp",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
			messageCount: 1,
			firstMessage: "scope",
			allMessagesText: "scope",
		};
		finishRefresh?.({
			success: true,
			data: {
				sessions: [
					{
						...saved,
						created: saved.created.toISOString(),
						modified: saved.modified.toISOString(),
					},
				],
			},
		});
		await expect(refresh).resolves.toBe(true);
		expect(persistentState.scopeFrames).toHaveLength(1);
	});

	it("coalesces the progressively streamed saved catalog into a bounded number of reconciles", async () => {
		vi.useFakeTimers();
		const total = 40;
		const wireSession = (index: number) => ({
			path: `/tmp/sessions/session-${index}.jsonl`,
			id: `session-${index}`,
			cwd: "/tmp",
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
			messageCount: 1,
			firstMessage: `first message ${index}`,
			allMessagesText: `first message ${index}`,
		});
		const request = vi.fn(
			async (
				_command: unknown,
				_timeout: unknown,
				callbacks?: { onProgress?: (update: unknown) => void },
			): Promise<{ success: true; data: { sessions: ReturnType<typeof wireSession>[] } }> => {
				for (let index = 0; index < total; index++) {
					callbacks?.onProgress?.({
						type: "session_list_item",
						command: "list_saved_sessions",
						id: "catalog",
						session: wireSession(index),
					});
				}
				return {
					success: true,
					data: { sessions: Array.from({ length: total }, (_, index) => wireSession(index)) },
				};
			},
		);
		let reconciles = 0;
		const self: Record<string, unknown> = {
			options: { config: { cwd: "/tmp" } },
			persistentState: {},
			reconnectPromise: undefined,
			daemonShutdownReceived: false,
			savedCatalogGeneration: 0,
			savedCatalogReady: true,
			savedCatalogRefreshPending: false,
			lastSuccessfulSavedSessions: [],
			savedSessions: [],
			heartbeats: [],
			lastListedSummaries: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			scopeKey: undefined,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			stopped: false,
			editor: { getText: () => "re:/tmp/sessions/session-3\\.jsonl" },
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
			setStatusMessage: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
			rearmSavedSearchFetch: vi.fn(),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			takeCatalogReconcileScope: () => invoke("takeCatalogReconcileScope", self),
			getFilteredRecords: () => invoke("getFilteredRecords", self),
		};
		self.reconcileCatalogs = () => {
			reconciles += 1;
			invoke("reconcileCatalogs", self);
		};
		self.scheduleCatalogReconcile = () => invoke("scheduleCatalogReconcile", self);

		try {
			await expect(invoke("refreshSavedSessions", self)).resolves.toBe(true);
			expect(request).toHaveBeenCalledOnce();
			expect((self.savedSessions as unknown[]).length).toBe(total);
			// One reconcile per streamed session would be quadratic in catalog size:
			// the burst may only cost a leading rebuild plus the settle.
			expect(reconciles).toBeGreaterThan(0);
			expect(reconciles).toBeLessThanOrEqual(3);
			// The settle already covered the burst, so the trailing flush is a no-op.
			vi.advanceTimersByTime(500);
			expect(reconciles).toBeLessThanOrEqual(3);
			// The regex query was parsed once and still filtered the reconciled rows.
			const rows = Reflect.get(self, "rows") as AgentsViewRow[];
			expect(rows.map((row) => row.summary.sessionId)).toEqual(["session-3"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes one coalesced reconcile per burst and none after teardown", () => {
		vi.useFakeTimers();
		const reconciledAt: number[] = [];
		const self: Record<string, unknown> = { stopped: false, resolveMissingSelectionAnchor: vi.fn() };
		// Stands in for the real reconcile's bookkeeping: it clears the dirty flag and
		// stamps the throttle window the scheduler measures against.
		self.reconcileCatalogs = () => {
			reconciledAt.push(Date.now());
			self.catalogReconcileDirty = false;
			self.lastCatalogReconcileAt = Date.now();
		};

		try {
			self.lastCatalogReconcileAt = Date.now();
			for (let index = 0; index < 25; index++) {
				invoke("scheduleCatalogReconcile", self);
			}
			expect(reconciledAt).toHaveLength(0);
			vi.advanceTimersByTime(50);
			expect(reconciledAt).toHaveLength(1);

			// A burst starting outside the window rebuilds at once, then coalesces again.
			vi.advanceTimersByTime(50);
			invoke("scheduleCatalogReconcile", self);
			expect(reconciledAt).toHaveLength(2);
			invoke("scheduleCatalogReconcile", self);
			vi.advanceTimersByTime(50);
			expect(reconciledAt).toHaveLength(3);

			// A stopped view never rebuilds from a scheduled flush.
			self.stopped = true;
			invoke("scheduleCatalogReconcile", self);
			vi.advanceTimersByTime(200);
			expect(reconciledAt).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps coalescing when a rebuild outlasts the throttle window", () => {
		vi.useFakeTimers();
		const rebuiltAt: number[] = [];
		const self: Record<string, unknown> = {
			persistentState: {},
			lastListedSummaries: [],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			savedCatalogReady: true,
			scopeKey: undefined,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			stopped: false,
			lastCatalogReconcileAt: 0,
			editor: { getText: () => "" },
			setStatusMessage: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			takeCatalogReconcileScope: () => invoke("takeCatalogReconcileScope", self),
			getFilteredRecords: () => invoke("getFilteredRecords", self),
			// Stands in for a large catalog: the rebuild takes longer than the throttle window.
			ui: {
				requestRender: () => {
					rebuiltAt.push(Date.now());
					vi.advanceTimersByTime(200);
				},
			},
		};
		self.reconcileCatalogs = () => invoke("reconcileCatalogs", self);

		try {
			for (let index = 0; index < 10; index++) {
				invoke("scheduleCatalogReconcile", self);
			}
			vi.advanceTimersByTime(500);
			// The burst costs a leading rebuild plus one trailing flush; a window stamped
			// at the rebuild's start would rebuild once per streamed session.
			expect(rebuiltAt.length).toBeGreaterThan(0);
			expect(rebuiltAt.length).toBeLessThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries the resolved scope root across view remounts", () => {
		const root = summary({ sessionName: "Scoped root" });
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			persistentState,
			lastListedSummaries: [root],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			savedCatalogReady: true,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			takeCatalogReconcileScope: () => invoke("takeCatalogReconcileScope", self),
		};
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeRootSummary).toMatchObject({ sessionId: root.sessionId });

		const remount = new AgentsViewMode(
			{
				config: { cwd: "/tmp" } as never,
				uiServices: {
					settingsManager: settingsManager as never,
					modelRegistry: {} as never,
					getInitialCwd: () => "/tmp",
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			persistentState,
		) as AgentsViewMode & Record<string, unknown>;
		const remountedRoot = Reflect.get(remount, "scopeRootSummary") as SessionSummary;
		expect(remountedRoot).toMatchObject({ sessionName: "Scoped root" });
		expect(resolveAgentsViewLeftResult(remountedRoot)).toMatchObject({
			type: "scope_back",
			selection: { sessionId: root.sessionId },
		});
	});

	it("restores expanded subagent lists across view remounts", () => {
		const persistentState: AgentsViewPersistentState = {};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			(Reflect.get(view, "expandedSubagentParents") as Set<string>).add("file:/tmp/root.jsonl");
			(Reflect.get(view, "programShownParents") as Set<string>).add("file:/tmp/root.jsonl");

			const remount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect((Reflect.get(remount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(
				true,
			);
			expect((Reflect.get(remount, "programShownParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(true);

			// A collapsed-back list persists that way too.
			(Reflect.get(remount, "expandedSubagentParents") as Set<string>).delete("file:/tmp/root.jsonl");
			const collapsedRemount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect(
				(Reflect.get(collapsedRemount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl"),
			).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps subagent expansion across the active-to-persisted identity flip", () => {
		const rowsOf = (self: Record<string, unknown>) => Reflect.get(self, "rows") as AgentsViewRow[];
		const buildView = (expand: boolean) => {
			const parent = summary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionFile: undefined,
				runtimeKind: "top-level",
			});
			const child = summary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: undefined,
				runtimeKind: "subagent",
				parentSessionId: "root-session",
				parentActiveSessionId: "root-active",
			});
			const expandedSubagentParents = new Set<string>();
			const self: Record<string, unknown> = {
				persistentState: {},
				lastListedSummaries: [parent, child],
				savedSessions: [],
				heartbeats: [],
				inactiveAgentIdentities: new Set(),
				pendingDeleteAgent: undefined,
				savedCatalogReady: true,
				expandedSubagentParents,
				programShownParents: new Set(),
				editor: { getText: () => "" },
				getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
				applyPendingAncestorExpansion: vi.fn(),
				restoreSelection: vi.fn(),
				ui: { requestRender: vi.fn() },
				setStatusMessage: vi.fn(),
				withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
				takeCatalogReconcileScope: () => invoke("takeCatalogReconcileScope", self),
			};
			invoke("reconcileCatalogs", self);
			if (expand) {
				const parentRow = rowsOf(self).find(
					(row) => row.kind === "agent" && row.summary.sessionId === "root-session",
				);
				expect(parentRow?.identity).toBe("session:root-session");
				expandedSubagentParents.add(parentRow!.identity);
				invoke("reconcileCatalogs", self);
				expect(rowsOf(self).some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
			}
			// The runtime flushes the session file; the record identity flips to file:.
			self.lastListedSummaries = [{ ...parent, sessionFile: "/tmp/root.jsonl" }, child];
			invoke("reconcileCatalogs", self);
			return { self, expandedSubagentParents };
		};

		const expandedView = buildView(true);
		const expandedRows = rowsOf(expandedView.self);
		expect(
			expandedRows.find((row) => row.kind === "agent" && row.summary.sessionId === "root-session")?.identity,
		).toBe("file:/tmp/root.jsonl");
		expect(expandedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
		expect(expandedRows.some((row) => row.kind === "subagent" && row.summary.sessionId === "child-session")).toBe(
			true,
		);
		expect([...expandedView.expandedSubagentParents]).toEqual(["file:/tmp/root.jsonl"]);

		const collapsedView = buildView(false);
		const collapsedRows = rowsOf(collapsedView.self);
		expect(collapsedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(false);
		expect(collapsedRows.some((row) => row.kind === "subagent")).toBe(false);
		expect(collapsedView.expandedSubagentParents.size).toBe(0);
	});

	it("toggles subagent list expansion from the summary row", () => {
		const expandedSubagentParents = new Set(["root-row"]);
		const programShownParents = new Set(["root-row"]);
		const persistentState: AgentsViewPersistentState = {
			expandedSubagentParents,
			programShownParents,
		};
		const self: Record<string, unknown> = {
			persistentState,
			expandedSubagentParents,
			programShownParents,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const summaryRow = { kind: "subagent-summary", parentIdentity: "root-row", expanded: true };

		invoke("toggleSubagentList", self, summaryRow);
		expect(expandedSubagentParents.size).toBe(0);
		// Collapsing the list hides its revealed program too.
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(1);

		invoke("toggleSubagentList", self, { ...summaryRow, expanded: false });
		expect(expandedSubagentParents).toEqual(new Set(["root-row"]));
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(2);
	});

	// #2145 residual: the view never had a key that says "expand/collapse" outright.
	// Right (app.agents.open) reaches it only through openSelected and only while the
	// composer is empty and the search cursor sits at the end.
	it("collapses and expands the selected summary row with alt+right", () => {
		const ALT_RIGHT = "\x1b[1;3C";
		const buildSelf = (rows: AgentsViewRow[]) => {
			const expandedSubagentParents = new Set(["root-row"]);
			const programShownParents = new Set(["root-row"]);
			const self: Record<string, unknown> = {
				keybindings: new KeybindingsManager(),
				renameTarget: undefined,
				replyTarget: undefined,
				editor: { getText: () => "", handleInput: vi.fn() },
				rows,
				selectedIndex: 0,
				persistentState: { expandedSubagentParents, programShownParents },
				expandedSubagentParents,
				programShownParents,
				clearStickyStatusMessage: vi.fn(),
				clearCtrlCExitHint: vi.fn(),
				clearDeleteConfirmation: vi.fn(),
				handleListNavigation: () => false,
				queryChanged: vi.fn(),
				rebuildRows: vi.fn(),
				syncSelectedRowState: vi.fn(),
				ui: { requestRender: vi.fn() },
				toggleSubagentList(row: AgentsViewRow): void {
					invoke("toggleSubagentList", self, row);
				},
			};
			return self;
		};

		const summaryRow = {
			kind: "subagent-summary",
			parentIdentity: "root-row",
			expanded: true,
		} as unknown as AgentsViewRow;
		const onSummary = buildSelf([summaryRow]);
		invoke("handleInput", onSummary, ALT_RIGHT);
		expect([...(onSummary.expandedSubagentParents as Set<string>)]).toEqual([]);
		expect(onSummary.rebuildRows).toHaveBeenCalledTimes(1);
		// The key is an affordance, not composer input.
		expect((onSummary.editor as { handleInput: ReturnType<typeof vi.fn> }).handleInput).not.toHaveBeenCalled();

		const onRowWithoutSubagents = buildSelf([
			summary({ id: "plain", sessionId: "plain-session" }) as unknown as AgentsViewRow,
		]);
		invoke("handleInput", onRowWithoutSubagents, ALT_RIGHT);
		expect([...(onRowWithoutSubagents.expandedSubagentParents as Set<string>)]).toEqual(["root-row"]);
		expect(onRowWithoutSubagents.rebuildRows).not.toHaveBeenCalled();
		expect(
			(onRowWithoutSubagents.editor as { handleInput: ReturnType<typeof vi.fn> }).handleInput,
		).not.toHaveBeenCalled();
	});

	it("persists no ghost expansion key from the synthetic summary row", () => {
		const expandedSubagentParents = new Set<string>();
		const rows = [
			{
				kind: "subagent-summary",
				identity: "subagents:file:/tmp/root.jsonl",
				parentIdentity: "file:/tmp/root.jsonl",
				expanded: false,
				summary: { sessionId: "root-session" },
			},
			{ kind: "agent", identity: "file:/tmp/root.jsonl", expanded: true, summary: { sessionId: "root-session" } },
		] as unknown as AgentsViewRow[];
		const self: Record<string, unknown> = {
			persistentState: { pendingExpandedAncestorSessionIds: ["root-session"] },
			rows,
			expandedSubagentParents,
			rebuildRows: vi.fn(),
		};

		invoke("applyPendingAncestorExpansion", self);

		// Only the session row owns an expansion key: a summary line reuses its parent's
		// summary, so matching it would persist `subagents:<parent>` for a row that is
		// not a parent at all.
		expect([...expandedSubagentParents]).toEqual(["file:/tmp/root.jsonl"]);
		// One reveal pass for the session row; the summary line adds no second key.
		expect(self.rebuildRows).toHaveBeenCalledTimes(1);
	});

	it("merges Enter and Right into one hint naming what both do on the selected row", () => {
		const renderHintsFor = (row: AgentsViewRow): string => {
			const self: Record<string, unknown> = {
				isCtrlCExitHintVisible: () => false,
				statusMessage: undefined,
				renameTarget: undefined,
				replyTarget: undefined,
				rows: [row],
				selectedIndex: 0,
				selectedRowCanShowProgram: () => false,
			};
			return stripAnsi(invoke("renderHints", self, 200) as string);
		};

		const collapsedSummary = renderHintsFor({
			kind: "subagent-summary",
			expanded: false,
			section: "idle",
		} as unknown as AgentsViewRow);
		expect(collapsedSummary).toContain("Enter/→ 展开");
		// The old shape printed a second `→ open` hint on every other row kind; on a
		// summary line Right also collapses/expands, so the merged hint replaces it.
		expect(collapsedSummary).not.toContain("→ open");

		const expandedSummary = renderHintsFor({
			kind: "subagent-summary",
			expanded: true,
			section: "idle",
		} as unknown as AgentsViewRow);
		expect(expandedSummary).toContain("Enter/→ 收起");

		const agentRow = renderHintsFor({ kind: "agent", section: "idle" } as unknown as AgentsViewRow);
		expect(agentRow).toContain("Enter/→ 打开");
	});

	it("keeps the destructive-action gate on live work when the section reads Idle", () => {
		const renderHintsFor = (row: AgentsViewRow): string => {
			const self: Record<string, unknown> = {
				isCtrlCExitHintVisible: () => false,
				statusMessage: undefined,
				renameTarget: undefined,
				replyTarget: undefined,
				rows: [row],
				selectedIndex: 0,
				selectedRowCanShowProgram: () => false,
			};
			return stripAnsi(invoke("renderHints", self, 200) as string);
		};
		const subagentRow = (section: AgentsViewRow["section"], summary: Record<string, unknown>): AgentsViewRow =>
			({ kind: "subagent", section, runningSubagentCount: 0, summary }) as unknown as AgentsViewRow;

		// Case linkrefund-post2-ds (2026-09-20): the section now follows the display axis, so a
		// finished subagent whose kernel still hosts a live bash() handle reads Idle. Deleting it
		// would kill that background work, which is exactly what r44 forbids - so the legend keeps
		// offering "stop", gated on the residency axis instead of on the section.
		const hostingOnly = subagentRow("idle", { isSessionActive: true });
		expect(renderHintsFor(hostingOnly)).toContain("停止");
		expect(renderHintsFor(hostingOnly)).not.toContain("删除");

		// Same shape through the host-side bash term, which the kernel journal cannot see.
		const bashOnly = subagentRow("idle", { isSessionActive: false, isBashRunning: true });
		expect(renderHintsFor(bashOnly)).toContain("停止");

		// Positive control 1: a genuinely finished child with nothing live anywhere offers delete.
		const finished = subagentRow("idle", { isSessionActive: false });
		expect(renderHintsFor(finished)).toContain("删除");
		expect(renderHintsFor(finished)).not.toContain("停止");
		// Positive control 2: the mid-turn row is unchanged.
		expect(renderHintsFor(subagentRow("running", { isSessionActive: true }))).toContain("停止");
	});

	it("renders roster recovery and stale-worker status labels", () => {
		const rows = buildAgentsViewRows([
			summary({ id: "recovering", sessionId: "recovering", statusLabel: "recovering" }),
			summary({
				id: "stale",
				sessionId: "stale",
				lastHeardFromAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		]);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "rows", rows);

		try {
			expect(invoke("renderRow", view, rows[0], 160)).toContain("recovering");
			expect(invoke("renderRow", view, rows[1], 160)).toContain("last heard");
		} finally {
			stopThemeWatcher();
		}
	});

	it("renders aligned usage columns with an explicit subagent count and drops the message count", () => {
		const parent = summary({
			id: "spender",
			activeSessionId: "spender",
			sessionId: "spender-session",
			usage: { inputTokens: 12437, outputTokens: 1234, cost: 0.42 },
		});
		const child = summary({
			id: "spender-child",
			activeSessionId: "spender-child",
			sessionId: "spender-child-session",
			sessionFile: "/tmp/spender-child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: "spender",
			usage: { inputTokens: 500, outputTokens: 50, cost: 0.68 },
		});
		const inactive = summary({
			id: "saved-only",
			activeSessionId: undefined,
			sessionId: "saved-only-session",
			sessionFile: "/tmp/saved-only.jsonl",
			rosterStatus: "inactive",
			messageCount: 7,
		});
		const empty = summary({
			id: "empty-draft",
			activeSessionId: undefined,
			sessionId: "empty-draft-session",
			sessionFile: "/tmp/empty-draft.jsonl",
			rosterStatus: "inactive",
			messageCount: 0,
			modified: new Date(Date.now() - 120_000).toISOString(),
		});
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			const collapsed = buildAgentsViewRows([parent, child, inactive, empty]);
			const rows = buildAgentsViewRows(
				[parent, child, inactive, empty],
				new Set(collapsed.map((row) => row.identity)),
			);
			Reflect.set(view, "rows", rows);
			const layout = buildAgentsViewUsageLayout(rows);
			const line = (row: AgentsViewRow | undefined) =>
				stripAnsi(invoke("renderRow", view, row, 200, layout.details) as string);
			const byId = (sessionId: string, kind?: string) =>
				rows.find((row) => row.summary.sessionId === sessionId && (!kind || row.kind === kind));

			// Shared per-section layout: every column right-aligned to
			// max(widest section value, legend label width).
			expect(line(byId("spender-session"))).toContain("↑12k ↓1.2k · $0.42 ·      1 · $1.10 ·");
			expect(line(byId("spender-child-session", "subagent"))).toContain("↑500   ↓50 · $0.68 ·      0 · $0.68 ·");
			const inactiveLine = line(byId("saved-only-session"));
			expect(inactiveLine).toContain("↑0  ↓0 · $0.00 ·      0 · $0.00 ·");
			expect(inactiveLine).not.toContain("7 ·");
			// The ` · ` separators land in the same column for the legend and every
			// row of its section.
			// Display columns, not string indexes: the CJK labels are two columns wide.
			const dotColumns = (text: string) => {
				const columns: number[] = [];
				let column = 0;
				for (const ch of text) {
					if (ch === "·") columns.push(column);
					column += visibleWidth(ch);
				}
				return columns;
			};
			for (const [section, sessionId] of [
				["idle", "spender-session"],
				["idle", "spender-child-session"],
				["inactive", "saved-only-session"],
			] as const) {
				const detail = layout.details.get(byId(sessionId)!.identity)!;
				expect(dotColumns(detail)).toEqual(dotColumns(layout.legends.get(section)!));
			}
			// Empty sessions keep the age but drop the whole usage segment.
			const emptyLine = line(byId("empty-draft-session"));
			expect(emptyLine).not.toContain("↑");
			expect(emptyLine).not.toContain("$");
			expect(emptyLine).toMatch(/\d+[smhd]\s*$/);
			// Without a shared layout the row pads only against its own section of one.
			const bare = { ...byId("spender-session")!, summary: { ...parent, usage: undefined } };
			expect(stripAnsi(invoke("renderRow", view, bare, 200) as string)).toContain(
				" ↑0  ↓0 · $0.00 ·      1 · $1.10 ·",
			);
		} finally {
			stopThemeWatcher();
		}
	});

	it("shows an inactive saved row's recorded model — and only that row's model", () => {
		const saved = (id: string, model?: { provider: string; modelId: string }) => ({
			path: `/tmp/${id}.jsonl`,
			id,
			cwd: "/tmp",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
			...(model ? { model } : {}),
		});
		// An inactive row is an off-daemon saved session, so its live summary carries no
		// model at all: the recorded one is the only model it has (#2148).
		const records = reconcileUnifiedSessions(
			[],
			[saved("with-model", { provider: "prime-inference", modelId: "glm-4.7" }), saved("bare")],
		);
		const rows = buildAgentsViewRows(records);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "rows", rows);
		try {
			const rowFor = (id: string) => rows.find((row) => row.summary.sessionId === id)!;
			const render = (id: string) => stripAnsi(invoke("renderRow", view, rowFor(id), 120) as string);

			expect(render("with-model")).toContain("prime-inference/glm-4.7");
			// Control: a row without a recorded model stays as bare as it was, and the
			// other row's model never leaks into it.
			expect(render("bare")).not.toContain("glm-4.7");
			expect(render("bare")).not.toContain("prime-inference");

			// The header names the selected row's own model; the model this view would
			// start a new session with is only the fallback, so a selected row that has
			// one wins and a row without one leaves it undefined.
			Reflect.set(view, "selectedIndex", rows.indexOf(rowFor("with-model")));
			expect(invoke("getSplashModelId", view)).toBe("glm-4.7");
			Reflect.set(view, "selectedIndex", rows.indexOf(rowFor("bare")));
			expect(invoke("getSplashModelId", view)).toBeUndefined();
		} finally {
			stopThemeWatcher();
		}
	});

	it("shows the bold usage legend on every section header", () => {
		const running = (id: string, created: string) =>
			summary({
				id,
				activeSessionId: id,
				sessionId: `${id}-session`,
				sessionName: id,
				activity: "working",
				isStreaming: true,
				created,
			});
		const parent = running("busy-parent", "2026-01-01T00:00:00Z");
		const child = summary({
			id: "busy-child",
			activeSessionId: "busy-child",
			sessionId: "busy-child-session",
			sessionName: "busy-child",
			sessionFile: "/tmp/busy-child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: "busy-parent",
		});
		const summaries = [
			running("busy-solo", "2026-01-02T00:00:00Z"),
			parent,
			child,
			summary({ id: "idle-a", activeSessionId: "idle-a", sessionId: "idle-a-session", sessionName: "idle-a" }),
			summary({ id: "idle-b", activeSessionId: "idle-b", sessionId: "idle-b-session", sessionName: "idle-b" }),
		];
		const parentIdentity = buildAgentsViewRows(summaries).find(
			(row) => row.summary.sessionId === "busy-parent-session",
		)!.identity;
		const rows = buildAgentsViewRows(summaries, new Set([parentIdentity]));
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			Reflect.set(view, "rows", rows);
			Reflect.set(view, "selectedIndex", -1);
			Reflect.set(view, "ui", { terminal: { rows: 60 }, requestRender: () => {} });
			const rendered = invoke("renderSessionRows", view, 120, 40) as string[];
			const lines = rendered.map(stripAnsi);
			const headings = lines.filter((line) => /^(运行中|空闲|历史) \(\d+\)/.test(line));
			expect(headings).toHaveLength(3);
			for (const heading of headings) {
				expect(heading).toMatch(/↑入\s+↓出 ·\s+自身 ·\s+子代理 ·\s+合计 ·\s+更新$/);
			}
			// Same bold weight for title and legend.
			const runningLegend = buildAgentsViewUsageLayout(rows).legends.get("running")!;
			expect(invoke("renderSectionHeading", view, "running", 120, runningLegend)).toContain(
				theme.bold(runningLegend),
			);

			// Session rows carry no background of their own; only the selection
			// highlight may paint one.
			const finalized = rendered.map((line) => invoke("finalizeRenderedLine", view, line, 120) as string);
			for (const line of finalized) {
				expect(line).not.toContain("\x1b[48");
			}
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a selection at the end of the list visible when the leading ellipsis is shown", () => {
		const summaries = Array.from({ length: 12 }, (_, index) =>
			summary({
				id: `saved-${index}`,
				activeSessionId: undefined,
				sessionId: `saved-${index}-session`,
				sessionName: `saved-${index}`,
				sessionFile: `/tmp/saved-${index}.jsonl`,
				rosterStatus: "inactive" as const,
				created: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
			}),
		);
		const rows = buildAgentsViewRows(summaries);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			Reflect.set(view, "rows", rows);
			Reflect.set(view, "selectedIndex", rows.length - 1);
			Reflect.set(view, "ui", { terminal: { rows: 13 }, requestRender: () => {} });
			const lines = (invoke("renderSessionRows", view, 120, 4) as string[]).map(stripAnsi);
			expect(lines[0]).toContain("...");
			const lastTitle = rows.at(-1)!.title;
			expect(lines.some((line) => line.includes(lastTitle))).toBe(true);
		} finally {
			stopThemeWatcher();
		}
	});

	it("renders a collapsed group's busy-subagent badge legibly instead of dimmed", () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent-session" });
		const busyChild = summary({
			id: "busy-child",
			activeSessionId: "busy-child",
			sessionId: "busy-child-session",
			sessionFile: "/tmp/busy-child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
			activity: "working",
			isSessionActive: true,
			isStreaming: true,
		});
		const idleChild = { ...busyChild, activity: "idle" as const, isSessionActive: false, isStreaming: false };
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			const busyRows = buildAgentsViewRows([parent, busyChild]);
			const busySummaryRow = busyRows.find((row) => row.kind === "subagent-summary");
			expect(busySummaryRow).toMatchObject({ section: "idle", title: "1 subagent running" });
			Reflect.set(view, "rows", busyRows);
			expect(invoke("renderRow", view, busySummaryRow, 160)).toContain(theme.fg("success", "▸ 1 subagent running"));

			const idleRows = buildAgentsViewRows([parent, idleChild]);
			const idleSummaryRow = idleRows.find((row) => row.kind === "subagent-summary");
			Reflect.set(view, "rows", idleRows);
			expect(invoke("renderRow", view, idleSummaryRow, 160)).toContain(theme.fg("dim", "▸ 1 subagent"));
		} finally {
			stopThemeWatcher();
		}
	});

	it("dims a paused-only heartbeat badge and keeps active badges in the error color", () => {
		const job = (status: "active" | "paused") => ({
			job: {
				id: `${status}-job`,
				status,
				activeSessionId: "scope-active",
				sessionId: "scope-session",
				sessionFile: "/tmp/scope.jsonl",
				cwd: "/tmp",
				prompt: "tick",
				schedule: { kind: "interval" as const, expression: "5m" },
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				runCount: 0,
			},
		});
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			const [pausedRow] = buildAgentsViewRows(reconcileUnifiedSessions([summary()], [], [job("paused")]));
			Reflect.set(view, "rows", [pausedRow]);
			const pausedLine = invoke("renderRow", view, pausedRow, 160) as string;
			expect(pausedLine).toContain(theme.fg("dim", "♥ 1"));
			expect(pausedRow).toMatchObject({ section: "idle" });

			const [activeRow] = buildAgentsViewRows(reconcileUnifiedSessions([summary()], [], [job("active")]));
			Reflect.set(view, "rows", [activeRow]);
			const activeLine = invoke("renderRow", view, activeRow, 160) as string;
			expect(activeLine).toContain(theme.fg("error", "♥ 1"));
		} finally {
			stopThemeWatcher();
		}
	});

	it("warns about the armed heartbeat in the delete confirmation", () => {
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "deleteConfirmExpiresAt", Date.now() + 10_000);
		const confirmLine = (row: AgentsViewRow): string => {
			Reflect.set(view, "rows", [row]);
			Reflect.set(view, "pendingDeleteAgent", { identity: row.identity, summary: row.summary, stopped: false });
			return stripAnsi(invoke("renderRow", view, row, 160) as string);
		};

		try {
			const [armedRow] = buildAgentsViewRows([summary({ hasActiveHeartbeat: true })]);
			expect(confirmLine(armedRow!)).toContain("有定时任务 — ");
			const [plainRow] = buildAgentsViewRows([summary()]);
			expect(confirmLine(plainRow!)).not.toContain("armed heartbeat");
			expect(confirmLine(plainRow!)).toContain("移除");
		} finally {
			stopThemeWatcher();
		}
	});
});

describe("AgentsViewMode roster client wiring", () => {
	it("builds the roster client in run() with the first-party session capabilities", async () => {
		modeMocks.clientConstructions.length = 0;
		// attach() answering false is run()'s own early exit, so this drives the
		// real wiring without a TUI, a theme watcher, or the poll timers.
		const persistentState: AgentsViewPersistentState = {
			rosterStore: { attach: vi.fn(async () => false) } as unknown as AgentsViewRosterStore,
		};
		const view = new AgentsViewMode(
			{ config: {}, socketPath: "/tmp/agents-view.sock", uiServices: createUiServices() },
			persistentState,
		);

		try {
			await expect(view.run()).rejects.toThrow(STALE_ROSTER_DAEMON_MESSAGE);
			expect(modeMocks.clientConstructions).toEqual([
				{
					socketPath: "/tmp/agents-view.sock",
					declaredCapabilities: DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
				},
			]);
			// A client that reports itself connected is subscribed as-is.
			const client = persistentState.rosterClient as unknown as {
				reconnect: ReturnType<typeof vi.fn>;
				onMessage: ReturnType<typeof vi.fn>;
			};
			expect(client.reconnect).not.toHaveBeenCalled();
			expect(client.onMessage).toHaveBeenCalledOnce();
		} finally {
			stopThemeWatcher();
		}
	});

	it("opens a child picked in the chat's subagent panel without painting the list", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const picked = summary({ id: "child", activeSessionId: "child", sessionId: "child", parentSessionId: "parent" });
		const persistentState = createInitialAgentsViewPersistentState({ initialOpenActiveSessionId: "child" });
		persistentState.rosterStore = {
			attach: vi.fn(async () => true),
			summaries: () => [parent, picked],
		} as unknown as AgentsViewRosterStore;
		const view = new AgentsViewMode(
			{ config: {}, socketPath: "/tmp/agents-view.sock", uiServices: createUiServices() },
			persistentState,
		);

		try {
			await expect(view.run()).resolves.toMatchObject({ type: "open", summary: { activeSessionId: "child" } });
			// One shot: the next view is the ordinary list.
			expect(persistentState.pendingOpenActiveSessionId).toBeUndefined();
		} finally {
			stopThemeWatcher();
		}
	});

	it("reconnects a stale roster client before handing it to the roster store", async () => {
		modeMocks.clientConstructions.length = 0;
		const attached: unknown[] = [];
		const client = {
			isConnected: false,
			reconnect: vi.fn(async () => undefined),
			onMessage: vi.fn(() => () => {}),
		};
		const persistentState: AgentsViewPersistentState = {
			rosterClient: client as unknown as DaemonClient,
			rosterStore: {
				attach: vi.fn(async (target: unknown) => {
					attached.push(target);
					return false;
				}),
			} as unknown as AgentsViewRosterStore,
		};
		const view = new AgentsViewMode(
			{ config: {}, socketPath: "/tmp/agents-view.sock", uiServices: createUiServices() },
			persistentState,
		);

		try {
			await expect(view.run()).rejects.toThrow(STALE_ROSTER_DAEMON_MESSAGE);
			expect(client.reconnect).toHaveBeenCalledOnce();
			expect(attached).toEqual([client]);
			// A client carried in on persistent state is never rebuilt.
			expect(modeMocks.clientConstructions).toEqual([]);
		} finally {
			stopThemeWatcher();
		}
	});
});

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentsViewMode persistent catalog state", () => {
	it("treats only a previously loaded saved catalog as settled on mount", () => {
		const fresh = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		const loaded = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, { savedCatalogLoaded: true });

		try {
			expect(Reflect.get(fresh, "savedCatalogReady")).toBe(false);
			expect(Reflect.get(loaded, "savedCatalogReady")).toBe(true);
		} finally {
			stopThemeWatcher();
		}
	});

	it("applies an initial handoff scope from the first pushed roster refresh", async () => {
		const root = summary();
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		const persistentState = createInitialAgentsViewPersistentState({
			initialScopeKey: scope,
			initialSession: root,
		});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "rosterStore", { summaries: () => [root] });
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("refreshSessions", view)).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: root }]);
			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([root]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("re-arms reconnect from the heartbeat poll over a dead socket and never overwrites a sticky notice", async () => {
		const harness = (isConnected: boolean, statusMessageSticky: boolean) => {
			const client = {
				isConnected,
				request: vi.fn(async () => {
					throw new Error("heartbeats unavailable");
				}),
			};
			return {
				client,
				heartbeatCatalogGeneration: 0,
				reconnectPromise: undefined,
				daemonShutdownReceived: false,
				statusMessageSticky,
				requireClient: () => client,
				startClientReconnect: vi.fn(),
				setStatusMessage: vi.fn(),
			};
		};

		const reconnecting = harness(false, false);
		await expect(invoke("refreshHeartbeats", reconnecting)).resolves.toBe(false);
		expect(reconnecting.startClientReconnect).toHaveBeenCalledWith(reconnecting.client, expect.any(Error));
		expect(reconnecting.setStatusMessage).not.toHaveBeenCalled();

		const sticky = harness(true, true);
		await expect(invoke("refreshHeartbeats", sticky)).resolves.toBe(false);
		expect(sticky.startClientReconnect).not.toHaveBeenCalled();
		expect(sticky.setStatusMessage).not.toHaveBeenCalled();
	});

	it("keeps a live-only scope after a fresh instance's first live poll fails", async () => {
		const root = summary({
			id: "root-active",
			activeSessionId: "root-active",
			isSessionActive: true,
			runtimeKind: "top-level",
			sessionId: "root-session",
			cwd: process.cwd(),
		});
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([
				{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } },
			]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope through reconnect timeout and settles it on the next successful list", async () => {
		vi.useFakeTimers();
		const root = summary();
		const frame = { scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } };
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [frame],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode(
			{ config: {}, uiServices: createUiServices(), reconnectTimeoutMs: 0 },
			persistentState,
		);
		const client = { isConnected: false, reconnect: vi.fn() };
		Reflect.set(view, "client", client);
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("reconnectClient", view, client, new Error("disconnected"))).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([frame]);
			expect(Reflect.get(view, "lastListedSummaries")).toEqual([root]);

			Reflect.set(view, "client", { isConnected: true });
			Reflect.set(view, "rosterStore", { summaries: () => [] });
			await expect(invoke("refreshSessions", view)).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("applies the roster snapshot produced during reconnect heartbeat refresh", async () => {
		const beforeRefresh = summary({ id: "before", sessionId: "before" });
		const afterRefresh = summary({ id: "after", sessionId: "after" });
		let current = [beforeRefresh];
		let finishHeartbeatRefresh: (() => void) | undefined;
		const heartbeatRefresh = new Promise<void>((resolve) => {
			finishHeartbeatRefresh = resolve;
		});
		const client = { reconnect: vi.fn(async () => undefined) };
		const self = {
			options: { recoverDaemon: vi.fn(async () => undefined) },
			client,
			rosterStore: {
				attach: vi.fn(async () => true),
				summaries: vi.fn(() => current),
			},
			refreshHeartbeats: vi.fn(async () => {
				await heartbeatRefresh;
				return true;
			}),
			daemonShutdownReceived: false,
			reconnectTimedOut: true,
			setStatusMessage: vi.fn(),
			applySessionList: vi.fn(),
			armSavedSearchFetch: vi.fn(),
		};

		const reconnect = invoke("reconnectClient", self, client, new Error("disconnected")) as Promise<void>;
		await vi.waitFor(() => expect(self.refreshHeartbeats).toHaveBeenCalledOnce());
		current = [afterRefresh];
		finishHeartbeatRefresh?.();
		await reconnect;

		expect(self.applySessionList).toHaveBeenCalledWith([afterRefresh], true);
	});

	it("keeps a newly pushed scope and the existing live cache when its first poll fails", async () => {
		const root = summary();
		const other = summary({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" });
		const returnedRoot = { ...root, sessionName: "Updated root" };
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			const persistentState = Reflect.get(this, "persistentState") as AgentsViewPersistentState;
			if (runs === 1) {
				persistentState.lastSuccessfulLiveSummaries = [other];
				persistentState.lastSuccessfulSavedSessions = [];
				return { type: "open", summary: root, hasChildren: false };
			}

			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([other, returnedRoot]);
			Reflect.set(this, "client", {
				isConnected: true,
				request: vi.fn(async () => {
					throw new Error("transient list failure");
				}),
			});
			await expect(invoke("refreshSessions", this, { preserveStatusOnError: true })).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: returnedRoot }]);
			return { type: "exit" };
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "scoped_agents_view",
			source: {
				activeSessionId: root.activeSessionId!,
				sessionId: root.sessionId,
				sessionName: returnedRoot.sessionName,
				cwd: root.cwd,
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("agents view startup notices", () => {
	it("combines the open fallback and cwd fallback without dropping either notice", () => {
		expect(combineAgentsViewStartupNotices("Child unavailable", "Original directory is missing")).toBe(
			"Child unavailable · Original directory is missing",
		);
		expect(combineAgentsViewStartupNotices("Child unavailable", undefined)).toBe("Child unavailable");
		expect(combineAgentsViewStartupNotices(undefined, "Original directory is missing")).toBe(
			"Original directory is missing",
		);
	});

	it("persists the combined open and cwd fallback notices after returning to agents view", async () => {
		const root = summary({
			activeSessionId: undefined,
			cwd: "/definitely/not/a/real/dir/for/this/test",
			lifecycle: "archived",
			sessionFile: "/tmp/root.jsonl",
		});
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) {
				return {
					type: "open",
					summary: root,
					hasChildren: false,
					statusMessage: "Child unavailable",
				};
			}
			expect(Reflect.get(this, "persistentState")).toMatchObject({
				statusMessage: `Child unavailable · Original directory is missing (${root.cwd}); opened in ${process.cwd()} instead.`,
			});
			return { type: "exit" };
		});
		modeMocks.clientRequest.mockResolvedValue({
			type: "response",
			command: "create",
			success: true,
			data: { ...root, cwd: process.cwd(), activeSessionId: "resumed-active", lifecycle: "live" },
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: {
				activeSessionId: "resumed-active",
				sessionId: root.sessionId,
				cwd: process.cwd(),
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("agents view session-switch handoff", () => {
	type FinishHarness = Record<string, unknown>;

	/**
	 * finish() stops the renderer, and stop() freezes the last painted frame: that frame is
	 * what the user watches while the session they picked is resumed and attached, which is
	 * seconds of work. So the placeholder has to be painted *synchronously* before stop() -
	 * requestRender defers past `stopped` and would never fire.
	 */
	function finishHarness(): { self: FinishHarness; frames: string[]; resolveRun: ReturnType<typeof vi.fn> } {
		const frames: string[] = [];
		// finish() clears the field after resolving, so the witness has to be held here.
		const resolveRun = vi.fn();
		const self: FinishHarness = {
			stopped: false,
			savedCatalogGeneration: 0,
			heartbeatCatalogGeneration: 0,
			clearScheduledCatalogReconcile: vi.fn(),
			heartbeatPollTimer: undefined,
			animationTimer: undefined,
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			statusMessageTimer: undefined,
			unsubscribeClientClose: undefined,
			unsubscribeClientMessage: undefined,
			unsubscribeRosterUpdate: undefined,
			client: undefined,
			resolveRun,
		};
		self.ui = {
			requestRender: vi.fn(),
			flushRender: vi.fn(() => frames.push(`paint:${String(self.statusMessage)}`)),
			stop: vi.fn(() => frames.push(`stop:${String(self.statusMessage)}`)),
		};
		// The real setStatusMessage: the proposition is what the frozen frame says, so the
		// formatting and the sticky flag have to be the production ones.
		Object.setPrototypeOf(self, AgentsViewMode.prototype);
		return { self, frames, resolveRun };
	}

	it("paints an opening placeholder into the frozen frame before stopping", () => {
		const { self, frames, resolveRun } = finishHarness();

		invoke("finish", self, { type: "open", summary: summary({ sessionName: "worker-a" }) });

		expect(frames).toEqual(["paint:正在打开 worker-a…", "stop:正在打开 worker-a…"]);
		expect(self.stopped).toBe(true);
		expect(resolveRun).toHaveBeenCalledWith(
			expect.objectContaining({ type: "open", summary: expect.objectContaining({ sessionName: "worker-a" }) }),
		);
		// Sticky, so the placeholder armed no expiry timer the stopped renderer cannot run.
		expect(self.statusMessageTimer).toBeUndefined();
	});

	it("names the session a scope-back returns to", () => {
		const { self, frames } = finishHarness();

		invoke("finish", self, {
			type: "scope_back",
			selection: summary({ sessionName: "parent" }),
			expandedAncestorSessionIds: [],
			returnChat: summary({ sessionName: "child-chat" }),
			hasChildren: false,
		});

		expect(frames).toEqual(["paint:正在打开 child-chat…", "stop:正在打开 child-chat…"]);
	});

	it("still hands the terminal over when the placeholder cannot paint", () => {
		const { self, frames, resolveRun } = finishHarness();
		const ui = self.ui as { flushRender: ReturnType<typeof vi.fn> };
		ui.flushRender.mockImplementation(() => {
			throw new Error("paint blew up");
		});

		invoke("finish", self, { type: "open", summary: summary({ sessionName: "worker-a" }) });

		expect(frames).toEqual(["stop:正在打开 worker-a…"]);
		expect(resolveRun).toHaveBeenCalledOnce();
	});

	it.each([
		["exit", { type: "exit" }],
		[
			"a scope back that only rebuilds the list",
			{
				type: "scope_back",
				selection: summary({ sessionName: "parent" }),
				expandedAncestorSessionIds: [],
				hasChildren: false,
			},
		],
	])("clears the status without a placeholder for %s", (_label, result) => {
		const { self, frames } = finishHarness();
		self.statusMessage = "Left over from a keypress";

		invoke("finish", self, result);

		expect(frames).toEqual(["stop:undefined"]);
	});
});

describe("agents view reply delivery on inactive sessions", () => {
	function replySummary(overrides: Partial<SessionSummary>): SessionSummary {
		return {
			id: "saved-1",
			lifecycle: "archived",
			activity: "idle",
			sessionId: "saved-1",
			cwd: process.cwd(),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 3,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			...overrides,
			isSessionActive: overrides.isSessionActive ?? false,
		};
	}

	function editorWithText(initial: string) {
		let text = initial;
		return {
			getText: () => text,
			setText: vi.fn((next: string) => {
				text = next;
			}),
		};
	}

	const savedSummary = replySummary({
		sessionFile: "/tmp/sessions/saved-1.jsonl",
		cwd: process.cwd(),
		summary: "Persisted recap text",
		firstMessage: "opener",
	});

	it("arms a saved reply from its persisted recap and lets ctrl+c disarm it", async () => {
		const requestRender = vi.fn();
		const handleCtrlC = vi.fn();
		const self: Record<string, unknown> = {
			rows: [
				{ kind: "agent", selectable: true, identity: "file:/tmp/sessions/saved-1.jsonl", summary: savedSummary },
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			renameTarget: undefined,
			setReplyTarget: vi.fn((target: unknown) => {
				self.replyTarget = target;
			}),
			ui: { requestRender },
			clearStickyStatusMessage: vi.fn(),
			keybindings: { matches: (_data: string, action: string) => action === "app.clear" },
			handleCtrlC,
		};

		await invoke("toggleReplyTarget", self);
		expect(self.replyTarget).toEqual({ key: "saved-1", summary: savedSummary });
		expect(self.replyLastAssistantText).toBe("Persisted recap text");
		expect(requestRender).toHaveBeenCalledOnce();

		invoke("handleInput", self, "\x03");
		expect(self.replyTarget).toBeUndefined();
		expect(handleCtrlC).not.toHaveBeenCalled();
	});

	it("keeps the cwd-fallback notice visible after the reply is sent", async () => {
		const savedWithMissingCwd = { ...savedSummary, cwd: "/definitely/not/a/real/dir/for/this/test" };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...savedWithMissingCwd, lifecycle: "live", activeSessionId: "active-9" },
		}));
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage,
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "saved-1", summary: savedWithMissingCwd }, "wake up");

		expect(setStatusMessage).toHaveBeenLastCalledWith(expect.stringContaining("Original directory is missing"), {
			sticky: true,
		});
	});

	it("submits alt+enter as a follow-up only for an armed non-empty reply", () => {
		const submit = vi.fn(async () => {});
		invoke("handleReplyFollowUp", { replyTarget: undefined, editor: { getExpandedText: () => "text" }, submit });
		invoke("handleReplyFollowUp", {
			replyTarget: { key: "active-1", summary: savedSummary },
			editor: { getExpandedText: () => "   " },
			submit,
		});
		expect(submit).not.toHaveBeenCalled();

		invoke("handleReplyFollowUp", {
			replyTarget: { key: "active-1", summary: savedSummary },
			editor: { getExpandedText: () => "expanded paste body" },
			submit,
		});
		expect(submit).toHaveBeenCalledWith("expanded paste body", "followUp");
	});

	// [the view finishes mid-create, the requests the dedicated connection carries]
	it.each([
		["opens it", false, ["create"]],
		["kills a session created after the view already finished", true, ["create", "kill"]],
	] as const)(
		"creates a new daemon session over a dedicated connection and %s",
		async (_name, stopsDuringCreate, requestTypes) => {
			const created = replySummary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
			const requests: { type: string }[] = [];
			const close = vi.fn();
			const self: Record<string, unknown> = {
				creatingNewSession: false,
				stopped: false,
				options: { config: {} },
				connectDedicatedClient: vi.fn(async () => ({
					close,
					request: vi.fn(async (command: { type: string }) => {
						requests.push(command);
						// The view finishes while create is in flight.
						if (stopsDuringCreate) self.stopped = true;
						return { success: true, data: created };
					}),
				})),
				setStatusMessage: vi.fn(),
				selectSummary: vi.fn(),
				finish: vi.fn(),
			};

			const result = await invoke("createNewSession", self);

			expect(requests.map((r) => r.type)).toEqual(requestTypes);
			if (stopsDuringCreate) {
				expect(self.finish).not.toHaveBeenCalled();
				expect(self.selectSummary).not.toHaveBeenCalled();
			} else {
				expect(result).toBe(true);
				expect(self.selectSummary).toHaveBeenCalledWith(created);
				expect(self.finish).toHaveBeenCalledWith({ type: "open", summary: created });
				expect(close).toHaveBeenCalledOnce();
				expect(self.creatingNewSession).toBe(false);
			}
		},
	);

	it("resumes a saved session before delivering the reply", async () => {
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "create") {
				return {
					success: true,
					data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9", isStreaming: true },
				};
			}
			return { success: true, data: {} };
		});
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			replyTarget: target,
			// Stale pre-resume rows do not know the resumed session; scheduling must
			// come from the resume response instead.
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, target, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-9", "wake up", "steer");
		expect(self.selectSummary).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-9" }));
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it("does not select a resumed session after its reply target is cancelled", async () => {
		let finishResume: ((result: { success: true; data: SessionSummary }) => void) | undefined;
		let signalResumeStarted!: () => void;
		const resumeStarted = new Promise<void>((resolve) => {
			signalResumeStarted = resolve;
		});
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: SessionSummary }>((resolve) => {
					finishResume = resolve;
					signalResumeStarted();
				}),
		);
		const target = { key: "saved-1", summary: savedSummary };
		const selection = { activeSessionId: "active-2" };
		const selectSummary = vi.fn((next: SessionSummary) => {
			selection.activeSessionId = next.activeSessionId ?? next.id;
		});
		const sendPrompt = vi.fn(async () => {});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			replyTarget: target,
			setStatusMessage: vi.fn(),
			selectSummary,
			sendPrompt,
		};

		const reply = invoke("sendReply", self, target, "wake up") as Promise<boolean>;
		await resumeStarted;
		expect(request).toHaveBeenCalledOnce();
		self.replyTarget = undefined;
		finishResume?.({
			success: true,
			data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
		});

		await expect(reply).resolves.toBe(true);
		expect(selectSummary).not.toHaveBeenCalled();
		expect(selection.activeSessionId).toBe("active-2");
		expect(sendPrompt).toHaveBeenCalledWith("active-9", "wake up", undefined);
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
	});

	// [re-armed target survives, text entered mid-send survives]
	it.each([
		["preserves a replacement composer when an older reply succeeds", true],
		["preserves new text entered while the same reply succeeds", false],
	] as const)("%s", async (_name, rearmed) => {
		const editor = editorWithText("old reply");
		const oldTarget = { key: "saved-1", summary: savedSummary };
		const newTarget = {
			key: "active-2",
			summary: replySummary({ id: "active-2", activeSessionId: "active-2", lifecycle: "live" }),
		};
		const self: Record<string, unknown> = {
			replyTarget: oldTarget,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				if (rearmed) self.replyTarget = newTarget;
				editor.setText("next reply");
				return true;
			}),
		};

		await invoke("submit", self, "old reply");

		expect(self.replyTarget).toBe(rearmed ? newTarget : oldTarget);
		expect(editor.getText()).toBe("next reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		if (rearmed) expect(self.refreshSessions).toHaveBeenCalledWith();
	});

	it.each([
		{ name: "resume failure", failure: "resume", remainsInactive: true },
		{ name: "send failure", failure: "send", remainsInactive: false },
		{
			name: "replacement text entered during send failure",
			failure: "send",
			replacement: "replacement",
			remainsInactive: false,
		},
	] as const)("handles $name", async ({ failure, replacement, remainsInactive }) => {
		const editor = editorWithText("wake up");
		const target = { key: "saved-1", summary: savedSummary };
		const inactiveAgentIdentities = new Set(["file:/tmp/sessions/saved-1.jsonl"]);
		const request = vi.fn(async () => {
			if (failure === "resume") throw new Error("resume failed");
			return {
				success: true,
				data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
			};
		});
		const sendPrompt = vi.fn(async () => {
			if (replacement) editor.setText(replacement);
			throw new Error("send failed");
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities,
			replyTarget: target,
			editor,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt,
			sendReply: (replyTarget: unknown, text: string) => invoke("sendReply", self, replyTarget, text),
		};

		await invoke("submit", self, "wake up");

		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(sendPrompt).toHaveBeenCalledTimes(failure === "resume" ? 0 : 1);
		expect(self.selectSummary).toHaveBeenCalledTimes(failure === "resume" ? 0 : 1);
		expect(self.setStatusMessage).toHaveBeenLastCalledWith(`Failed to send reply: ${failure} failed`);
		expect(self.replyTarget).toBe(target);
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		expect(editor.setText).toHaveBeenNthCalledWith(1, "");
		expect(editor.getText()).toBe(replacement ?? "wake up");
		expect(inactiveAgentIdentities.has("file:/tmp/sessions/saved-1.jsonl")).toBe(remainsInactive);
		expect(self.refreshSessions).toHaveBeenCalledTimes(remainsInactive ? 0 : 1);
		if (!remainsInactive) {
			expect(self.refreshSessions).toHaveBeenCalledWith();
		}
	});

	it("resumes the current saved row when an armed live target becomes inactive", async () => {
		const capturedLive = replySummary({
			activeSessionId: "active-dead",
			lifecycle: "live",
			sessionFile: savedSummary.sessionFile,
		});
		const currentSaved = { ...savedSummary, activeSessionId: undefined };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...currentSaved, lifecycle: "live", activeSessionId: "active-new" },
		}));
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			unifiedRecords: [
				{
					daemon: currentSaved,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "inactive",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set<string>(),
			replyTarget: undefined,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-dead", summary: capturedLive }, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-new", "wake up", undefined);
		expect(self.sendPrompt).not.toHaveBeenCalledWith("active-dead", expect.anything(), expect.anything());
	});

	it("replies to live sessions without resuming, steering or queueing per delivery", async () => {
		let liveSummary = replySummary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};
		const target = () => ({ key: "active-1", summary: liveSummary });

		await invoke("sendReply", self, target(), "hello");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "hello", undefined);

		liveSummary = replySummary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		await invoke("sendReply", self, target(), "change course");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "change course", "steer");

		await invoke("sendReply", self, target(), "later please", "followUp");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "later please", "followUp");

		expect(request).not.toHaveBeenCalled();
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("does not disarm a composer that was re-armed during the command", async () => {
		const live = replySummary({ activeSessionId: "active-1", lifecycle: "live" });
		const originalTarget = { key: "active-1", summary: live };
		const newTarget = { key: "active-2", summary: replySummary({ activeSessionId: "active-2" }) };
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({
				request: vi.fn(async () => {
					// The user re-arms against a different agent mid-RPC.
					self.replyTarget = newTarget;
					return { success: true, data: {} };
				}),
			}),
			editor: editorWithText(""),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: originalTarget,
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("re-resolves the armed target before dispatching a view command", async () => {
		const stale = replySummary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const liveNow = replySummary({
			sessionFile: "/tmp/sessions/saved-1.jsonl",
			activeSessionId: "active-9",
			lifecycle: "live",
		});
		const runAgentsViewCommand = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: { key: "saved-1", summary: stale },
			options: {},
			unifiedRecords: [
				{
					daemon: liveNow,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "idle",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			editor: editorWithText(""),
			runAgentsViewCommand,
		};

		await invoke("submit", self, "/kill");

		expect(runAgentsViewCommand).toHaveBeenCalledWith(
			{ name: "kill", args: "" },
			expect.objectContaining({ activeSessionId: "active-9" }),
		);
	});
});
describe("agents view open during a daemon update restart", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		[
			"waits through the update restart and surfaces the wait notice",
			true,
			"Waited for the Prime Agent daemon update restart to finish",
		],
		[
			"surfaces a permanent create failure unmasked by the wait",
			false,
			"Failed to open agent: File not found: /tmp/scope.jsonl",
		],
	] as const)("%s", async (_name, reachesSession, expectedMessage) => {
		const saved = summary({ activeSessionId: undefined, lifecycle: "archived" });
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) return { type: "open", summary: saved, hasChildren: false };
			expect(String(Reflect.get(this, "persistentState").statusMessage)).toContain(expectedMessage);
			return { type: "exit" };
		});
		modeMocks.clientRequest
			.mockResolvedValueOnce({
				success: false,
				error: "Daemon is preparing an update restart",
			})
			.mockResolvedValueOnce(
				reachesSession
					? { success: true, data: { ...saved, activeSessionId: "resumed-after-update", lifecycle: "live" } }
					: { success: false, error: "File not found: /tmp/scope.jsonl" },
			);
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: { activeSessionId: "resumed-after-update", sessionId: saved.sessionId, cwd: saved.cwd },
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(modeMocks.clientRequest).toHaveBeenCalledTimes(2);
		expect(modeMocks.interactiveRun).toHaveBeenCalledTimes(reachesSession ? 1 : 0);
		expect(runs).toBe(2);
	});
});

describe("waitThroughDaemonUpdateRestart", () => {
	const updateRestartDeadline =
		/The Prime Agent daemon did not finish its update restart within \d+ seconds\. Try opening this agent again once the update finishes\. Last error: Daemon is preparing an update restart/;

	// Post-arm transient shapes only; arming is pinned at the loop/deadline layers.
	it("retries every restart-transient failure and reports that it waited", async () => {
		const transientFailures = [
			() => new Error("Failed to connect to the Prime Agent daemon: connect ENOENT"),
			() => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			() => new Error("Connection to the Prime Agent daemon closed."),
			() => new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "create".'),
			() => new DaemonControlPlaneTransportError(new Error("Connection to the Prime Agent daemon closed.")),
			() => new Error("Unknown active session: update-restart-session"),
			() => new DaemonSessionRecoveringError("update-restart-session"),
		];
		let attempts = 0;
		const outcome = await waitThroughDaemonUpdateRestart(
			async () => {
				attempts += 1;
				if (attempts === 1) throw new DaemonUpdateRestartingError();
				const failure = transientFailures[attempts - 2];
				if (failure) throw failure();
				return "opened";
			},
			{ waitMs: 5_000, retryMs: 1 },
		);
		expect(outcome).toEqual({ result: "opened", waitedForUpdateRestart: true });
	});

	it("propagates a non-update failure before any update-restart signal", async () => {
		let attempts = 0;
		await expect(
			waitThroughDaemonUpdateRestart(async () => {
				attempts += 1;
				throw new Error("spawn EMFILE");
			}),
		).rejects.toThrow("spawn EMFILE");
		expect(attempts).toBe(1);
	});

	// The deadline races every attempt so an in-flight create cannot hold the open past the budget.
	it("fails at the deadline even when an in-flight attempt would block past it", async () => {
		vi.useFakeTimers();
		const inFlight = new Promise<string>(() => {});
		let attempts = 0;
		try {
			const opening = waitThroughDaemonUpdateRestart(
				async () => {
					attempts += 1;
					if (attempts === 1) throw new DaemonUpdateRestartingError();
					return inFlight;
				},
				{ waitMs: 60, retryMs: 5 },
			).then(
				() => "unexpectedly opened",
				(error: Error) => error.message,
			);
			await vi.advanceTimersByTimeAsync(60);
			expect(await opening).toMatch(updateRestartDeadline);
			expect(attempts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("agents view: closed subagents and stop-all", () => {
	function saved(
		path: string,
		overrides: Partial<AgentConnectionSavedSessionInfo> = {},
	): AgentConnectionSavedSessionInfo {
		return {
			path,
			id: `id-${path}`,
			cwd: "/tmp",
			parentSessionPath: "/tmp/root.jsonl",
			created: new Date(1_000),
			modified: new Date(2_000),
			messageCount: 2,
			firstMessage: "task",
			allMessagesText: "task",
			...overrides,
		};
	}

	it("finds a closed child's own saved transcript, not a grandchild's", () => {
		const pending = { childId: "sub-1", sessionDir: "/tmp/rlm/sub-1" };
		const opened = resolvePendingChildOpenSummary(
			pending,
			[],
			[
				saved("/tmp/rlm/sub-1/sub-9/grandchild.jsonl", { modified: new Date(9_000) }),
				saved("/tmp/rlm/sub-1/child.jsonl"),
			],
		);
		expect(opened?.sessionFile).toBe("/tmp/rlm/sub-1/child.jsonl");
		// No activeSessionId: opening it resumes (rehydrates) the saved child.
		expect(opened?.activeSessionId).toBeUndefined();
		// A child that is live again opens live.
		const live = summary({
			activeSessionId: "live-1",
			rlmChildId: "sub-1",
			sessionFile: "/tmp/rlm/sub-1/child.jsonl",
		});
		expect(resolvePendingChildOpenSummary(pending, [live], [])).toBe(live);
		expect(resolvePendingChildOpenSummary({ childId: "sub-2", sessionDir: "/tmp/rlm/sub-2" }, [live], [])).toBe(
			undefined,
		);
	});

	it("opens a closed child picked in the chat panel instead of saying it is gone", () => {
		const persistentState: AgentsViewPersistentState = {
			pendingOpenChild: { childId: "sub-1", sessionDir: "/tmp/rlm/sub-1" },
		};
		const self: Record<string, unknown> = {
			persistentState,
			rosterStore: { summaries: () => [] },
			savedSessions: [saved("/tmp/rlm/sub-1/child.jsonl")],
			savedCatalogReady: true,
		};
		const result = invoke("takePendingOpen", self) as { type: string; summary: SessionSummary } | undefined;
		expect(result?.type).toBe("open");
		expect(result?.summary.sessionFile).toBe("/tmp/rlm/sub-1/child.jsonl");
		expect(persistentState.statusMessage).toBeUndefined();

		// The catalog has not loaded yet: wait for it instead of giving up.
		const waiting: Record<string, unknown> = {
			persistentState: { pendingOpenChild: { childId: "sub-1", sessionDir: "/tmp/rlm/sub-1" } },
			rosterStore: { summaries: () => [] },
			savedSessions: [],
			savedCatalogReady: false,
		};
		expect(invoke("takePendingOpen", waiting)).toBeUndefined();
		expect(waiting.deferredChildOpen).toEqual({ childId: "sub-1", sessionDir: "/tmp/rlm/sub-1" });
	});

	it("stops every working subagent of the selected family after a confirming second press", async () => {
		const root = summary({ activeSessionId: "root-active", sessionId: "root-session", sessionName: "boss" });
		const running = summary({
			activeSessionId: "child-a",
			sessionId: "child-a-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "root-active",
			rlmChildId: "sub-a",
			isSessionActive: true,
		});
		const idle = summary({
			activeSessionId: "child-b",
			sessionId: "child-b-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "root-active",
			rlmChildId: "sub-b",
		});
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self: Record<string, unknown> = {
			rows: [{ kind: "agent", identity: "root", summary: root, runningSubagentCount: 1 }],
			selectedIndex: 0,
			lastListedSummaries: [root, running, idle],
			requireClient: () => ({ request }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			stopAllSubagentsRoot() {
				return invoke("stopAllSubagentsRoot", self);
			},
		};

		await invoke("handleStopAllSubagents", self);
		expect(request).not.toHaveBeenCalled();
		expect(self.setStatusMessage).toHaveBeenLastCalledWith(expect.stringContaining("全部 1 个在跑的子代理"), {
			tone: "warning",
		});

		await invoke("handleStopAllSubagents", self);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "sub-a",
		});
		expect(self.setStatusMessage).toHaveBeenLastCalledWith("已停止 1 个子代理");
	});
});
