import { Container, Loader, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

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
