import type { Usage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import { createSpendPricing, type SpendPriceRates } from "../src/core/spend-pricing.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { buildAgentsViewRows, collectSubagentDescendantSummaries } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import {
	buildSubagentPanelRows,
	collectSubtreeSubagentSnapshots,
	countRosterSubagentStatuses,
	countSubtreeSubagentStatuses,
	formatSubagentElapsed,
	isSettledSubagentPanelRow,
	isSubagentPanelRowFolded,
	SUBAGENT_PANEL_SETTLED_RETENTION_MS,
	type SubagentSpendSummary,
	SubagentSummaryLine,
	selectSubagentPanelRows,
	summarizeSubagentSpend,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

function rosterRow(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
	return {
		activeSessionId: overrides.id,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: `${overrides.id}-session`,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

/**
 * The spend-cell seam for fixtures that exercise the counts alone: the cell is
 * switched off, so a fixture never scans a context tree and never asserts on a figure
 * it did not set up. The cell's own behaviour has its own fixtures below.
 */
const spendCellOffUiServices = { settingsManager: { getSubagentSpendCellEnabled: () => false } };

describe("SubagentSummaryLine", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders nothing without children and a bordered agents tile with counts otherwise", () => {
		const line = new SubagentSummaryLine();
		expect(line.render(120)).toEqual([]);

		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		let rendered = line.render(120).map(stripAnsi);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("运行 1");
		expect(rendered[0]).toContain("运行 1");
		expect(rendered[0]).not.toContain("空闲");

		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		rendered = line.render(120).map(stripAnsi);
		expect(rendered[0]).toContain("运行 1 · 空闲 1");
		expect(rendered[0]).not.toContain("收口");
	});

	it("hints ↓ 选择 when unfocused and Enter/→ 打开 when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);

		expect(stripAnsi(line.render(120)[0])).toContain("↓ 选择");

		line.focused = true;
		const focused = stripAnsi(line.render(120)[0]);
		expect(focused).toContain("打开");
		expect(focused).not.toContain("↓ 选择");
	});

	it("keeps the selection background across truncation resets when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		line.focused = true;
		// Narrow enough that the colored counts truncate and inject a full reset.
		const content = line.render(20)[0];
		expect(content).toContain("\x1b[0m");
		for (const segment of content.split("\x1b[0m").slice(1, -1)) {
			expect(segment.startsWith("\x1b[4") || segment.startsWith("\x1b[10")).toBe(true);
		}
	});

	it("never emits lines wider than the allocated width", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		for (const width of [120, 40, 24, 12, 6, 3, 2, 1]) {
			for (const rendered of line.render(width).map(stripAnsi)) {
				expect(rendered.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("counts the whole subtree at any depth using running, idle, and inactive status projections", () => {
		const children = [
			child("running", "running"),
			child("queued", "queued"),
			child("active", "done", { activity: { kind: "writing" } }),
			child("heartbeat", "done", { activeSessionId: "heartbeat-session" }),
			child("idle-done", "done", { activeSessionId: "idle-done-session" }),
			child("idle-error", "error", { activeSessionId: "idle-error-session" }),
			child("inactive-done", "done"),
			child("inactive-error", "error"),
			child("cancelled", "cancelled"),
			child("grandchild", "running", { parentId: "running" }),
			child("great-grandchild", "done", { parentId: "grandchild", activeSessionId: "great-grandchild" }),
		];

		// The cancelled row is the only one left out; every depth counts.
		expect(countSubtreeSubagentStatuses(children, undefined)).toEqual({
			total: 10,
			running: 4,
			idle: 4,
			inactive: 2,
		});
	});

	it("keeps a grandchild reachable through a cancelled parent and does not re-walk a duplicated link", () => {
		const children = [
			child("cancelled-mid", "cancelled"),
			child("live-leaf", "running", { parentId: "cancelled-mid" }),
			child("other-root", "done"),
			child("dup", "running"),
			child("mid", "done", { parentId: "dup", activeSessionId: "mid" }),
			// A second row under the same id: the walk must not re-enter the branch it just left.
			child("dup", "running", { parentId: "mid" }),
		];

		expect(collectSubtreeSubagentSnapshots(children, undefined).map((snapshot) => snapshot.id)).toEqual([
			"other-root",
			"dup",
			"live-leaf",
			"mid",
		]);
		expect(countSubtreeSubagentStatuses(children, undefined)).toEqual({
			total: 4,
			running: 2,
			idle: 1,
			inactive: 1,
		});
	});

	it("opens on Enter or Right only when the daemon-backed line is selectable", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 2, running: 0, idle: 2, inactive: 0 });
		line.setOpenable(true);

		line.handleInput("\r");
		line.handleInput("\x1b[C");

		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("stays visible but non-selectable for an in-process connection", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setOpenable(false);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("收口 1");
		expect(line.isSelectable()).toBe(false);
		line.handleInput("\r");
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("updates the rendered counts from consecutive child-status events", () => {
		const line = new SubagentSummaryLine();
		line.setOpenable(true);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running"));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("运行 1");

		update.call(mode, child("worker", "done", { activeSessionId: "active-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("空闲 1");
	});

	it("counts a retained completed child as running while a follow-up turn is active", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("空闲 1");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker", activity: { kind: "waiting" } }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("运行 1");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("空闲 1");
	});

	it("refreshes counts when startup seeding follows an early live child update", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const worker = child("worker", "done", { parentId: "me" });
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
			this: typeof mode,
			children: readonly AgentConnectionRlmChildAgentSnapshot[],
		) => void;

		update.call(mode, worker);
		expect(line.render(100)).toEqual([]);
		Reflect.set(mode, "rlmNodeId", "me");
		seed.call(mode, [worker]);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("收口 1");
	});

	it("marks a stalled grandchild without needing it to be a direct child", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: "me",
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running", { parentId: "me", sessionName: "worker" }));
		update.call(
			mode,
			child("grandchild", "running", {
				parentId: "worker",
				sessionName: "grandchild",
				activity: { kind: "stalled" },
				stall: { silentMs: 90_000, thresholdMs: 60_000, inFlightTools: ["bash"] },
			}),
		);

		const rendered = stripAnsi(line.render(160).join("\n"));
		expect(rendered).toContain("运行 2");
		// The stalled grandchild gets its own row, marked 卡住 in the error color.
		const row = rendered.split("\n").find((text) => text.includes("grandchild"));
		expect(row).toContain("✗");
		expect(row).toContain("卡住");
	});

	it("keeps the stall marker of a stalled session that has no row of its own", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		line.setSubagentRows([{ id: "w", name: "worker", state: "running" }]);
		line.setStallMarkers(["worker: stalled 70s", "roster-only: stalled 90s, in-flight: bash"]);
		const rendered = stripAnsi(line.render(160).join("\n"));
		expect(rendered).toContain("roster-only: stalled 90s, in-flight: bash");
		expect(rendered).not.toContain("worker: stalled 70s");
	});

	it("clears a resident session id when a terminal update reports an evicted child", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		// Active partial updates retain the last known resident id.
		update.call(mode, child("worker", "running"));
		update.call(mode, child("worker", "done"));

		expect(stripAnsi(line.render(100).join("\n"))).toContain("收口 1");
	});

	it("removes a run on the producer's cancelled signal and keeps transcript-backed rows through repeated dones", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const snapshots = Reflect.get(mode, "subagentSnapshots") as Map<string, AgentConnectionRlmChildAgentSnapshot>;

		// A pre-bind failure arrives as cancelled: the queued row goes, never an inactive phantom.
		update.call(mode, child("never-bound", "queued"));
		update.call(mode, child("never-bound", "cancelled", { error: "boom" }));
		expect(snapshots.has("never-bound")).toBe(false);

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		update.call(mode, child("worker", "done"));
		update.call(mode, child("worker", "done"));
		expect(snapshots.has("worker")).toBe(true);
		expect(stripAnsi(line.render(100).join("\n"))).toContain("收口 1");
	});

	it("counts parentSessionId-only roster children exactly like the agents view", () => {
		const rosterChild = {
			id: "c1",
			sessionId: "c1",
			lifecycle: "live",
			runtimeKind: "subagent",
			rlmChildId: "c1",
			parentSessionId: "root-session",
			rosterStatus: "idle",
		} as SessionSummary;
		expect(collectSubagentDescendantSummaries([rosterChild], { sessionId: "root-session" })).toEqual([rosterChild]);
		expect(countRosterSubagentStatuses([rosterChild], { sessionId: "root-session" })).toEqual({
			total: 1,
			running: 0,
			idle: 1,
			inactive: 0,
		});
	});

	it("agrees with the agents view on the same roster input: one busy grandchild, one running", () => {
		const summaries = [
			rosterRow({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
			}),
			rosterRow({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
			}),
			rosterRow({
				id: "grandchild-active",
				activeSessionId: "grandchild-active",
				sessionId: "grandchild-session",
				sessionName: "Grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				activity: "working",
				isSessionActive: true,
			}),
		];

		// Reader 1: the agents view rolls a busy grandchild up to every idle ancestor.
		const viewRows = buildAgentsViewRows(summaries);
		expect(viewRows[0]).toMatchObject({ kind: "agent", runningSubagentCount: 1 });
		expect(viewRows[1]).toMatchObject({ kind: "subagent-summary", title: "1 subagent running" });

		// Reader 2: the tray counts the same subtree, so the two faces cannot disagree.
		expect(countRosterSubagentStatuses(summaries, { activeSessionId: "parent-active" })).toEqual({
			total: 2,
			running: 1,
			idle: 1,
			inactive: 0,
		});
	});

	it("counts a finished child that only hosts kernel background work as idle on both faces", () => {
		// Case linkrefund-post2-ds (2026-09-20): the child's turn ended, but its kernel still hosts
		// a live bash() handle, which summaryForActiveSession folds into isSessionActive (LIVE-1,
		// r44). The tray and the agents view read one formula, so both call it idle; the residency
		// fact is not lost, it is what the stop/delete gate reads instead.
		const summaries = [
			rosterRow({ id: "parent-active", sessionId: "parent-session", sessionName: "Parent" }),
			rosterRow({
				id: "hosting-child",
				sessionId: "hosting-child-session",
				sessionName: "Hosting child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				isSessionActive: true,
			}),
			// Positive control: a child mid-turn still counts as running on both faces.
			rosterRow({
				id: "working-child",
				sessionId: "working-child-session",
				sessionName: "Working child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "working",
				isSessionActive: true,
			}),
		];

		expect(countRosterSubagentStatuses(summaries, { activeSessionId: "parent-active" })).toEqual({
			total: 2,
			running: 1,
			idle: 1,
			inactive: 0,
		});
		const viewRows = buildAgentsViewRows(summaries);
		expect(viewRows[0]).toMatchObject({ kind: "agent", runningSubagentCount: 1 });
		expect(viewRows[1]).toMatchObject({ kind: "subagent-summary", title: "1 subagent running" });
	});

	it("keeps chat alive with the snapshot-fed bar when the roster subscribe fails", async () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			agentConnection: {
				subscribeAgentRoster: vi.fn(async () => {
					throw new Error("Daemon is stale");
				}),
			},
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			connectionState: undefined,
			scheduleHeartbeatManagerRefresh: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToRosterBar") as (
			this: typeof mode,
		) => Promise<void>;

		await expect(subscribe.call(mode)).resolves.toBeUndefined();
		expect(Reflect.get(mode, "rosterBar")).toBeUndefined();
	});

	it("turns a selection into the scoped agents-view run result", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			editor: { getText: () => "" },
			options: { returnToAgentsView: true },
			returnToAgentsView,
		});
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);
		line.onOpen = () => void open.call(mode);

		line.handleInput("\r");
		await vi.waitFor(() => expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view", undefined, {}));
	});

	it("opens the selected child itself when its row carries a daemon session", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, { editor: { getText: () => "" }, options: { returnToAgentsView: true }, returnToAgentsView });
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
			childActiveSessionId?: string,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		line.setSubagentRows(
			buildSubagentPanelRows(
				[
					child("a", "running", { activeSessionId: "active-a" }),
					child("b", "running", { activeSessionId: "active-b" }),
				],
				undefined,
			),
		);
		line.setOpenable(true);
		line.focused = true;
		line.onOpen = (row) => void open.call(mode, row?.activeSessionId);

		line.handleInput("\x1b[B");
		line.handleInput("\r");
		await vi.waitFor(() => expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view", "active-b", {}));
	});

	it("reopens a child the daemon closed by its identity, not a dead session id", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, { editor: { getText: () => "" }, options: { returnToAgentsView: true }, returnToAgentsView });
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
			childActiveSessionId?: string,
			row?: unknown,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		// A closed child's row: terminal and without a daemon session.
		line.setSubagentRows(buildSubagentPanelRows([child("closed", "done")], undefined));
		line.setOpenable(true);
		line.focused = true;
		line.onOpen = (row) => void open.call(mode, row?.activeSessionId, row);

		line.handleInput("\r");
		await vi.waitFor(() =>
			expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view", undefined, {
				openChild: { childId: "closed", sessionDir: "/tmp/closed" },
			}),
		);
	});

	it("stops every working subagent only after a confirming second press", async () => {
		const cancelRlmChild = vi.fn(async (_childId: string) => true);
		const showStatus = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map(
				[
					child("a", "running", { activeSessionId: "active-a" }),
					// A finished child busy with a follow-up counts: its turn is the spend.
					child("b", "done", { activeSessionId: "active-b", activity: { kind: "writing" } }),
					child("c", "done"),
				].map((snapshot) => [snapshot.id, snapshot]),
			),
			rlmNodeId: undefined,
			agentConnection: { cancelRlmChild },
			showStatus,
		});
		const request = Reflect.get(InteractiveMode.prototype, "requestStopAllSubagents") as (
			this: typeof mode,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.onStopAll = () => void request.call(mode);

		line.handleInput("\x1bx");
		await vi.waitFor(() => expect(showStatus).toHaveBeenCalledTimes(1));
		expect(showStatus.mock.calls[0]?.[0]).toContain("停止全部 2 个在跑的子代理");
		expect(cancelRlmChild).not.toHaveBeenCalled();

		line.handleInput("\x1bx");
		await vi.waitFor(() => expect(showStatus).toHaveBeenCalledTimes(2));
		expect(cancelRlmChild.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
		expect(showStatus.mock.calls[1]?.[0]).toBe("已停止全部 2 个在跑的子代理");
	});

	it("sends the viewer of a closed subagent back to its parent with a Chinese notice", () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, { options: { returnToAgentsView: true, sessionDepth: 1 }, returnToAgentsView });
		const onClosed = Reflect.get(InteractiveMode.prototype, "returnToParentAfterSubagentClosed") as (
			this: typeof mode,
			reason: string | undefined,
		) => boolean;

		expect(onClosed.call(mode, "killed")).toBe(true);
		expect(returnToAgentsView).toHaveBeenLastCalledWith("agents_view", undefined, {
			returnToParentNotice: expect.stringContaining("已回到父代理"),
		});
		// A child that died on an error is not reported as finished.
		Object.assign(mode, { lastAssistantStopReason: "error" });
		expect(onClosed.call(mode, "completed")).toBe(true);
		expect(returnToAgentsView).toHaveBeenLastCalledWith("agents_view", undefined, {
			returnToParentNotice: expect.stringContaining("出错停下了"),
		});
		// A daemon restart, or a top-level session, keeps the connection's own handling.
		expect(onClosed.call(mode, "update")).toBe(false);
		Object.assign(mode, { options: { returnToAgentsView: true, sessionDepth: 0 } });
		expect(onClosed.call(mode, "killed")).toBe(false);
		expect(returnToAgentsView).toHaveBeenCalledTimes(2);
	});

	it("exposes one click region per shown row plus the header only when openable", () => {
		const empty = new SubagentSummaryLine();
		expect(empty.render(100)).toEqual([]);
		expect(empty.getClickRegions()).toHaveLength(0);

		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 0, inactive: 1 });
		line.setSubagentRows([
			{ id: "worker", name: "worker", state: "running" },
			{ id: "review", name: "review", state: "failed" },
		]);
		// Rows stay clickable even in a no-daemon session: the detail card is rendered locally.
		line.render(100);
		let regions = [...line.getClickRegions()];
		expect(regions.map((region) => region.line)).toEqual([1, 2]);
		for (const region of regions) {
			expect(region).toMatchObject({ col: 0, width: 100, height: 1 });
		}

		line.setOpenable(true);
		line.render(100);
		regions = [...line.getClickRegions()];
		expect(regions.map((region) => region.line)).toEqual([0, 1, 2]);
	});

	it("a row click selects that row and fires onRowActivate with it", () => {
		const line = new SubagentSummaryLine();
		const activated: string[] = [];
		line.onRowActivate = (row) => activated.push(row.id);
		line.setSubagentCounts({ total: 2, running: 1, idle: 0, inactive: 1 });
		line.setSubagentRows([
			{ id: "worker", name: "worker", state: "running" },
			{ id: "调研-云厂商", name: "调研-云厂商", state: "failed" },
		]);
		line.focused = true;
		line.render(100);
		// A Chinese name renders in the row (naming guidance) and is clickable.
		expect(line.render(100).map(stripAnsi).join("\n")).toContain("调研-云厂商");

		const cjkRegion = line.getClickRegions()[1];
		cjkRegion?.onClick({ row: 0, col: 5 });
		expect(activated).toEqual(["调研-云厂商"]);

		// The pointer selection is the keyboard selector: › moved to the clicked row.
		const rendered = line.render(100).map(stripAnsi);
		expect(rendered[1]).not.toContain("›");
		expect(rendered[2]).toContain("›");
	});

	it("scrolls every child into view while focused, not just the first four", () => {
		const line = new SubagentSummaryLine();
		const rows = Array.from({ length: 7 }, (_, i) => ({
			id: `child-${i}`,
			name: `child-${i}`,
			state: "running" as const,
		}));
		line.setSubagentCounts({ total: 7, running: 7, idle: 0, inactive: 0 });
		line.setSubagentRows(rows);
		line.focused = true;

		const shown = () => line.render(100).map(stripAnsi).join("\n");
		expect(shown()).toContain("child-0");
		expect(shown()).not.toContain("child-6");
		// Focused, the fold line promises more rows below instead of hiding them.
		expect(shown()).toContain("下面还有");

		// Six downs walk the selection to the last child and the window follows it.
		for (let i = 0; i < 6; i += 1) line.handleInput("\x1b[B");
		expect(shown()).toContain("child-6");
		expect(shown()).not.toContain("child-0");

		for (let i = 0; i < 6; i += 1) line.handleInput("\x1b[A");
		expect(shown()).toContain("child-0");
	});
});

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** Usage with all four billed fields and a recorded total, for the price-override pins. */
function usageWithCache(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function tree(
	root: Usage,
	children: ContextTreeNode[],
	model: { provider: string; id: string } | undefined = { provider: "bailian", id: "deepseek-v4.1-flash" },
): ContextTreeNode {
	return { id: "root", label: "main agent", status: "active", model, ownUsage: root, totalUsage: root, children };
}

function agent(id: string, own: Usage, model: { provider: string; id: string } | undefined): ContextTreeNode {
	return { id, label: id, status: "done", model, ownUsage: own, totalUsage: own, children: [] };
}

function spend(summary: Partial<SubagentSpendSummary>): SubagentSpendSummary {
	return {
		cost: 0,
		tokens: 0,
		parentCost: 0,
		unpriced: [],
		partial: false,
		...summary,
	};
}

describe("subagent spend cell", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const pricedEverywhere = () => true;

	it("sums own usage over the whole tree except the root, so attributions are not double-counted", () => {
		// The root's ownUsage excludes child attributions; each descendant counts
		// once at its own node, so the fold equals /usage's "Total" minus the root.
		const summary = summarizeSubagentSpend(
			tree(usage(1_000, 500, 0.5), [
				agent("sub-1", usage(2_000, 1_000, 1.2), { provider: "bailian", id: "qwen3.8-flash" }),
				agent("sub-2", usage(1_500, 750, 0.45), { provider: "bailian", id: "qwen3.8-flash" }),
			]),
			pricedEverywhere,
		);
		expect(summary.cost).toBe(1.65);
		expect(summary.tokens).toBe(5_250);
		expect(summary.parentCost).toBe(0.5);
		expect(summary.unpriced).toEqual([]);
		expect(summary.partial).toBe(false);
	});

	it("counts descendants, not just direct children", () => {
		const grandchild = agent("sub-sub", usage(500, 250, 0.3), { provider: "bailian", id: "qwen3.8-flash" });
		const child = {
			...agent("sub-1", usage(2_000, 1_000, 1.2), { provider: "bailian", id: "qwen3.8-flash" }),
			children: [grandchild],
		};
		const summary = summarizeSubagentSpend(tree(usage(1_000, 500, 0.5), [child]), pricedEverywhere);
		expect(summary.cost).toBe(1.5);
		expect(summary.tokens).toBe(3_750);
	});

	it("flags unpriced models with their tokens instead of silently summing them as free", () => {
		const summary = summarizeSubagentSpend(
			tree(usage(100, 50, 0.05), [
				agent("sub-kimi", usage(8_100_000, 100_000, 0), { provider: "bailian", id: "kimi-k3" }),
				agent("sub-qwen", usage(1_000_000, 230_000, 0.34), { provider: "bailian", id: "qwen3.8-flash" }),
			]),
			(model) => model.id !== "kimi-k3",
		);
		expect(summary.cost).toBe(0.34);
		expect(summary.tokens).toBe(9_430_000);
		expect(summary.unpriced).toEqual([{ model: "kimi-k3", tokens: 8_200_000 }]);
	});

	it("treats a node that already earned cost as priced, whatever its recorded model says", () => {
		const summary = summarizeSubagentSpend(
			tree(usage(100, 50, 0.05), [agent("sub-legacy", usage(2_000, 1_000, 1.2), undefined)]),
			() => false,
		);
		expect(summary.cost).toBe(1.2);
		expect(summary.unpriced).toEqual([]);
	});

	it("marks a budget-truncated tree as a lower bound", () => {
		const truncated = {
			...tree(usage(100, 50, 0.05), []),
			scan: {
				scannedChildren: 256,
				bytesRead: 64 * 1024 * 1024,
				bytesPlanned: 64 * 1024 * 1024,
				skippedByBudget: 42,
				depthLimitReached: false,
				truncated: true,
				truncatedReason: "children" as const,
			},
		};
		const summary = summarizeSubagentSpend(truncated, pricedEverywhere);
		expect(summary.partial).toBe(true);
	});

	it("renders the spend total in the counts row with money first and the mother total second", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));

		const body = stripAnsi(line.render(120)[0]);
		expect(body).toContain("¥4.56 · 12M tok ｜ 全部 ¥5.10");
		expect(body).toContain("运行 1 · 空闲 1");
	});

	it("keeps the cell blank for an all-zero summary and never shows ¥0.00", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 0, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({}));
		expect(stripAnsi(line.render(120)[0])).not.toContain("¥");

		// An all-unpriced family: tokens plus the warning, no ¥0.00 figure.
		line.setSubagentSpend(spend({ tokens: 8_100_000, unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] }));
		const body = stripAnsi(line.render(120)[0]);
		expect(body).toContain("8.1M tok (kimi-k3 8.1M tok 未定价)");
		expect(body).not.toContain("¥");
	});

	it("marks partial-tree figures as lower bounds and warns in the theme warning color", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setSubagentSpend(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				partial: true,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		);
		const body = stripAnsi(line.render(120)[0]);
		expect(body).toContain("≈¥4.56 · ≈12M tok ｜ 全部 ≈¥5.10");
		const raw = line.render(120)[0];
		expect(raw).toContain(theme.fg("warning", "(kimi-k3 8.1M tok 未定价)"));
		expect(raw).toContain(theme.fg("accent", "¥4.56"));
	});

	it("degrades in a fixed order at narrow widths and never pushes the select hint out", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setSubagentSpend(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		);
		line.setOpenable(true);

		// 110: everything fits.
		const wide = stripAnsi(line.render(110)[0]);
		expect(wide).toContain("¥4.56 · 12M tok ｜ 全部 ¥5.10 (kimi-k3 8.1M tok 未定价)");
		// 95: the 全部 figure is the first cut.
		const medium = stripAnsi(line.render(95)[0]);
		expect(medium).toContain("¥4.56 · 12M tok");
		expect(medium).not.toContain("全部 ¥");
		expect(medium).toContain("(kimi-k3 8.1M tok 未定价)");
		// 85: then the annotation's token counts.
		const annotationlessTokens = stripAnsi(line.render(85)[0]);
		expect(annotationlessTokens).toContain("(kimi-k3 未定价)");
		expect(annotationlessTokens).not.toContain("8.1M");
		// 70: annotation gone, primary survives.
		const narrow = stripAnsi(line.render(70)[0]);
		expect(narrow).toContain("¥4.56 · 12M tok");
		expect(narrow).not.toContain("未定价");
		// 55: with three count groups there is no room; the cell is dropped, never half-truncated.
		const tight = stripAnsi(line.render(55)[0]);
		expect(tight).not.toContain("¥");
		expect(tight).toContain("↓ 选择");
		for (const width of [110, 95, 85, 70, 55]) {
			const body = stripAnsi(line.render(width)[0]);
			expect(body).toContain("↓ 选择");
			expect(visibleWidth(line.render(width)[0])).toBeLessThanOrEqual(width);
		}
	});

	it("does not move the open hint or change the line width when figures grow", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 999_000, parentCost: 0.2 }));
		line.setOpenable(true);
		const before = stripAnsi(line.render(120)[0]);
		const beforeRaw = line.render(120)[0];

		line.setSubagentSpend(spend({ cost: 12.34, tokens: 1_020_000, parentCost: 1.2 }));
		const after = stripAnsi(line.render(120)[0]);
		const afterRaw = line.render(120)[0];

		expect(before).toContain("¥4.56");
		expect(after).toContain("¥12.34");
		// Line length is padded to the inner width and the hint is right-anchored:
		// growth only eats the blank gap between them.
		expect(before.length).toBe(after.length);
		expect(before.indexOf("↓ 选择")).toBe(after.indexOf("↓ 选择"));
		expect(visibleWidth(beforeRaw)).toBe(visibleWidth(afterRaw));
	});

	it("keeps the spend colors readable over the selection background when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));
		line.setOpenable(true);
		line.focused = true;

		const content = line.render(100)[0];
		expect(content).toContain(theme.fg("accent", "¥4.56"));
		expect(content).toContain(theme.fg("dim", "全部 ¥5.10"));
		// The selection background wraps the whole row (also across the fg resets
		// the spend segment emits, which never clear the background).
		const selectedBg = theme.bg("selectedBg", "");
		expect(content).toContain(selectedBg.slice(0, selectedBg.indexOf("\x1b[49m")));
		expect(stripAnsi(content)).toContain("¥4.56 · 12M tok ｜ 全部 ¥5.10");
	});

	/**
	 * A mode whose agent connection is a spend-cell fixture: the real
	 * `scheduleSubagentSpendRefresh` / `refreshSubagentSpend` / idle-tick code runs,
	 * only the connection and the settings manager are stand-ins.
	 *
	 * `stubIdleTick` replaces the tick arm/disarm with spies, which isolates the
	 * event-driven cadence from the heartbeat (both are real in the default).
	 */
	function createSpendMode(
		options: {
			contextTree?: ContextTreeNode;
			getContextTree?: () => Promise<ContextTreeNode>;
			spendCellEnabled?: boolean;
			total?: number;
			suspended?: boolean;
			stubIdleTick?: boolean;
			/** `ui.subagentSpendCell.intervalMs`; undefined = the tree's own default (15s). */
			intervalMs?: number;
			/** Model rates lookup behind the unpriced annotation; undefined = an unpriced model. */
			modelCost?: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
			/** `ui.subagentSpendCell.priceOverrides`; absent = nothing overridden. */
			priceOverrides?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
		} = {},
	) {
		const line = new SubagentSummaryLine();
		const setSpend = vi.spyOn(line, "setSubagentSpend");
		const getContextTree = vi.fn(
			options.getContextTree ?? (async () => options.contextTree ?? tree(usage(0, 0, 0), [])),
		);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			subagentCounts: { total: options.total ?? 1, running: options.total ?? 1, idle: 0, inactive: 0 },
			terminalSuspended: options.suspended ?? false,
			uiServices: {
				// The real seam: InteractiveMode reads the settings manager and the model
				// registry from here.
				settingsManager: {
					getSubagentSpendCellEnabled: () => options.spendCellEnabled ?? true,
					getSubagentSpendCellIntervalMs: () => options.intervalMs ?? 15_000,
					getSubagentSpendCellPriceOverrides: () => options.priceOverrides ?? {},
				},
				modelRegistry: { find: vi.fn(() => (options.modelCost ? { cost: options.modelCost } : undefined)) },
			},
			agentConnection: { getContextTree },
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
			...(options.stubIdleTick ? { startSubagentSpendIdleTick: vi.fn(), stopSubagentSpendIdleTick: vi.fn() } : {}),
		});
		const schedule = Reflect.get(InteractiveMode.prototype, "scheduleSubagentSpendRefresh") as (
			this: typeof mode,
			force?: boolean,
		) => void;
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		return { mode, line, setSpend, getContextTree, schedule, update };
	}

	it("a burst of child updates arms no scan of its own", async () => {
		vi.useFakeTimers();
		try {
			// The tick is stubbed so the count is the event-driven cadence alone. This is
			// the regression pin for the removed behaviour: the cell used to schedule a
			// context-tree scan from every rlm_child_update (a working family emits them
			// continuously, so a scan followed every burst).
			const { mode, getContextTree, update, schedule } = createSpendMode({ stubIdleTick: true });

			const burst = (): void => {
				for (let index = 0; index < 50; index++) {
					update.call(mode, child("worker", "running", { activity: { kind: "executing" } }));
					update.call(mode, child("worker", "running", { activity: { kind: "writing" } }));
				}
			};
			burst();
			await vi.advanceTimersByTimeAsync(600);
			// Exactly one scan: the leading one that first fills the cell in.
			expect(getContextTree).toHaveBeenCalledTimes(1);

			// Further updates never rescan: the figure is already on screen.
			burst();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(getContextTree).toHaveBeenCalledTimes(1);

			// The event-driven paths that remain: a landed assistant message, and the turn
			// end (forced, so it skips the debounce and the floor).
			schedule.call(mode);
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(2);
			schedule.call(mode, true);
			await vi.advanceTimersByTimeAsync(0);
			expect(getContextTree).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a visible cell fresh on the idle tick, and stops ticking once it is off screen", async () => {
		vi.useFakeTimers();
		try {
			const { mode, setSpend, getContextTree, update } = createSpendMode({
				contextTree: tree(usage(1_000, 500, 0.5), [agent("sub-1", usage(2_000, 1_000, 1.2), undefined)]),
			});

			// First sight of a family fills the cell in (debounced), then the tick runs.
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(1);
			expect(setSpend).toHaveBeenCalled();

			// A quiet minute: one scan per 15s tick, nothing per event (there are none).
			await vi.advanceTimersByTimeAsync(60_000);
			expect(getContextTree).toHaveBeenCalledTimes(5);

			// No family left: the tick stops, the figure blanks, and nothing scans again.
			// (A cancelled child is dropped from the snapshots, so the counts really do go
			// to zero - a `done` child stays in the family as an inactive row.)
			update.call(mode, child("worker", "cancelled"));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(getContextTree).toHaveBeenCalledTimes(5);
			expect(setSpend).toHaveBeenLastCalledWith(undefined);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not scan or render a figure while the cell is switched off or the terminal is suspended", async () => {
		vi.useFakeTimers();
		try {
			const off = createSpendMode({ spendCellEnabled: false });
			off.update.call(off.mode, child("worker", "running"));
			off.schedule.call(off.mode);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(off.getContextTree).not.toHaveBeenCalled();
			expect(off.setSpend).toHaveBeenCalledWith(undefined);

			const suspended = createSpendMode({ suspended: true });
			suspended.update.call(suspended.mode, child("worker", "running"));
			suspended.schedule.call(suspended.mode, true);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(suspended.getContextTree).not.toHaveBeenCalled();
			expect(suspended.setSpend).toHaveBeenCalledWith(undefined);
		} finally {
			vi.useRealTimers();
		}
	});

	it("catches a stale figure up on the next event instead of waiting out the tick", async () => {
		vi.useFakeTimers();
		try {
			// The tick is stubbed so the count is the event-driven cadence alone.
			const { mode, getContextTree, update } = createSpendMode({
				stubIdleTick: true,
				contextTree: tree(usage(1_000, 500, 0.5), [agent("sub-1", usage(2_000, 1_000, 1.2), undefined)]),
			});

			// First sight of a family fills the cell in.
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(1);

			// While the figure is inside its cadence, events still scan nothing.
			await vi.advanceTimersByTimeAsync(10_000);
			update.call(mode, child("worker", "running", { activity: { kind: "executing" } }));
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(1);

			// Past it, the very next event catches up - no timer-driven scan is added -
			// and the age it just reset is what rations the following events.
			await vi.advanceTimersByTimeAsync(5_000);
			update.call(mode, child("worker", "running", { activity: { kind: "writing" } }));
			await vi.advanceTimersByTimeAsync(0);
			expect(getContextTree).toHaveBeenCalledTimes(2);
			update.call(mode, child("worker", "running", { activity: { kind: "executing" } }));
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("follows ui.subagentSpendCell.intervalMs for the idle tick", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createSpendMode({
				intervalMs: 5_000,
				contextTree: tree(usage(1_000, 500, 0.5), [agent("sub-1", usage(2_000, 1_000, 1.2), undefined)]),
			});
			const scanStamps: number[] = [];
			const implementation = getContextTree.getMockImplementation() as () => Promise<ContextTreeNode>;
			getContextTree.mockImplementation(async () => {
				scanStamps.push(Date.now());
				return await implementation();
			});

			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(600);
			expect(scanStamps).toHaveLength(1);

			// Twenty seconds at a 5s cadence: four more ticks. The tick is anchored to when it
			// was armed, so the first gap is shortened by the leading fill's debounce; from the
			// second tick on, every gap is the configured cadence.
			await vi.advanceTimersByTimeAsync(20_000);
			expect(scanStamps).toHaveLength(5);
			const tickGaps = scanStamps.slice(2).map((stamp, index) => stamp - scanStamps[index + 1]);
			expect(tickGaps).toHaveLength(3);
			for (const gap of tickGaps) {
				expect(gap).toBeGreaterThanOrEqual(4_950);
				expect(gap).toBeLessThanOrEqual(5_050);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs the cadence off after a heavy scan, keeping the fast cadence for light ones", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, schedule } = createSpendMode({
				stubIdleTick: true,
				contextTree: tree(usage(1_000, 500, 0.5), [agent("sub-1", usage(2_000, 1_000, 1.2), undefined)]),
			});

			// Light scan (a few ms): the burst's leading scan lands after the debounce.
			schedule.call(mode);
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(1);

			// Sustained requests hold to the 5s floor from that scan.
			schedule.call(mode);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(getContextTree).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(getContextTree).toHaveBeenCalledTimes(2);

			// A heavy last scan backs the floor off to 15s: 5s of silence must not rescan,
			// and the wait past it must.
			const beforeHeavy = getContextTree.mock.calls.length;
			Reflect.set(mode, "subagentSpendLastScanMs", 320);
			schedule.call(mode);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(getContextTree).toHaveBeenCalledTimes(beforeHeavy);
			await vi.advanceTimersByTimeAsync(11_000);
			expect(getContextTree).toHaveBeenCalledTimes(beforeHeavy + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes the cell from the context tree on a scheduled refresh, and blanks it when the family is gone", async () => {
		const contextTree = tree(usage(1_000, 500, 0.5), [
			agent("sub-1", usage(2_000, 1_000, 0), { provider: "bailian", id: "kimi-k3" }),
		]);
		const { mode, setSpend, update, schedule } = createSpendMode({
			contextTree,
			getContextTree: async () => contextTree,
			modelCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});

		update.call(mode, child("worker", "running"));
		schedule.call(mode);
		await vi.waitFor(
			() => {
				expect(setSpend).toHaveBeenCalled();
			},
			{ timeout: 5_000 },
		);
		// kimi-k3 has no rates, so its tokens are flagged instead of priced.
		expect(setSpend.mock.calls.at(-1)?.[0]).toEqual({
			cost: 0,
			tokens: 3_000,
			parentCost: 0.5,
			unpriced: [{ model: "kimi-k3", tokens: 3_000 }],
			partial: false,
		});

		// A family that goes away blanks the cell rather than freezing a stale figure.
		setSpend.mockClear();
		Reflect.set(mode, "subagentCounts", { total: 0, running: 0, idle: 0, inactive: 0 });
		schedule.call(mode);
		expect(setSpend).toHaveBeenCalledWith(undefined);
	});

	it("prices the cell from ui.subagentSpendCell.priceOverrides, and keeps a rate-less model billable", async () => {
		// models.json has no rates for kimi-k3 (an all-zero cost block), so without the
		// override its million tokens would be flagged unpriced instead of costing anything.
		const contextTree = tree(usage(100, 50, 0.05), [
			agent("sub-1", usage(1_000_000, 0, 0), { provider: "bailian", id: "kimi-k3" }),
		]);
		const { mode, setSpend, update, schedule } = createSpendMode({
			contextTree,
			getContextTree: async () => contextTree,
			modelCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			priceOverrides: { "bailian/kimi-k3": { input: 3, output: 15 } },
		});

		update.call(mode, child("worker", "running"));
		schedule.call(mode, true);
		await vi.waitFor(
			() => {
				expect(setSpend).toHaveBeenCalled();
			},
			{ timeout: 5_000 },
		);
		// The settings reached the pricing point: 1M input at the corrected 3, the
		// recorded money for that model (0) replaced rather than added to.
		expect(setSpend.mock.calls.at(-1)?.[0]).toEqual({
			cost: 3,
			tokens: 1_000_000,
			parentCost: 0.05,
			unpriced: [],
			overridePriced: [{ model: "kimi-k3", tokens: 1_000_000 }],
			partial: false,
		});
	});
});

/**
 * The cell's pricing取数点: `ui.subagentSpendCell.priceOverrides` first,
 * models.json second. A wrong rate in models.json is what the boss could not fix
 * from inside the app, so these pins are about the figure actually moving - and
 * about a model nobody corrected keeping the money already recorded on it.
 */
describe("spend price overrides", () => {
	/** The models.json rates every fixture model is billed at unless a test says otherwise. */
	const MODELS_JSON_RATES: SpendPriceRates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 };

	function pricing(
		overrides: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>,
	) {
		return createSpendPricing({ overrides, ratesFor: () => MODELS_JSON_RATES });
	}

	const kimi = { provider: "bailian", id: "kimi-k3" };

	it("re-prices an overridden model from its tokens, so a corrected input rate moves Σ", () => {
		// Recorded money says input billed at models.json's 1: 1M in + 1M out + 1M
		// read = 3.5. The override says the input rate was really 7.
		const contextTree = tree(usage(100, 50, 0.05), [
			agent("sub-1", usageWithCache(1_000_000, 1_000_000, 1_000_000, 0, 3.5), kimi),
		]);

		const untouched = summarizeSubagentSpend(contextTree, () => true, pricing({}));
		expect(untouched.cost).toBe(3.5);
		expect(untouched.overridePriced).toBeUndefined();

		const corrected = summarizeSubagentSpend(contextTree, () => true, pricing({ "bailian/kimi-k3": { input: 7 } }));
		// 1M at 7 + 1M at models.json's 2 + 1M at 0.5.
		expect(corrected.cost).toBe(9.5);
		expect(corrected.overridePriced).toEqual([{ model: "kimi-k3", tokens: 3_000_000 }]);
		// The mother's own money is not this cell's business unless its model is
		// overridden too - the child's correction must not leak into it.
		expect(corrected.parentCost).toBe(0.05);
	});

	it("leaves every model nobody corrected on the money recorded on its messages", () => {
		const other = { provider: "bailian", id: "qwen3.8-flash" };
		const contextTree = tree(usage(100, 50, 0.05), [
			agent("sub-1", usageWithCache(1_000_000, 1_000_000, 0, 0, 3), kimi),
			agent("sub-2", usageWithCache(1_000_000, 1_000_000, 0, 0, 3), other),
		]);

		const summary = summarizeSubagentSpend(contextTree, () => true, pricing({ "bailian/kimi-k3": { input: 7 } }));
		// sub-1 re-priced to 9, sub-2 keeps its recorded 3: an override is per model,
		// and re-pricing a model nobody complained about would invent a figure.
		expect(summary.cost).toBe(12);
		expect(summary.overridePriced).toEqual([{ model: "kimi-k3", tokens: 2_000_000 }]);
	});

	it("takes the fields an override leaves out from models.json, not from zero", () => {
		const contextTree = tree(usage(0, 0, 0), [
			agent("sub-1", usageWithCache(1_000_000, 1_000_000, 1_000_000, 1_000_000, 3.5), kimi),
		]);

		const summary = summarizeSubagentSpend(contextTree, () => true, pricing({ "bailian/kimi-k3": { input: 7 } }));
		// input 7 (override) + output 2 + cacheRead 0.5 + cacheWrite 4 (models.json).
		expect(summary.cost).toBe(13.5);
	});

	it("marks the re-priced model in the cell, and drops the marker before the figure", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 0, idle: 1, inactive: 0 });
		line.setSubagentSpend(
			spend({
				cost: 9,
				tokens: 2_000_000,
				overridePriced: [{ model: "kimi-k3", tokens: 2_000_000 }],
			}),
		);

		const wide = stripAnsi(line.render(120)[0]);
		expect(wide).toContain("¥9.00 · 2.0M tok ｜ 全部 ¥9.00 (kimi-k3 2.0M tok 已改价)");
		expect(line.render(120)[0]).toContain(theme.fg("accent", "(kimi-k3 2.0M tok 已改价)"));

		// The marker degrades with the rest of the annotation, and a truncated money
		// figure is never shown: the cell drops whole rungs, it does not ellipsize.
		const narrow = stripAnsi(line.render(50)[0]);
		expect(narrow).toContain("¥9.00 · 2.0M tok");
		expect(narrow).not.toContain("已改价");
		for (const width of [120, 100, 80, 70, 60, 50]) {
			expect(visibleWidth(line.render(width)[0])).toBeLessThanOrEqual(width);
		}
	});
});

describe("subagent panel rows (design board 06)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const rows = [
		{ id: "a", name: "review", state: "running" as const, elapsedMs: 134_000, activity: "读取 footer.ts" },
		{ id: "b", name: "docs", state: "running" as const, elapsedMs: 41_000, activity: "编辑 FORK_NOTES.md" },
		{ id: "c", name: "lint", state: "done" as const, elapsedMs: 62_000, activity: "无问题" },
	];

	function panel(): SubagentSummaryLine {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 2, idle: 0, inactive: 1 });
		line.setSubagentRows(rows);
		line.setOpenable(true);
		return line;
	}

	it("renders a rule header then one row per child with state glyph, name column, state and activity", () => {
		const lines = panel().render(100).map(stripAnsi);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^ 子代理 3 {2}运行 2 · 收口 1 ─+ ↓ 选择 ─ *$/);
		expect(lines[1]).toBe("   ● review   运行 2:14    读取 footer.ts");
		expect(lines[2]).toBe("   ● docs     运行 0:41    编辑 FORK_NOTES.md");
		expect(lines[3]).toBe("   ✓ lint     完成 1:02    无问题");
	});

	it("moves a › selector over the rows while focused and shows the row action", () => {
		const line = panel();
		line.focused = true;
		let lines = line.render(100).map(stripAnsi);
		expect(lines[1]?.startsWith(" › ● review")).toBe(true);
		expect(lines[1]?.trimEnd().endsWith("Enter 打开")).toBe(true);
		expect(lines[0]).not.toContain("选择");
		line.handleInput("\x1b[B");
		lines = line.render(100).map(stripAnsi);
		expect(lines[1]?.startsWith("   ● review")).toBe(true);
		expect(lines[2]?.startsWith(" › ● docs")).toBe(true);
		const onCancel = vi.fn();
		line.onCancel = onCancel;
		line.handleInput("\x1b[A");
		expect(onCancel).not.toHaveBeenCalled();
		expect(stripAnsi(line.render(100)[1] ?? "").startsWith(" › ● review")).toBe(true);
		line.handleInput("\x1b[A");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("folds rows past four into a count row and drops stall marker lines while rows carry the state", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 6, running: 6, idle: 0, inactive: 0 });
		line.setSubagentRows(
			Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `w${index}`, state: "running" as const })),
		);
		line.setStallMarkers(["w0: stalled 30s"]);
		const lines = line.render(80).map(stripAnsi);
		expect(lines).toHaveLength(6);
		expect(lines[5]).toBe("   … 还有 2 个");
		expect(lines.join("\n")).not.toContain("⚠");
	});

	it("scrolls the focused selection through every row past the fold and opens the one selected", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 6, running: 6, idle: 0, inactive: 0 });
		line.setSubagentRows(
			Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `w${index}`, state: "running" as const })),
		);
		line.setOpenable(true);
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.focused = true;
		let lines = line.render(80).map(stripAnsi);
		expect(lines.at(-1)).toBe("   ↓ 下面还有 2 个");

		for (let press = 0; press < 5; press++) line.handleInput("\x1b[B");
		lines = line.render(80).map(stripAnsi);
		// Header, the fold above, then the last four rows with w5 selected; nothing below.
		expect(lines).toHaveLength(6);
		expect(lines[1]).toBe("   ↑ 上面还有 2 个");
		expect(lines.slice(2).map((text) => text.match(/w\d/)?.[0])).toEqual(["w2", "w3", "w4", "w5"]);
		expect(lines[5]?.startsWith(" › ● w5")).toBe(true);
		expect(lines.join("\n")).not.toContain("下面还有");
		// The last row is the floor: another ↓ stays on it.
		line.handleInput("\x1b[B");
		line.handleInput("\r");
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "c5", name: "w5" }));

		// Moving up inside the window leaves it where it is.
		for (let press = 0; press < 3; press++) line.handleInput("\x1b[A");
		lines = line.render(80).map(stripAnsi);
		expect(lines[1]).toBe("   ↑ 上面还有 2 个");
		expect(lines[2]?.startsWith(" › ● w2")).toBe(true);
		// Past its top edge, the window follows.
		line.handleInput("\x1b[A");
		lines = line.render(80).map(stripAnsi);
		expect(lines[1]).toBe("   ↑ 上面还有 1 个");
		expect(lines[2]?.startsWith(" › ● w1")).toBe(true);
		expect(lines.at(-1)).toBe("   ↓ 下面还有 1 个");
	});

	it("folds an all-idle family to one line until the panel is focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 6, running: 0, idle: 5, inactive: 1 });
		line.setSubagentRows([
			...Array.from({ length: 5 }, (_, index) => ({
				id: `i${index}`,
				name: `vps-${index}`,
				state: "idle" as const,
			})),
			{ id: "d", name: "vps-done", state: "done" as const },
		]);
		line.setOpenable(true);
		let lines = line.render(100).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("↓ 选择");
		expect(lines[1]).toBe("   都做完了，闲置一阵后会自动关闭（记录保留）");
		// Focused, every child is listed again and reachable.
		line.focused = true;
		lines = line.render(100).map(stripAnsi);
		expect(lines[1]?.startsWith(" › ○ vps-0")).toBe(true);
		expect(lines.at(-1)).toBe("   ↓ 下面还有 2 个");
		// One child still working keeps the rows up.
		line.focused = false;
		line.setSubagentRows([
			{ id: "r", name: "vps-run", state: "running" as const },
			{ id: "i0", name: "vps-0", state: "idle" as const },
		]);
		expect(line.render(100).map(stripAnsi)[1]).toContain("vps-run");
	});

	it("stops promising an idle close once every child is closed", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 0, idle: 0, inactive: 2 });
		line.setSubagentRows(buildSubagentPanelRows([child("a", "done"), child("b", "done")], undefined));
		line.setOpenable(true);
		expect(line.render(100).map(stripAnsi)[1]).toBe("   都做完了，已自动关闭（记录保留）");
	});

	it("lets a failure the parent already received fold with the finished rows", () => {
		const children = [
			child("old", "error", { error: "provider down" }),
			child("retry", "done"),
			child("other", "done", { activeSessionId: "active-other" }),
		];
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 0, idle: 1, inactive: 2 });
		line.setOpenable(true);
		// Not seen yet: the failure holds the panel open. The v2 recency order
		// (5c717491c, PM 2026-09-25 最新工作流要提前) groups the fresh failure with
		// the settled rows instead of the top, so pin visibility (the row is
		// rendered, the panel did not fold) rather than rank.
		line.setSubagentRows(buildSubagentPanelRows(children, undefined));
		const unseen = line.render(100).map(stripAnsi).join("\n");
		expect(unseen).toContain("old");
		expect(unseen).not.toContain("都结束了");
		// Its failure notice reached the parent: it no longer blocks the fold.
		const rows = buildSubagentPanelRows(children, undefined, new Set(["old"]));
		expect(rows.find((row) => row.id === "old")).toMatchObject({ state: "failed", acknowledged: true });
		// It no longer ranks above a live child either.
		expect(rows[0]?.id).toBe("other");
		line.setSubagentRows(rows);
		expect(line.render(100).map(stripAnsi)[1]).toBe(
			"   都结束了（1 个出错，父代理已收到），闲置一阵后会自动关闭（记录保留）",
		);
	});

	it("keeps the selection on the same child when the rows reorder", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 3, idle: 0, inactive: 0 });
		const running = (id: string) => ({ id, name: id, state: "running" as const });
		line.setSubagentRows([running("x"), running("y"), running("z")]);
		line.setOpenable(true);
		line.focused = true;
		line.handleInput("\x1b[B");
		// y finishes and sorts to the bottom: the selector goes with it.
		line.setSubagentRows([running("x"), running("z"), { id: "y", name: "y", state: "done" as const }]);
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.handleInput("\r");
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "y" }));
	});

	it("never exceeds the width and drops the activity column before anything else", () => {
		const line = panel();
		line.focused = true;
		for (const width of [100, 60, 40, 28, 20, 12, 6]) {
			for (const rendered of line.render(width)) {
				expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
			}
		}
		const narrow = line.render(28).map(stripAnsi);
		expect(narrow[2]).toContain("docs");
		expect(narrow[2]).not.toContain("FORK");
	});

	it("builds rows from snapshots, most relevant first, with Chinese states", () => {
		const built = buildSubagentPanelRows(
			[
				child("done-1", "done", { sessionName: "lint", durationMs: 62_000, answerPreview: "无问题\nmore" }),
				child("run-1", "running", {
					sessionName: "review",
					durationMs: 5_000,
					activity: { kind: "executing", toolName: "ipython" },
				}),
				child("err-1", "error", { sessionName: "broken", error: "boom\ntrace" }),
				child("stall-1", "running", {
					sessionName: "stuck",
					activity: { kind: "stalled" },
					stall: { silentMs: 95_000, thresholdMs: 60_000, inFlightTools: ["ipython"] },
				}),
			],
			undefined,
		);
		// Newest work first: busy children (stalled, then running), then idle, then
		// the settled ones. A finished child no longer outranks a live one.
		expect(built.map((row) => [row.name, row.state])).toEqual([
			["stuck", "stalled"],
			["review", "running"],
			["broken", "failed"],
			["lint", "done"],
		]);
		expect(built[0]?.activity).toBe("95s 没有动静 · 在跑 ipython");
		expect(built[1]?.activity).toBe("执行 ipython");
		expect(built[2]?.activity).toBe("boom");
		expect(built[3]?.activity).toBe("无问题");
	});

	it("orders rows by recency inside a status group, newest first", () => {
		const built = buildSubagentPanelRows(
			[
				child("old-run", "running", { sessionName: "old", lastActivityAt: 1_000 }),
				child("new-run", "running", { sessionName: "new", lastActivityAt: 5_000 }),
				child("mid-run", "running", { sessionName: "mid", lastActivityAt: 3_000 }),
				child("old-done", "done", { sessionName: "done-old", lastActivityAt: 2_000 }),
				child("new-done", "done", { sessionName: "done-new", lastActivityAt: 9_000 }),
				child("old-err", "error", { sessionName: "err-old", lastActivityAt: 4_000 }),
			],
			undefined,
		);
		expect(built.map((row) => row.name)).toEqual(["new", "mid", "old", "done-new", "err-old", "done-old"]);
	});

	it("keeps source order for rows without a timestamp", () => {
		const built = buildSubagentPanelRows(
			[child("a", "done", { sessionName: "a" }), child("b", "done", { sessionName: "b" })],
			undefined,
		);
		expect(built.map((row) => row.name)).toEqual(["a", "b"]);
	});

	it("gives the history toggle its own key and keeps it off every other action", () => {
		// Alt+H reaches the panel's toggle from the editor and from the panel itself
		// (see handleInput / onToggleSettled); sharing the key would make one of the two
		// paths silently unreachable.
		expect(KEYBINDINGS["app.subagents.history"].defaultKeys).toBe("alt+h");
		const users = Object.entries(KEYBINDINGS).filter(([, binding]) => binding.defaultKeys === "alt+h");
		expect(users.map(([id]) => id)).toEqual(["app.subagents.history"]);
	});

	it("folds settled rows out once they leave the retention window, keeping busy ones", () => {
		const now = 10_000_000;
		const rows = buildSubagentPanelRows(
			[
				child("run", "running", { sessionName: "run", lastActivityAt: now - 40 * 60_000 }),
				child("idle", "running", { sessionName: "idle", lastActivityAt: now - 40 * 60_000 }),
				child("old-done", "done", { sessionName: "old-done", lastActivityAt: now - 33 * 60_000 }),
				child("old-err", "error", { sessionName: "old-err", lastActivityAt: now - 31 * 60_000 }),
				child("fresh-done", "done", { sessionName: "fresh-done", lastActivityAt: now - 5 * 60_000 }),
			],
			undefined,
		);
		const selection = selectSubagentPanelRows(rows, { now });
		// Both lists keep panel order (newest activity first), so the failure at 31
		// minutes ago outranks the completion at 33 - the fold never reorders anything.
		// A failed row never folds (P5): a broken child is the one fact the reader must
		// not have to scroll for, so it stays on the list past the retention window.
		expect(selection.rows.map((row) => row.name)).toEqual(["run", "idle", "fresh-done", "old-err"]);
		expect(selection.folded.map((row) => row.name)).toEqual(["old-done"]);
	});

	it("folds settled rows at the parent's turn boundary, whatever their age", () => {
		const now = 10_000_000;
		const rows = buildSubagentPanelRows(
			[
				child("before", "done", { sessionName: "before", lastActivityAt: now - 2_000 }),
				child("during", "done", { sessionName: "during", lastActivityAt: now - 1_000 }),
				child("live", "running", { sessionName: "live", lastActivityAt: now - 1_000 }),
			],
			undefined,
		);
		const selection = selectSubagentPanelRows(rows, { now, parentTurnEndedAt: now - 1_500 });
		expect(selection.rows.map((row) => row.name)).toEqual(["live", "during"]);
		expect(selection.folded.map((row) => row.name)).toEqual(["before"]);
	});

	it("holds folded rows open while the history toggle is on", () => {
		const now = 10_000_000;
		const rows = buildSubagentPanelRows(
			[child("old-done", "done", { sessionName: "old-done", lastActivityAt: now - 60 * 60_000 })],
			undefined,
		);
		const selection = selectSubagentPanelRows(rows, { now, showSettled: true });
		expect(selection.rows.map((row) => row.name)).toEqual(["old-done"]);
		expect(selection.folded).toEqual([]);
	});

	it("pins a settled row whose reply has not been read, past the turn boundary", () => {
		const now = 10_000_000;
		const rows = buildSubagentPanelRows(
			[child("answered", "done", { sessionName: "answered", lastActivityAt: now - 60_000 })],
			undefined,
		);
		// Without the pin the turn boundary folds it; with the pin it stays visible.
		const folded = selectSubagentPanelRows(rows, { now, parentTurnEndedAt: now });
		expect(folded.rows).toEqual([]);
		const pinned = selectSubagentPanelRows(rows, {
			now,
			parentTurnEndedAt: now,
			pinnedRowIds: new Set(["answered"]),
		});
		expect(pinned.rows.map((row) => row.name)).toEqual(["answered"]);
		expect(pinned.folded).toEqual([]);
	});

	it("keeps a settled row whose age cannot be judged, and honours a custom retention", () => {
		const now = 10_000_000;
		const rows = buildSubagentPanelRows([child("no-clock", "done", { sessionName: "no-clock" })], undefined);
		expect(selectSubagentPanelRows(rows, { now }).rows.map((row) => row.name)).toEqual(["no-clock"]);

		const aged = buildSubagentPanelRows(
			[child("aged", "done", { sessionName: "aged", lastActivityAt: now - 60_000 })],
			undefined,
		);
		const selection = selectSubagentPanelRows(aged, { now, retentionMs: 30_000 });
		expect(selection.folded.map((row) => row.name)).toEqual(["aged"]);
	});

	it("folds at the retention edge; a resident finished child folds, a busy or stalled one never does", () => {
		const now = 10_000_000;
		const atEdge = SUBAGENT_PANEL_SETTLED_RETENTION_MS;
		const settled = (id: string, lastActivityAt: number) =>
			buildSubagentPanelRows([child(id, "done", { sessionName: id, lastActivityAt })], undefined)[0]!;

		// The edge belongs to the past: exactly `retentionMs` of quiet folds the row,
		// one millisecond less keeps it on the list.
		expect(isSubagentPanelRowFolded(settled("at-edge", now - atEdge), { now })).toBe(true);
		expect(isSubagentPanelRowFolded(settled("just-under", now - atEdge + 1), { now })).toBe(false);

		// A resident done child reads as idle on the roster but is finished work, so the
		// retention clock folds it (P4: 已经结束的工作流要及时删除). A busy row and a stall
		// are live work and never fold, however long they have been quiet.
		const ancient = now - 12 * 60 * 60_000;
		const busy = buildSubagentPanelRows(
			[
				child("running", "running", { sessionName: "running", lastActivityAt: ancient }),
				child("idle", "done", { sessionName: "idle", activeSessionId: "idle-active", lastActivityAt: ancient }),
				child("stalled", "running", {
					sessionName: "stalled",
					activity: { kind: "stalled" },
					stall: { silentMs: 95_000, thresholdMs: 60_000, inFlightTools: [] },
					lastActivityAt: ancient,
				}),
			],
			undefined,
		);
		expect(busy.map((row) => row.state)).toEqual(["stalled", "running", "idle"]);
		expect(selectSubagentPanelRows(busy, { now }).rows.map((row) => row.name)).toEqual(["stalled", "running"]);
		expect(selectSubagentPanelRows(busy, { now }).folded.map((row) => row.name)).toEqual(["idle"]);

		const failed = buildSubagentPanelRows(
			[child("boom", "error", { sessionName: "boom", error: "boom", lastActivityAt: ancient })],
			undefined,
		)[0]!;
		expect(isSettledSubagentPanelRow(failed)).toBe(true);
		// P5: a failure is settled but never auto-folded - it stays visible.
		expect(isSubagentPanelRowFolded(failed, { now })).toBe(false);
	});

	it("keeps panel order through the fold: partition, not reorder", () => {
		const now = 10_000_000;
		const minutesAgo = (minutes: number) => now - minutes * 60_000;
		const built = buildSubagentPanelRows(
			[
				child("live-old", "running", { sessionName: "live-old", lastActivityAt: minutesAgo(90) }),
				child("live-new", "running", { sessionName: "live-new", lastActivityAt: minutesAgo(2) }),
				child("stuck", "running", {
					sessionName: "stuck",
					activity: { kind: "stalled" },
					stall: { silentMs: 95_000, thresholdMs: 60_000, inFlightTools: [] },
					lastActivityAt: minutesAgo(5),
				}),
				child("idle-done", "done", {
					sessionName: "idle-done",
					activeSessionId: "idle-active",
					lastActivityAt: minutesAgo(120),
				}),
				child("done-fresh", "done", { sessionName: "done-fresh", lastActivityAt: minutesAgo(10) }),
				child("err-old", "error", { sessionName: "err-old", error: "boom", lastActivityAt: minutesAgo(45) }),
				child("done-old", "done", { sessionName: "done-old", lastActivityAt: minutesAgo(60) }),
			],
			undefined,
		);
		// The committed sort: busy group, then idle, then settled; newest activity
		// first inside each group (the stall's own rank only breaks a timestamp tie).
		expect(built.map((row) => row.name)).toEqual([
			"live-new",
			"stuck",
			"live-old",
			"idle-done",
			"done-fresh",
			"err-old",
			"done-old",
		]);

		const selection = selectSubagentPanelRows(built, { now });
		// Folding drops the two settled rows that aged out and leaves the rest
		// exactly where the sort put them - the fold is a filter over panel order.
		// idle-done is finished work that aged out (P4) so it folds; err-old is a failure
		// and never folds (P5), so it stays on the list in settled-group order.
		expect(selection.rows.map((row) => row.name)).toEqual(["live-new", "stuck", "live-old", "done-fresh", "err-old"]);
		expect(selection.folded.map((row) => row.name)).toEqual(["idle-done", "done-old"]);
		expect([...selection.rows, ...selection.folded].map((row) => row.name).sort()).toEqual(
			built.map((row) => row.name).sort(),
		);

		// The history toggle holds the same order, folded rows back in place.
		const expanded = selectSubagentPanelRows(built, { now, showSettled: true });
		expect(expanded.rows.map((row) => row.name)).toEqual(built.map((row) => row.name));
		expect(expanded.folded).toEqual([]);
	});

	it("folds a settled child out of the live panel and brings it back with the toggle", () => {
		const line = new SubagentSummaryLine();
		line.setOpenable(true);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		const requestRender = vi.fn();
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: spendCellOffUiServices,
			subagentHistoryExpanded: false,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const toggle = Reflect.get(InteractiveMode.prototype, "toggleSubagentHistory") as (this: typeof mode) => void;

		// One child finished 40 minutes ago, one is still working: the finished row
		// leaves the list while the header's 收口 count keeps carrying it.
		update.call(mode, child("long-ago", "done", { lastActivityAt: Date.now() - 40 * 60_000 }));
		update.call(mode, child("working", "running", { activity: { kind: "executing", toolName: "ipython" } }));
		let rendered = line.render(120).map(stripAnsi);
		expect(rendered.some((text) => text.includes("long-ago"))).toBe(false);
		expect(rendered.some((text) => text.includes("working"))).toBe(true);
		expect(rendered.some((text) => text.includes("已收起 1 个已结束的子代理"))).toBe(true);

		// The history toggle (Alt+H, the panel's own key, /subagents) shows it again.
		toggle.call(mode);
		rendered = line.render(120).map(stripAnsi);
		expect(rendered.some((text) => text.includes("long-ago"))).toBe(true);
		expect(rendered.some((text) => text.includes("已展开 1 个已结束的子代理"))).toBe(true);

		toggle.call(mode);
		rendered = line.render(120).map(stripAnsi);
		expect(rendered.some((text) => text.includes("long-ago"))).toBe(false);
		expect(requestRender).toHaveBeenCalled();
	});

	it("folds on its own when the retention deadline passes, without waiting for an event", () => {
		vi.useFakeTimers();
		try {
			const base = 1_000_000_000;
			vi.setSystemTime(base);
			const line = new SubagentSummaryLine();
			// Focused, so the panel lists its rows instead of collapsing a lone finished
			// child into the "都做完了" line - the fold has to be visible to be asserted.
			line.focused = true;
			line.setOpenable(true);
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
				rlmNodeId: undefined,
				heartbeatCatalog: [],
				subagentSummaryLine: line,
				uiServices: spendCellOffUiServices,
				subagentHistoryExpanded: false,
				updateWorkingPulse: vi.fn(),
				syncWorkingLoader: vi.fn(),
				updateWorkingLoaderMessage: vi.fn(),
				scheduleHeartbeatManagerRefresh: vi.fn(),
				ui: { requestRender: vi.fn() },
			});
			const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
				this: typeof mode,
				value: AgentConnectionRlmChildAgentSnapshot,
			) => void;

			// Settled 29 minutes ago: inside the window, so it is still on the list.
			update.call(mode, child("aged", "done", { lastActivityAt: base - 29 * 60_000 }));
			expect(
				line
					.render(120)
					.map(stripAnsi)
					.some((text) => text.includes("aged")),
			).toBe(true);

			// One more minute of quiet and the armed deadline folds it out on its own.
			vi.advanceTimersByTime(60_000);
			const rendered = line.render(120).map(stripAnsi);
			expect(rendered.some((text) => text.includes("aged"))).toBe(false);
			expect(rendered.some((text) => text.includes("已收起 1 个已结束的子代理"))).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports folded settled rows on the panel and names the toggle key", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setSubagentRows([{ id: "w", name: "worker", state: "running" }]);
		line.setSubagentFoldedCount(2);
		const rendered = line.render(120).map(stripAnsi);
		expect(rendered.some((text) => text.includes("已收起 2 个已结束的子代理"))).toBe(true);
		expect(rendered.some((text) => text.includes("展开"))).toBe(true);

		// With nothing left but folded rows the hint still stands in for them.
		line.setSubagentRows([]);
		const empty = line.render(120).map(stripAnsi);
		expect(empty).toHaveLength(2);
		expect(empty[1]).toContain("已收起 2 个已结束的子代理");
	});

	it("renders the expand state and fires its toggle callback on the history key", () => {
		let toggled = 0;
		const line = new SubagentSummaryLine();
		line.onToggleSettled = () => {
			toggled += 1;
		};
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setSubagentRows([{ id: "d", name: "done", state: "done" }]);
		line.setSubagentHistoryExpanded(true);
		const rendered = line.render(120).map(stripAnsi);
		expect(rendered.some((text) => text.includes("已展开 1 个已结束的子代理"))).toBe(true);

		line.handleInput("\x1bh"); // alt+h
		line.handleInput("\x1bh");
		expect(toggled).toBeGreaterThan(0);
	});

	it("formats elapsed time as m:ss and h:mm:ss", () => {
		expect(formatSubagentElapsed(41_000)).toBe("0:41");
		expect(formatSubagentElapsed(134_000)).toBe("2:14");
		expect(formatSubagentElapsed(3_723_000)).toBe("1:02:03");
	});
});
