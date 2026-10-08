import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type ResetCurrentSessionRenderState = (this: ModeFake, options?: { clearPromptStash?: boolean }) => void;

type CreateLiveTurnFlowHost = (this: ModeFake) => {
	setCurrent(summary: { addCommMessage(): void; state: unknown }): void;
};

const resetCurrentSessionRenderState = (
	InteractiveMode.prototype as unknown as { resetCurrentSessionRenderState: ResetCurrentSessionRenderState }
).resetCurrentSessionRenderState;

const createLiveTurnFlowHost = (
	InteractiveMode.prototype as unknown as { createLiveTurnFlowHost: CreateLiveTurnFlowHost }
).createLiveTurnFlowHost;

/**
 * W9-A lane, audit item 8.4: a pending wake comm must not survive a session switch.
 *
 * A subagent report that lands between turns (quota park broke the last run, the
 * next one has not started) is held in pendingWakeComms and counted into the turn
 * it wakes. resetCurrentSessionRenderState clears every other piece of
 * session-scoped turn state on session_replaced, so the held comm of session A
 * must go with it: session B's first turn is created with 0 comms, matching the
 * count B's own replay derives from its transcript.
 */

/** The editor stub both branches of the editor reset can run against. */
function editorStub(): { clearHistory: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> } {
	return { clearHistory: vi.fn(), setText: vi.fn() };
}

function switchFake(): ModeFake {
	const editor = editorStub();
	const defaultEditor = editorStub();
	const mode: ModeFake = {
		// Session A's held comm: one report landed between its turns.
		pendingWakeComms: 1,
		currentTurnSummary: undefined,
		currentTurnState: undefined,
		// Everything resetCurrentSessionRenderState touches beyond the fields under
		// test; the same stub list as the session-replacement fake in
		// interactive-mode-ctrl-c.test.ts.
		endFeatureHintRun: vi.fn(),
		resetBlockNavigation: vi.fn(),
		chatContainer: { clear: vi.fn() },
		shortcutGuideContainer: { clear: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		queuedMessagesContainer: { clear: vi.fn() },
		pendingQueueEdit: undefined,
		pendingQueueMove: false,
		queueSelection: { reset: vi.fn() },
		featureHintSuppressedByQueue: false,
		promptStash: undefined,
		promptStashState: {},
		defaultEditor,
		editor,
		ui: { requestRender: vi.fn(), terminal: { abortPendingInput: vi.fn() } },
		liveImageMarkerIds: vi.fn(() => new Set()),
		pastedImages: new Map(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		activeBashComponent: undefined,
		discardRefineLoader: vi.fn(),
		disposeTransientStatusOverlays: vi.fn(),
		removeStallActionBar: vi.fn(),
		releaseStallDiagnostics: vi.fn(),
		clearCtrlCExitHint: vi.fn(),
		clearEscapeRepeat: vi.fn(),
		stopAllSubagentsArmed: undefined,
		pendingBashComponents: [],
		activityTracker: { reset: vi.fn() },
		contextUsageTokenBaseline: 0,
		footerSessionCost: undefined,
		pendingToolGeneration: 0,
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		agentRunFileChanges: new Map(),
		renderRecap: vi.fn(),
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		chatTranscriptTrimmed: true,
		chatCapRebuildFloor: 1,
		slimTranscriptOmitted: 5,
		slimTranscriptBackfillInFlight: false,
		slimTranscriptMarker: undefined,
		slimTranscriptViewEpoch: 0,
		slimOrphanToolResults: new Map(),
		liveTurnFlowStore: { reset: vi.fn() },
		resetSubagentSummary: vi.fn(),
		sessionHasImages: false,
		setGoalAnnouncementBaseline: vi.fn(),
		getGoalState: vi.fn(() => ({})),
		syncGoalTray: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return mode;
}

function firstTurnOf(mode: ModeFake): { addCommMessage: ReturnType<typeof vi.fn>; state: unknown } {
	const host = createLiveTurnFlowHost.call(mode);
	const summary = { addCommMessage: vi.fn(), state: {} };
	host.setCurrent(summary);
	return summary;
}

beforeAll(() => {
	initTheme("dark");
});

describe("a session switch resets the pending wake comms", () => {
	it("counts session A's held comm into A's next turn, not into session B's first turn", () => {
		const mode = switchFake();

		// The harness sees the held comm: A's own next turn still wakes with it.
		const wokenInA = firstTurnOf(mode);
		expect(wokenInA.addCommMessage).toHaveBeenCalledTimes(1);

		// A second report lands between turns after that turn closed.
		mode.pendingWakeComms = 1;
		mode.currentTurnSummary = undefined;

		// The owner switches sessions: session_replaced walks the reset.
		resetCurrentSessionRenderState.call(mode);

		// Session B's first turn is created through the same setCurrent: its comm
		// count starts at 0 (B's replay derives 0 from B's own transcript).
		const firstTurnInB = firstTurnOf(mode);
		expect(firstTurnInB.addCommMessage).not.toHaveBeenCalled();
		expect(mode.pendingWakeComms).toBe(0);
	});

	it("leaves a session with no held comms at 0 across the switch", () => {
		const mode = switchFake();
		mode.pendingWakeComms = 0;
		resetCurrentSessionRenderState.call(mode);
		expect(firstTurnOf(mode).addCommMessage).not.toHaveBeenCalled();
		expect(mode.pendingWakeComms).toBe(0);
	});
});
