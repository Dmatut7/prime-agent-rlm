import { Container, Loader, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

const identity = (text: string): string => text;

function modeFake(fields: ModeFake = {}): ModeFake {
	const fake: ModeFake = { ...fields };
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function interruptFake(overrides: ModeFake = {}): ModeFake {
	return modeFake({
		traceUploadAllAbortController: undefined,
		sideQuestionEvent: undefined,
		editor: { getText: () => "", getExpandedText: () => "", setText: () => {} },
		connectionState: {
			isStreaming: true,
			isCompacting: true,
			isBashRunning: true,
			retryAttempt: 2,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		},
		agentConnection: {
			abort: vi.fn().mockResolvedValue(undefined),
			abortRetry: vi.fn().mockResolvedValue(undefined),
			abortCompaction: vi.fn().mockResolvedValue(undefined),
			abortBranchSummary: vi.fn().mockResolvedValue(undefined),
			abortBash: vi.fn().mockResolvedValue(undefined),
			clearQueue: vi.fn(),
			abortAndClearQueue: vi.fn(),
		},
		subagentSummaryLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		queueSelection: { isBrowsing: false, reset: () => "" },
		showError: vi.fn(),
		isCtrlCExitHintVisible: () => false,
		clearEscapeRepeat: () => {},
		...overrides,
	});
}

/** The three transient overlays stop() and resetCurrentSessionRenderState() used to leave running. */
function overlayFixture() {
	const ui = {
		requestRender: vi.fn(),
		terminal: { setProgress: vi.fn(), abortPendingInput: vi.fn() },
		stop: vi.fn(),
	} as unknown as TUI;
	const statusContainer = new Container();
	const retryLoader = new Loader(ui, identity, identity, "Retrying");
	const autoCompactionLoader = new Loader(ui, identity, identity, "Compacting");
	const onTick = vi.fn();
	const onExpire = vi.fn();
	const retryCountdown = new CountdownTimer(5000, ui, onTick, onExpire);
	statusContainer.addChild(retryLoader);
	statusContainer.addChild(autoCompactionLoader);
	onTick.mockClear();
	return { ui, statusContainer, retryLoader, autoCompactionLoader, retryCountdown, onTick, onExpire };
}

describe("interruptOrClearInput abort failures", () => {
	/**
	 * Every abort call here is fire-and-forget. The streaming interrupt's call carries a
	 * .catch() - it was `abort()` and is `abortAndSendQueued()` since the #2426 wiring, whose
	 * degradation branch adds a .then() that must not swallow the rejection either; the other
	 * four never had one, so a daemon that answers an abort command with an error turned one
	 * Escape press into an unhandled rejection - a warning or a crash, depending on the Node
	 * rejection mode the process runs in.
	 *
	 * The fakes return plain rejected promises on purpose: `vi.fn().mockRejectedValue()`
	 * attaches its own handler, which would hide exactly the leak under test.
	 */
	it("does not leak an unhandled rejection when the daemon rejects an abort", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		const called: string[] = [];
		const rejecting = (label: string) => () => {
			called.push(label);
			return Promise.reject(new Error(`daemon rejected ${label}`));
		};
		process.on("unhandledRejection", onRejection);
		try {
			const mode = interruptFake({
				agentConnection: {
					abort: rejecting("abort"),
					abortAndSendQueued: rejecting("abortAndSendQueued"),
					abortRetry: rejecting("abortRetry"),
					abortCompaction: rejecting("abortCompaction"),
					abortBranchSummary: rejecting("abortBranchSummary"),
					abortBash: rejecting("abortBash"),
					clearQueue: () => Promise.resolve(undefined),
					abortAndClearQueue: () => Promise.resolve(undefined),
				},
			});

			Reflect.get(InteractiveMode.prototype, "interruptOrClearInput").call(mode);

			// Node reports a rejection once nothing can still attach a handler.
			await new Promise((resolve) => setTimeout(resolve, 50));

			// The streaming interrupt calls abortAndSendQueued, not abort: `abort` stays in the
			// fake because a regression that calls both would have to show up here too.
			expect(called.sort()).toEqual([
				"abortAndSendQueued",
				"abortBash",
				"abortBranchSummary",
				"abortCompaction",
				"abortRetry",
			]);
			expect(rejections).toEqual([]);
			// The one path that already handled its failure still surfaces it.
			expect(mode.showError as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});

describe("CountdownTimer interval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not hold the event loop open", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const timer = new CountdownTimer(
			5000,
			undefined,
			() => {},
			() => {},
		);
		const handle = setIntervalSpy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;

		expect(handle).toBeDefined();
		expect(handle?.hasRef()).toBe(false);

		timer.dispose();
	});

	it("still counts down and expires", () => {
		const ticks: number[] = [];
		const onExpire = vi.fn();
		const timer = new CountdownTimer(
			3000,
			undefined,
			(seconds) => {
				ticks.push(seconds);
			},
			onExpire,
		);

		vi.advanceTimersByTime(3000);

		expect(ticks).toEqual([3, 2, 1, 0]);
		expect(onExpire).toHaveBeenCalledOnce();
		timer.dispose();
	});
});

describe("transient status overlays on teardown and session replacement", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function stopFake(fixture: ReturnType<typeof overlayFixture>): ModeFake {
		return modeFake({
			unregisterSignalHandlers: () => {},
			clearCtrlCExitHint: () => {},
			clearEscapeRepeat: () => {},
			settingsManager: { getShowTerminalProgress: () => false },
			stopWorkingLoader: () => {},
			discardRefineLoader: () => {},
			endFeatureHintRun: () => {},
			stopWorkingPulse: () => {},
			stopGoalTrayTimer: () => {},
			closeHeartbeatManager: () => {},
			clearExtensionTerminalInputListeners: () => {},
			footer: { dispose: () => {} },
			footerDataProvider: { dispose: () => {} },
			unsubscribe: undefined,
			rosterBar: undefined,
			isInitialized: false,
			...fixture,
		});
	}

	function sessionResetFake(fixture: ReturnType<typeof overlayFixture>): ModeFake {
		const editor = { clearHistory: () => {}, setText: () => {} };
		return modeFake({
			endFeatureHintRun: () => {},
			chatContainer: { clear: () => {} },
			shortcutGuideContainer: { clear: () => {} },
			pendingMessagesContainer: { clear: () => {} },
			queuedMessagesContainer: { clear: () => {} },
			pendingQueueEdit: undefined,
			pendingQueueMove: false,
			queueSelection: { reset: () => {} },
			featureHintSuppressedByQueue: false,
			promptStash: undefined,
			promptStashState: undefined,
			defaultEditor: editor,
			editor,
			liveImageMarkerIds: () => new Set<number>(),
			pastedImages: new Map(),
			streamingComponent: undefined,
			streamingMessage: undefined,
			activeBashComponent: undefined,
			discardRefineLoader: () => {},
			pendingBashComponents: [],
			activityTracker: { reset: () => {} },
			contextUsageTokenBaseline: 0,
			resetPendingToolState: () => {},
			agentRunFileChanges: new Set(),
			renderRecap: () => {},
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			chatTranscriptTrimmed: false,
			chatCapRebuildFloor: 0,
			resetSubagentSummary: () => {},
			getGoalState: () => undefined,
			setGoalAnnouncementBaseline: () => {},
			syncGoalTray: () => {},
			...fixture,
		});
	}

	/** Shared proposition: nothing owned by the previous state keeps ticking or rendering. */
	function expectOverlaysDisposed(fixture: ReturnType<typeof overlayFixture>): void {
		const rendersBefore = (fixture.ui as unknown as { requestRender: ReturnType<typeof vi.fn> }).requestRender.mock
			.calls.length;
		fixture.onTick.mockClear();

		vi.advanceTimersByTime(30_000);

		expect(fixture.onTick).not.toHaveBeenCalled();
		const ui = fixture.ui as unknown as { requestRender: ReturnType<typeof vi.fn> };
		expect(ui.requestRender.mock.calls.length).toBe(rendersBefore);
		expect(fixture.statusContainer.children).toEqual([]);
	}

	it("stop() clears the panel's fold timer, so nothing repaints a stopped session", () => {
		// The panel arms one timeout to re-apply the 30-minute fold (see
		// syncSubagentFoldTimer). A stopped session has no panel: the timer has to go
		// with the overlays, or it fires later and renders through a torn-down UI.
		const fired = vi.fn();
		const mode = stopFake(overlayFixture());
		mode.subagentFoldTimer = setTimeout(fired, 30 * 60_000);

		Reflect.get(InteractiveMode.prototype, "stop").call(mode);

		expect(mode.subagentFoldTimer).toBeUndefined();
		vi.advanceTimersByTime(60 * 60_000);
		expect(fired).not.toHaveBeenCalled();
	});

	it("stop() disposes the retry countdown, the retry loader and the compaction loader", () => {
		const fixture = overlayFixture();
		// The fixture is live: without this the disposal assertions below could pass on a
		// countdown that never ticked at all.
		vi.advanceTimersByTime(1000);
		expect(fixture.onTick).toHaveBeenCalledOnce();

		const mode = stopFake(fixture);
		Reflect.get(InteractiveMode.prototype, "stop").call(mode);

		expectOverlaysDisposed(fixture);
	});

	it("resetCurrentSessionRenderState() disposes them too, so the next session starts clean", () => {
		const fixture = overlayFixture();
		vi.advanceTimersByTime(1000);
		expect(fixture.onTick).toHaveBeenCalledOnce();

		const mode = sessionResetFake(fixture);
		Reflect.get(InteractiveMode.prototype, "resetCurrentSessionRenderState").call(mode);

		expectOverlaysDisposed(fixture);
	});
});

describe("teardownSessionUi handoff placeholder", () => {
	// showStatus colors the line through the global theme proxy.
	beforeAll(() => initTheme("dark"));

	function teardownFake(fields: ModeFake = {}) {
		const frames: string[] = [];
		const chatContainer = new Container();
		const painted = (): string => chatContainer.render(80).join("\n");
		const mode = modeFake({
			chatContainer,
			fullscreenEnabled: true,
			lastStatusText: undefined,
			lastStatusSpacer: undefined,
			releasePromptStashSession: vi.fn(),
			ui: {
				terminal: { drainInput: vi.fn(async () => undefined) },
				requestRender: vi.fn(),
				flushRender: vi.fn(() => frames.push(`paint:${painted()}`)),
			},
			// stop() is what freezes the frame, so it is the ordering witness here.
			stop: vi.fn(() => frames.push(`stop:${painted()}`)),
			...fields,
		});
		const teardown = (options?: { preserveAltScreen?: boolean }): Promise<void> =>
			Reflect.get(InteractiveMode.prototype, "teardownSessionUi").call(mode, options) as Promise<void>;
		return { mode, frames, chatContainer, teardown };
	}

	/**
	 * The agents view rebuilds its catalogs before it paints anything, so the frame this
	 * session freezes is what the user watches during that gap. The placeholder has to be
	 * painted synchronously: stop() sets `stopped`, and every deferred render bails on it.
	 */
	it("paints the handoff line into the frozen frame before stopping", async () => {
		const { frames, teardown } = teardownFake();

		await teardown({ preserveAltScreen: true });

		expect(frames).toHaveLength(2);
		expect(frames[0]?.startsWith("paint:")).toBe(true);
		expect(frames[0]).toContain("Opening the agents view…");
		expect(frames[1]?.startsWith("stop:")).toBe(true);
		expect(frames[1]).toContain("Opening the agents view…");
	});

	it("still stops the session UI when the placeholder cannot paint", async () => {
		const { mode, frames, teardown } = teardownFake();
		const ui = mode.ui as { flushRender: ReturnType<typeof vi.fn> };
		ui.flushRender.mockImplementation(() => {
			throw new Error("paint blew up");
		});

		await teardown({ preserveAltScreen: true });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toContain("Opening the agents view…");
	});

	it("leaves the frame alone when the terminal is not handed over", async () => {
		const { frames, teardown } = teardownFake();

		await teardown({});

		expect(frames).toEqual(["stop:"]);
	});

	it("does not print into scrollback when the session never went fullscreen", async () => {
		const { frames, teardown } = teardownFake({ fullscreenEnabled: false });

		await teardown({ preserveAltScreen: true });

		expect(frames).toEqual(["stop:"]);
	});
});

describe("subagent panel fold on the parent turn boundary (R1-P1)", () => {
	it("re-applies the panel rows when agent_end stamps the turn boundary", () => {
		// The silent path the pure-function tests cannot reach: nothing else re-runs the
		// fold once a child has settled (child updates stop arriving), so agent_end must
		// recompute the rows itself or "the turn ended" only bites on the 30-minute timer.
		const now = Date.now();
		const child = {
			id: "settled-child",
			label: "settled-child",
			status: "done",
			sessionDir: "/tmp/settled-child",
			lastActivityAt: now - 1000,
		};
		const fake = modeFake({
			connectionState: {
				isStreaming: true,
				activeToolNames: [],
				messageCount: 1,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			},
			subagentSnapshots: new Map([[child.id, child]]),
			rlmNodeId: undefined,
			subagentHistoryExpanded: false,
			subagentParentTurnEndedAt: undefined,
			subagentFoldTimer: undefined,
			subagentSummaryLine: {
				setSubagentRows: vi.fn(),
				setSubagentFoldedCount: vi.fn(),
				invalidate: vi.fn(),
			},
		});
		const line = fake.subagentSummaryLine as {
			setSubagentRows: ReturnType<typeof vi.fn>;
			setSubagentFoldedCount: ReturnType<typeof vi.fn>;
		};

		(fake as { updateConnectionStateFromEvent: (e: { type: string }) => void }).updateConnectionStateFromEvent({
			type: "agent_end",
		});

		expect(fake.subagentParentTurnEndedAt).toBeTypeOf("number");
		// The settled child's activity predates the boundary, so the fold hides it and the
		// header count carries it - proving the event path recomputed the rows.
		expect(line.setSubagentRows).toHaveBeenCalled();
		expect(line.setSubagentFoldedCount).toHaveBeenCalledWith(1);
		const rowsArg = line.setSubagentRows.mock.calls.at(-1)?.[0] as unknown[];
		expect(rowsArg).toEqual([]);
	});
});
