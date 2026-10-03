import type { Usage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
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
	renderSubagentSpendCell,
	type SubagentSpendSummary,
	SubagentSummaryLine,
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

	it("renders nothing without children and one block with the counts when no child is described", () => {
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

	it("hints ↓ 选一个进去看 when unfocused and Enter 进去 when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);

		expect(stripAnsi(line.render(120)[0])).toContain("↓ 选一个进去看");

		line.focused = true;
		const focused = stripAnsi(line.render(120)[0]);
		expect(focused).toContain("Enter 进去");
		expect(focused).not.toContain("↓ 选一个进去看");
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

	it("opens on Enter only when the daemon-backed line is selectable; Right now moves to the next block", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 2, running: 0, idle: 2, inactive: 0 });
		line.setOpenable(true);

		line.handleInput("\r");
		line.handleInput("\x1b[C");

		expect(onOpen).toHaveBeenCalledTimes(1);
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker 回答中");

		update.call(mode, child("worker", "done", { activeSessionId: "active-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker 空闲");
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker 空闲");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker", activity: { kind: "waiting" } }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker 回答中");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker 空闲");
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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

		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker ✓ 已交回");
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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

		const lines = line.render(160).map(stripAnsi);
		// One row for the whole family: the worker running, the stalled grandchild
		// with its own block, marked 卡住.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("worker 回答中");
		expect(lines[0]).toContain("grandchild ⚠ 卡住");
	});

	it("keeps the stall marker of a stalled session that has no row of its own", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		line.setSubagentRows([{ id: "w", name: "worker", state: "running" }]);
		line.setStallMarkers(["worker: stalled 70s", "roster-only: stalled 90s, in-flight: bash"]);
		const lines = line.render(160).map(stripAnsi);
		// The session without a row becomes a red block in the same row; the one with a row says it there.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(" ⚠ roster-only 卡住 ");
		expect(lines[0]).not.toContain("worker: stalled 70s");
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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

		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker ✓ 已交回");
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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
		expect(stripAnsi(line.render(100).join("\n"))).toContain("worker ✓ 已交回");
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
		expect(viewRows[1]).toMatchObject({ kind: "subagent-summary", title: "1 个子代理运行中" });

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
		expect(viewRows[1]).toMatchObject({ kind: "subagent-summary", title: "1 个子代理运行中" });
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
			// Lifecycle announcements route through showStatus; these fixtures assert the panel, not the chat.
			showStatus: vi.fn(),
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

		line.handleInput("\x1b[C");
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

	// Regression for the attach-window double-press that intermittently did not land:
	// the confirming press re-read the roster, and an attached client's event-fed
	// roster can read empty mid-resync, which dropped the confirmation into the
	// "没有在跑" branch and disarmed instead of stopping.
	it("confirms against the armed children when the roster reads empty mid-window", async () => {
		const cancelRlmChild = vi.fn(async (_childId: string) => true);
		const showStatus = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map([["a", child("a", "running", { activeSessionId: "active-a" })]]),
			rlmNodeId: undefined,
			agentConnection: { cancelRlmChild },
			showStatus,
		});
		const request = Reflect.get(InteractiveMode.prototype, "requestStopAllSubagents") as (
			this: typeof mode,
		) => Promise<void>;

		await request.call(mode);
		expect(showStatus.mock.calls[0]?.[0]).toContain("再按一次");
		expect(cancelRlmChild).not.toHaveBeenCalled();

		// The attach-side resync gap: the roster momentarily holds nothing.
		Object.assign(mode, { subagentSnapshots: new Map() });
		await request.call(mode);
		expect(cancelRlmChild).toHaveBeenCalledWith("a");
		expect(showStatus.mock.calls[1]?.[0]).toBe("已停止全部 1 个在跑的子代理");
	});

	it("still answers 没有在跑 on a first press with an empty roster", async () => {
		const cancelRlmChild = vi.fn(async (_childId: string) => true);
		const showStatus = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map(),
			rlmNodeId: undefined,
			agentConnection: { cancelRlmChild },
			showStatus,
		});
		const request = Reflect.get(InteractiveMode.prototype, "requestStopAllSubagents") as (
			this: typeof mode,
		) => Promise<void>;

		await request.call(mode);
		expect(showStatus).toHaveBeenCalledWith("现在没有在跑的子代理");
		expect(cancelRlmChild).not.toHaveBeenCalled();
	});

	it("reports children that settled on their own between the presses, without claiming a stop", async () => {
		// cancelRlmChild answers false for a run that already settled (agent-session
		// contract), the way a child that finished inside the confirm window answers.
		const cancelRlmChild = vi.fn(async (_childId: string) => false);
		const showStatus = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map([["a", child("a", "running", { activeSessionId: "active-a" })]]),
			rlmNodeId: undefined,
			agentConnection: { cancelRlmChild },
			showStatus,
		});
		const request = Reflect.get(InteractiveMode.prototype, "requestStopAllSubagents") as (
			this: typeof mode,
		) => Promise<void>;

		await request.call(mode);
		await request.call(mode);
		expect(showStatus.mock.calls[1]?.[0]).toBe("要停的子代理已经自己结束了");

		// The un-cancelled id must not stay recorded as locally stopped: a later
		// genuine stop of the same child goes through the full flow again.
		Object.assign(mode, {
			subagentSnapshots: new Map([["a", child("a", "running", { activeSessionId: "active-a" })]]),
		});
		cancelRlmChild.mockResolvedValue(true);
		await request.call(mode);
		await request.call(mode);
		expect(showStatus.mock.calls[3]?.[0]).toBe("已停止全部 1 个在跑的子代理");
		expect(cancelRlmChild).toHaveBeenCalledTimes(2);
	});

	it("re-arms instead of stopping when the confirm window has expired", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
			const cancelRlmChild = vi.fn(async (_childId: string) => true);
			const showStatus = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				subagentSnapshots: new Map([["a", child("a", "running", { activeSessionId: "active-a" })]]),
				rlmNodeId: undefined,
				agentConnection: { cancelRlmChild },
				showStatus,
			});
			const request = Reflect.get(InteractiveMode.prototype, "requestStopAllSubagents") as (
				this: typeof mode,
			) => Promise<void>;

			await request.call(mode);
			vi.setSystemTime(new Date("2026-10-03T00:00:06Z"));
			await request.call(mode);
			expect(cancelRlmChild).not.toHaveBeenCalled();
			expect(showStatus.mock.calls[1]?.[0]).toContain("再按一次");

			await request.call(mode);
			expect(cancelRlmChild).toHaveBeenCalledWith("a");
			expect(showStatus.mock.calls[2]?.[0]).toBe("已停止全部 1 个在跑的子代理");
		} finally {
			vi.useRealTimers();
		}
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

	const plain = (text: string | undefined): string => stripAnsi(text ?? "");

	it("shows the spend total with money first and the mother total second, on the status line's cell and not in the strip", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		const before = line.render(120);
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));

		expect(plain(renderSubagentSpendCell(line.getSubagentSpend())[0])).toBe("子代理 ¥4.56 · 全部 ¥5.10");
		// The strip stays as it was: the figure has moved to the status line.
		expect(line.render(120)).toEqual(before);
		expect(plain(line.render(120)[0])).not.toContain("¥");
	});

	it("keeps the cell blank for an all-zero summary and never shows ¥0.00", () => {
		expect(renderSubagentSpendCell(spend({}))).toEqual([]);

		// An all-unpriced family: tokens plus the warning, no ¥0.00 figure.
		const forms = renderSubagentSpendCell(
			spend({ tokens: 8_100_000, unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] }),
		);
		expect(forms.length).toBeGreaterThan(0);
		const body = plain(forms[0]);
		expect(body).toContain("8.1M tok (kimi-k3 8.1M tok 未定价)");
		expect(body).not.toContain("¥");
	});

	it("marks partial-tree figures as lower bounds and warns in the theme warning color", () => {
		const forms = renderSubagentSpendCell(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				partial: true,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		);
		expect(forms.length).toBeGreaterThan(0);
		expect(plain(forms[0])).toContain("≈¥4.56 · 全部 ≈¥5.10");
		expect(forms[0]).toContain(theme.fg("warning", "(kimi-k3 8.1M tok 未定价)"));
		expect(forms[0]).toContain(theme.fg("accent", "¥4.56"));
	});

	it("degrades in a fixed order, one thing per form, and never ends on a half figure", () => {
		const forms = renderSubagentSpendCell(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		).map(plain);
		expect(forms).toEqual([
			// everything
			"子代理 ¥4.56 · 全部 ¥5.10 (kimi-k3 8.1M tok 未定价)",
			// the 全部 figure is the first cut
			"子代理 ¥4.56 (kimi-k3 8.1M tok 未定价)",
			// then the annotation's token counts
			"子代理 ¥4.56 (kimi-k3 未定价)",
			// then the annotation, leaving only the warning mark
			"子代理 ¥4.56?",
		]);
		for (const form of forms) expect(form).not.toMatch(/¥[0-9.]*…/);
	});

	it("does not move the strip when the figures grow", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setSubagentRows([{ id: "a", name: "review", state: "running" }]);
		line.setOpenable(true);
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 999_000, parentCost: 0.2 }));
		const before = line.render(120)[0];
		const beforeRegions = line.getClickRegions().map(({ col, width }) => ({ col, width }));

		line.setSubagentSpend(spend({ cost: 12.34, tokens: 1_020_000, parentCost: 1.2 }));
		const after = line.render(120)[0];

		expect(plain(renderSubagentSpendCell(line.getSubagentSpend())[0])).toContain("¥12.34");
		expect(after).toBe(before);
		expect(line.getClickRegions().map(({ col, width }) => ({ col, width }))).toEqual(beforeRegions);
		expect(visibleWidth(after ?? "")).toBe(visibleWidth(before ?? ""));
	});

	it("keeps the spend colors: money in the accent, the mother total dim", () => {
		const forms = renderSubagentSpendCell(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));
		expect(forms.length).toBeGreaterThan(0);
		expect(forms[0]).toContain(theme.fg("accent", "¥4.56"));
		expect(forms[0]).toContain(theme.fg("dim", "全部 ¥5.10"));
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
			// Lifecycle announcements route through showStatus; this fixture asserts the cell, not the chat.
			showStatus: vi.fn(),
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

	it("stops the idle tick and blanks the figure when the connection closes for good", async () => {
		vi.useFakeTimers();
		try {
			const { mode, setSpend, getContextTree, update } = createSpendMode({
				contextTree: tree(usage(1_000, 500, 0.5), [agent("sub-1", usage(2_000, 1_000, 1.2), undefined)]),
			});
			// The terminal-close entry point every dead-connection path lands on (a
			// session-gone answer, a dropped daemon, a reconnect budget that ran out).
			const noteConnectionClosed = Reflect.get(InteractiveMode.prototype, "noteConnectionClosed") as (
				this: typeof mode,
			) => void;

			// Family on screen: the leading fill lands, then the 15s tick keeps it fresh.
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(600);
			expect(getContextTree).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(getContextTree).toHaveBeenCalledTimes(2);

			// The close blanks the cell at render; its cadence must leave with it.
			noteConnectionClosed.call(mode);
			expect(setSpend).toHaveBeenLastCalledWith(undefined);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(getContextTree).toHaveBeenCalledTimes(2);

			// A late child update (a queued event landing after the close) cannot re-arm it.
			update.call(mode, child("worker", "running", { activity: { kind: "executing" } }));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(getContextTree).toHaveBeenCalledTimes(2);
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
		const forms = renderSubagentSpendCell(
			spend({
				cost: 9,
				tokens: 2_000_000,
				parentCost: 0,
				overridePriced: [{ model: "kimi-k3", tokens: 2_000_000 }],
			}),
		);
		expect(forms.length).toBeGreaterThan(0);
		expect(forms.map(stripAnsi)[0]).toBe("子代理 ¥9.00 · 全部 ¥9.00 (kimi-k3 2.0M tok 已改价)");
		expect(forms[0]).toContain(theme.fg("accent", "(kimi-k3 2.0M tok 已改价)"));

		// The marker degrades with the rest of the annotation, and a truncated money
		// figure is never shown: the cell drops whole forms, it does not ellipsize.
		const last = stripAnsi(forms.at(-1) ?? "");
		expect(last).toBe("子代理 ¥9.00");
		expect(last).not.toContain("已改价");
		expect(forms.map(stripAnsi)).toContain("子代理 ¥9.00 (kimi-k3 已改价)");
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

	it("renders one row of blocks, one per child, in state order, with the state in words", () => {
		const lines = panel().render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ {2}◇ review 回答中 {3}◇ docs 回答中 {3}◇ lint ✓ 已交回 /);
		// No header, no per-child list, no rule.
		expect(lines[0]).not.toContain("子代理 3");
		expect(lines[0]).not.toContain("─");
	});

	it("moves the selection over the blocks while focused and shows the keys", () => {
		const line = panel();
		line.focused = true;
		const onOpen = vi.fn();
		const onCancel = vi.fn();
		line.onOpen = onOpen;
		line.onCancel = onCancel;
		expect(stripAnsi(line.render(120)[0] ?? "").trimEnd()).toMatch(/←\/→ 选 · Enter 进去 · Esc 返回 · .*全部停止$/);
		line.handleInput("\r");
		expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
		line.handleInput("\x1b[C");
		line.handleInput("\r");
		expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b" }));
		// Up leaves at once: there is no list to walk back up.
		line.handleInput("\x1b[A");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("pages a crowd of children sideways in one row and drops stall marker lines while rows carry the state", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 6, running: 6, idle: 0, inactive: 0 });
		line.setSubagentRows(
			Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `w${index}`, state: "running" as const })),
		);
		line.setStallMarkers(["w0: stalled 30s"]);
		const lines = line.render(60).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/还有 \d+ 个 ›/);
		// w0 has a block of its own: its marker adds nothing.
		expect(lines.join("\n")).not.toContain("⚠");
	});

	it("reaches every child with the arrow keys and opens the one selected", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 6, running: 6, idle: 0, inactive: 0 });
		line.setSubagentRows(
			Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: `w${index}`, state: "running" as const })),
		);
		line.setOpenable(true);
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.focused = true;
		expect(line.render(60)).toHaveLength(1);

		for (let press = 0; press < 5; press++) line.handleInput("\x1b[C");
		const lines = line.render(60).map(stripAnsi);
		expect(lines).toHaveLength(1);
		// The row followed the selection to the last child, and nothing is left to the right.
		expect(lines[0]).toContain("w5");
		expect(lines[0]).not.toContain("›");
		// The last block is the floor: another Right stays on it.
		line.handleInput("\x1b[C");
		line.handleInput("\r");
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "c5", name: "w5" }));

		// Back through the row, the earlier children come back into view.
		for (let press = 0; press < 5; press++) line.handleInput("\x1b[D");
		expect(stripAnsi(line.render(60)[0] ?? "")).toContain("w0");
		line.handleInput("\r");
		expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c0" }));
	});

	it("keeps an all-idle family in the same one row, with the auto-close note as the hint", () => {
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
		let lines = line.render(120).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("↓ 选一个进去看");
		// With room, the note says what happens to finished children.
		lines = line.render(200).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("都做完了，闲置一阵后会自动关闭（记录保留）");
		// Focused, every child is still one row, reachable with the arrows.
		line.focused = true;
		lines = line.render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("vps-0 空闲");
		// One child still working: no note, the blocks speak for themselves.
		line.focused = false;
		line.setSubagentRows([
			{ id: "r", name: "vps-run", state: "running" as const },
			{ id: "i0", name: "vps-0", state: "idle" as const },
		]);
		const working = line.render(200).map(stripAnsi);
		expect(working[0]).toContain("vps-run 回答中");
		expect(working[0]).not.toContain("都做完了");
	});

	it("stops promising an idle close once every child is closed", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 0, idle: 0, inactive: 2 });
		line.setSubagentRows(buildSubagentPanelRows([child("a", "done"), child("b", "done")], undefined));
		line.setOpenable(true);
		const text = line.render(100).map(stripAnsi).join("\n");
		expect(text).toContain("都做完了，已自动关闭（记录保留）");
		expect(text).not.toContain("闲置一阵");
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
		// Not seen yet: the failure is the first block, and it says 出错 with no auto-close note.
		line.setSubagentRows(buildSubagentPanelRows(children, undefined));
		const fresh = line.render(200).map(stripAnsi)[0] ?? "";
		expect(fresh).toMatch(/^ {2}◇ old ✗ 出错/);
		expect(fresh).not.toContain("都结束了");
		// Its failure notice reached the parent: it no longer counts as unsettled.
		const rows = buildSubagentPanelRows(children, undefined, new Set(["old"]));
		expect(rows.find((row) => row.id === "old")).toMatchObject({ state: "failed", acknowledged: true });
		// It no longer ranks above a live child either.
		expect(rows[0]?.id).toBe("other");
		line.setSubagentRows(rows);
		expect(line.render(200).map(stripAnsi)[0]).toContain(
			"都结束了（1 个出错，父代理已收到），闲置一阵后会自动关闭（记录保留）",
		);
	});

	it("keeps the selection on the same child when the rows reorder", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 3, idle: 0, inactive: 0 });
		const running = (id: string) => ({ id, name: id, state: "running" as const });
		line.setSubagentRows([running("x"), running("y"), running("z")]);
		line.setOpenable(true);
		line.focused = true;
		line.handleInput("\x1b[C");
		// y finishes and sorts to the end: the selection goes with it.
		line.setSubagentRows([running("x"), running("z"), { id: "y", name: "y", state: "done" as const }]);
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.handleInput("\r");
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "y" }));
	});

	it("never exceeds the width, stays one row, and does not show what each child is doing", () => {
		const line = panel();
		line.focused = true;
		for (const width of [100, 60, 40, 28, 20, 12, 6]) {
			const rendered = line.render(width);
			expect(rendered, `width ${width}`).toHaveLength(1);
			expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(width);
			expect(stripAnsi(rendered[0] ?? "")).not.toContain("FORK");
		}
		expect(stripAnsi(line.render(28)[0] ?? "")).toContain("review");
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
		expect(built.map((row) => [row.name, row.state])).toEqual([
			["stuck", "stalled"],
			["broken", "failed"],
			["review", "running"],
			["lint", "done"],
		]);
		expect(built[0]?.activity).toBe("95s 没有动静 · 在跑 ipython");
		expect(built[1]?.activity).toBe("boom");
		expect(built[2]?.activity).toBe("执行 ipython");
		expect(built[3]?.activity).toBe("无问题");
	});

	it("formats elapsed time as m:ss and h:mm:ss", () => {
		expect(formatSubagentElapsed(41_000)).toBe("0:41");
		expect(formatSubagentElapsed(134_000)).toBe("2:14");
		expect(formatSubagentElapsed(3_723_000)).toBe("1:02:03");
	});
});
