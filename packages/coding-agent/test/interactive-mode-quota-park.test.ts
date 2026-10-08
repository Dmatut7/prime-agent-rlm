import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type QuotaParkStatusEvent = Extract<AgentConnectionEvent, { type: "quota_park_status" }>;

/**
 * The interactive host's quota-park surface (中断-10 follow-ups):
 *
 * - R3-2: quota_park_status applies through the session event queue, in arrival
 *   order with the session events it races (auto_retry_end, agent_start), and a
 *   park announced for a session that was just replaced never lands on the new
 *   view.
 * - R3-4: a re-park that pushes the wake out announces again (showStatus merges
 *   it into the one status line); steady heartbeats repeat nothing.
 * - R3-7: the legacy face with footer.telemetry off has no line to carry the
 *   countdown, so a pinned status-container row appears while the park lasts.
 *
 * Driven through the real prototype methods on a partial-mode fake, the same
 * harness pattern as interactive-mode-stall-bar-lifecycle.test.ts.
 */

type HandleQuotaParkStatus = (this: ModeFake, event: QuotaParkStatusEvent) => void;

type SubscribeToAgent = (this: ModeFake) => void;

const proto = InteractiveMode.prototype as unknown as {
	handleQuotaParkStatus: HandleQuotaParkStatus;
	subscribeToAgent: SubscribeToAgent;
};

const T0 = 1_700_000_000_000;

function isoIn(ms: number): string {
	return new Date(Date.now() + ms).toISOString();
}

function parkFake(overrides: ModeFake = {}): ModeFake {
	const settings = {
		getProcessMode: () => "legacy",
		getFooterTelemetry: () => "off" as const,
	};
	const fake: ModeFake = {
		quotaPark: undefined,
		quotaParkTicker: undefined,
		quotaParkStatusRow: undefined,
		statusContainer: new Container(),
		chatContainer: new Container(),
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		connectionState: undefined,
		settingsManager: settings,
		uiServices: { settingsManager: settings },
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		...overrides,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function chatText(mode: ModeFake): string {
	return stripAnsi((mode.chatContainer as Container).render(120).join("\n"));
}

function statusText(mode: ModeFake): string {
	return stripAnsi((mode.statusContainer as Container).render(120).join("\n"));
}

describe("handleQuotaParkStatus chat notice (R3-4)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("announces a park once; a steady heartbeat re-stating the same wake repeats nothing", () => {
		const mode = parkFake();
		const event: QuotaParkStatusEvent = { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) };

		proto.handleQuotaParkStatus.call(mode, event);
		const chat = mode.chatContainer as Container;
		const childrenAfterPark = chat.children.length;
		expect(childrenAfterPark).toBeGreaterThan(0);
		expect(chatText(mode)).toContain("额度已用完，会话挂起等额度恢复，约 1小时00分后自动恢复。");

		proto.handleQuotaParkStatus.call(mode, event);
		expect(chat.children.length).toBe(childrenAfterPark);
	});

	it("a re-park that pushes the wake out announces again, merged into the one status line", () => {
		const mode = parkFake();
		const chat = mode.chatContainer as Container;

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		expect(chatText(mode)).toContain("约 1小时00分后自动恢复");

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(7_200_000) });

		// showStatus updates the back-to-back status line instead of appending.
		expect(chatText(mode)).toContain("约 2小时00分后自动恢复");
		expect(chatText(mode)).not.toContain("约 1小时00分后自动恢复");
		expect(chat.children.filter((child) => child === mode.lastStatusText)).toHaveLength(1);
	});

	it("a re-park keeps the episode count in the notice", () => {
		const mode = parkFake();

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		expect(chatText(mode)).not.toContain("本段第");

		proto.handleQuotaParkStatus.call(mode, {
			type: "quota_park_status",
			parked: true,
			resumeAt: isoIn(7_200_000),
			parkCount: 2,
		});

		expect(chatText(mode)).toContain("（本段第 2 次）");
	});

	it("a heartbeat that gives a wake time to a park that had none announces again", () => {
		const mode = parkFake();
		const chat = mode.chatContainer as Container;

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true });
		expect(chatText(mode)).toContain("额度已用完，会话挂起等额度恢复。");
		const childrenAfterPark = chat.children.length;

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });

		expect(chatText(mode)).toContain("约 1小时00分后自动恢复");
		expect(chat.children.length).toBe(childrenAfterPark);
	});
});

describe("legacy park status row (R3-7)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("pins a counting status-container row while parked when no footer line can carry it", () => {
		const mode = parkFake();

		proto.handleQuotaParkStatus.call(mode, {
			type: "quota_park_status",
			parked: true,
			resumeAt: isoIn(3_600_000),
			provider: "anthropic",
			parkCount: 3,
		});

		const statusContainer = mode.statusContainer as Container;
		expect(statusContainer.children).toHaveLength(1);
		expect(statusText(mode)).toContain("额度等待 anthropic · 1小时00分后恢复 · 第 3 次");

		// The park's own ticker counts the pinned row down: one render later the
		// remainder moved.
		vi.setSystemTime(T0 + 60_000);
		expect(statusText(mode)).toContain("59分后恢复");

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: false });
		expect(statusContainer.children).toHaveLength(0);
		expect(mode.quotaParkStatusRow).toBeUndefined();
	});

	it("does not pin where a persistent line already carries the countdown (watermark on, or quiet)", () => {
		const telemetryOn = {
			getProcessMode: () => "legacy",
			getFooterTelemetry: () => "on" as const,
		};
		const legacyWithWatermark = parkFake({
			settingsManager: telemetryOn,
			uiServices: { settingsManager: telemetryOn },
		});
		proto.handleQuotaParkStatus.call(legacyWithWatermark, {
			type: "quota_park_status",
			parked: true,
			resumeAt: isoIn(3_600_000),
		});
		expect((legacyWithWatermark.statusContainer as Container).children).toHaveLength(0);
		proto.handleQuotaParkStatus.call(legacyWithWatermark, { type: "quota_park_status", parked: false });

		const quietSettings = {
			getProcessMode: () => "quiet",
			getFooterTelemetry: () => "off" as const,
		};
		const quiet = parkFake({
			settingsManager: quietSettings,
			uiServices: { settingsManager: quietSettings },
		});
		proto.handleQuotaParkStatus.call(quiet, {
			type: "quota_park_status",
			parked: true,
			resumeAt: isoIn(3_600_000),
		});
		expect((quiet.statusContainer as Container).children).toHaveLength(0);
		proto.handleQuotaParkStatus.call(quiet, { type: "quota_park_status", parked: false });
	});

	it("re-pins the row on the park tick after another status-container owner cleared it", () => {
		const mode = parkFake();
		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		const statusContainer = mode.statusContainer as Container;
		expect(statusContainer.children).toHaveLength(1);

		// A retry/compaction loader owns the container wholesale while it runs.
		statusContainer.clear();
		expect(statusContainer.children).toHaveLength(0);

		vi.advanceTimersByTime(1000);
		expect(statusContainer.children).toHaveLength(1);
		expect(statusText(mode)).toContain("额度等待");

		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: false });
	});
});

describe("quota_park_status queueing (R3-2)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function queueFake() {
		const order: string[] = [];
		const listeners: Array<(event: AgentConnectionEvent) => Promise<void>> = [];
		const mode = parkFake({
			agentConnection: {
				subscribe: vi.fn((callback: (event: AgentConnectionEvent) => Promise<void>) => {
					listeners.push(callback);
					return () => {};
				}),
			},
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			handleEvent: vi.fn(() => {
				order.push("event");
			}),
			showStatus: vi.fn(() => {
				order.push("park");
			}),
			resetSideQuestion: vi.fn(),
			resetExtensionUI: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			resetCurrentSessionRenderState: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			renderInitialMessages: vi.fn(async () => {}),
		});
		proto.subscribeToAgent.call(mode);
		const listener = listeners[0];
		if (!listener) throw new Error("subscribeToAgent registered no listener");
		return { mode, order, listener };
	}

	it("applies a park behind earlier session events, never ahead of them", async () => {
		const { mode, order, listener } = queueFake();
		let release!: () => void;
		mode.sessionEventQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		const eventRun = listener({ type: "session_event", event: { type: "agent_start" } });
		const parkRun = listener({ type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });

		// Both sit behind the queue: neither has applied yet.
		expect(order).toEqual([]);
		expect(mode.quotaPark).toBeUndefined();

		release();
		await eventRun;
		await parkRun;

		// Arrival order, not event-type priority: the session event lands first.
		expect(order).toEqual(["event", "park"]);
		expect(mode.quotaPark).toBeDefined();

		await listener({ type: "quota_park_status", parked: false });
	});

	it("drops a park announced for the session that was just replaced", async () => {
		const { mode, listener } = queueFake();
		let release!: () => void;
		mode.sessionEventQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		const parkRun = listener({ type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		const replaceRun = listener({
			type: "session_replaced",
			state: {} as never,
			messages: [],
		});

		release();
		await parkRun;
		await replaceRun;

		// The park was queued before the replacement advanced the generation, so
		// it never landed on the new view; the replacement ran its own reset.
		expect(mode.quotaPark).toBeUndefined();
		expect(mode.resetCurrentSessionRenderState).toHaveBeenCalledTimes(1);
		expect(mode.showStatus).not.toHaveBeenCalled();

		// The new session's own heartbeat applies normally.
		await listener({ type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		expect(mode.quotaPark).toBeDefined();

		await listener({ type: "quota_park_status", parked: false });
	});
});

describe("snapshot quotaPark seeding (rev 43)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const seedProto = InteractiveMode.prototype as unknown as {
		applySnapshotQuotaPark(
			this: ModeFake,
			quotaPark:
				| { parked: true; resumeAt?: string; remainingMs?: number; parkCount?: number; provider?: string }
				| undefined,
		): void;
		renderInitialMessages(this: ModeFake): Promise<void>;
	};

	function renderFake(snapshot: unknown): ModeFake {
		return parkFake({
			agentConnection: { getInitialSnapshot: vi.fn(async () => snapshot) },
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: unknown }) => ({
				messages: (snap as { messages: unknown[] }).messages,
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			})),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showDutyLog: vi.fn(async () => {}),
			rlmNodeId: undefined,
		});
	}

	it("an attach into a parked session seeds the countdown from the snapshot", async () => {
		const resumeAt = isoIn(3_600_000);
		const mode = renderFake({
			state: {},
			messages: [],
			quotaPark: { parked: true, resumeAt, remainingMs: 3_599_000, parkCount: 2, provider: "anthropic" },
		});

		await seedProto.renderInitialMessages.call(mode);

		const park = mode.quotaPark as { resumeAtMs?: number; parkCount?: number; provider?: string } | undefined;
		expect(park?.resumeAtMs).toBe(Date.parse(resumeAt));
		expect(park?.parkCount).toBe(2);
		expect(park?.provider).toBe("anthropic");
		// The attach announces the park like a heartbeat would, and the pinned row carries the countdown.
		expect(chatText(mode)).toContain("额度已用完，会话挂起等额度恢复");
		expect((mode.statusContainer as Container).children.length).toBe(1);

		seedProto.applySnapshotQuotaPark.call(mode, undefined);
		expect(mode.quotaPark).toBeUndefined();
	});

	it("an attach into an unparked session clears a stale local park", async () => {
		const mode = renderFake({ state: {}, messages: [] });
		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		expect(mode.quotaPark).toBeDefined();

		await seedProto.renderInitialMessages.call(mode);

		expect(mode.quotaPark).toBeUndefined();
		expect((mode.statusContainer as Container).children).toHaveLength(0);
	});

	function resyncFake() {
		const listeners: Array<(event: AgentConnectionEvent) => Promise<void>> = [];
		const mode = parkFake({
			agentConnection: {
				subscribe: vi.fn((callback: (event: AgentConnectionEvent) => Promise<void>) => {
					listeners.push(callback);
					return () => {};
				}),
			},
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			connectionLost: true,
			liveTurnFlowStore: undefined,
			refreshCommandCatalogForCurrentSession: vi.fn(async () => {}),
			renderResyncedSession: vi.fn(async () => {}),
			handleEvent: vi.fn(),
		});
		proto.subscribeToAgent.call(mode);
		const listener = listeners[0];
		if (!listener) throw new Error("subscribeToAgent registered no listener");
		return { mode, listener };
	}

	it("a resync snapshot without quotaPark clears the local park instead of waiting a heartbeat out", async () => {
		const { mode, listener } = resyncFake();
		proto.handleQuotaParkStatus.call(mode, { type: "quota_park_status", parked: true, resumeAt: isoIn(3_600_000) });
		expect(mode.quotaPark).toBeDefined();

		await listener({ type: "session_resynced", snapshot: { state: {} as never, messages: [] } });

		expect(mode.quotaPark).toBeUndefined();
		expect((mode.statusContainer as Container).children).toHaveLength(0);
		expect(mode.renderResyncedSession).toHaveBeenCalledTimes(1);
	});

	it("a resync snapshot carrying quotaPark seeds the countdown at once", async () => {
		const { mode, listener } = resyncFake();
		const resumeAt = isoIn(3_600_000);

		await listener({
			type: "session_resynced",
			snapshot: { state: {} as never, messages: [], quotaPark: { parked: true, resumeAt, provider: "openai" } },
		});

		const park = mode.quotaPark as { resumeAtMs?: number; provider?: string } | undefined;
		expect(park?.resumeAtMs).toBe(Date.parse(resumeAt));
		expect(park?.provider).toBe("openai");
		expect(chatText(mode)).toContain("额度已用完，会话挂起等额度恢复");
	});
});

describe("session_replaced snapshot re-read (R2-M11, rev 48)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const replaceProto = InteractiveMode.prototype as unknown as {
		subscribeToAgent(this: ModeFake): void;
	};

	it("keeps the subagent panel seed, rlmNodeId and park through a replacement's snapshot re-read", async () => {
		// The connection-level session_replaced event arm deliberately carries only
		// state+messages; renderInitialMessages re-reads the rest from
		// getInitialSnapshot(), where the connection preserved (old daemon) or
		// mirrored (rev-48 daemon) children/parent/quotaPark. Pin the consumption
		// half of that contract: after the replacement's re-read the panel seed,
		// the parent link and the park countdown are still there.
		const listeners: Array<(event: AgentConnectionEvent) => Promise<void>> = [];
		const child = { id: "child-1", label: "child one", status: "running" as const, sessionDir: "/tmp/child-1" };
		const resumeAt = isoIn(3_600_000);
		const snapshot = {
			state: {},
			messages: [],
			parent: {
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				nodeId: "parent-node",
				childId: "child-1",
			},
			children: [child],
			quotaPark: { parked: true as const, resumeAt, remainingMs: 3_599_000, parkCount: 2, provider: "anthropic" },
		};
		const seedSubagentSummary = vi.fn();
		const mode = parkFake({
			agentConnection: {
				subscribe: vi.fn((callback: (event: AgentConnectionEvent) => Promise<void>) => {
					listeners.push(callback);
					return () => {};
				}),
				getInitialSnapshot: vi.fn(async () => snapshot),
			},
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			resetSideQuestion: vi.fn(),
			resetExtensionUI: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			resetCurrentSessionRenderState: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: unknown }) => ({
				messages: snap.messages,
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			})),
			seedSubagentSummary,
			restoreTurnStartFromMessages: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showDutyLog: vi.fn(async () => {}),
			rlmNodeId: undefined,
		});
		replaceProto.subscribeToAgent.call(mode);
		const listener = listeners[0];
		if (!listener) throw new Error("subscribeToAgent registered no listener");

		await listener({ type: "session_replaced", state: {} as never, messages: [] });

		expect(mode.rlmNodeId).toBe("child-1");
		expect(seedSubagentSummary).toHaveBeenCalledWith([child]);
		const park = mode.quotaPark as { resumeAtMs?: number; parkCount?: number } | undefined;
		expect(park?.resumeAtMs).toBe(Date.parse(resumeAt));
		expect(park?.parkCount).toBe(2);
		expect(chatText(mode)).toContain("额度已用完，会话挂起等额度恢复");
	});
});
