import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, StallActions, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type StallWarningEvent = Extract<AgentConnectionSessionEvent, { type: "stall_warning" }>;

/**
 * The stall action bar lifecycle in the interactive host (r4 recovery-shell
 * phase-2 fixes): mount on stall_warning, teardown when the warning's turn is
 * over (turn_end mid-run, agent_end for the run - the paths a naturally
 * finished turn and the daemon's recovery abort both take), re-mount on the
 * next warning, and the F3 countdown the daemon arms on the wire.
 *
 * Driven through the real `handleEvent` with a partial-mode fake, the same
 * harness pattern as interactive-mode-streaming.test.ts: the methods under
 * test (mountStallActionBar, removeStallActionBar) run for real; everything
 * around them is stubbed.
 */
type ModeFake = Record<string, unknown>;

type HandleEvent = (this: ModeFake, event: AgentConnectionSessionEvent) => Promise<void>;

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

function stallWarning(overrides: Partial<StallWarningEvent> = {}): StallWarningEvent {
	return {
		type: "stall_warning",
		message: "Possible stall: no session activity for 312s while a turn is running.",
		silentMs: 312_000,
		thresholdMs: 300_000,
		...overrides,
	};
}

function armedActions(atMs: number): StallWarningEvent["actions"] {
	return {
		canAbort: true,
		canDiagnose: true,
		autoRecoveryArmed: true,
		executor: "daemon",
		autoRecoveryAtMs: atMs,
	};
}

function chatOf(mode: ModeFake): Container {
	return mode.chatContainer as Container;
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

function countdownLine(rendered: string): string | undefined {
	return rendered
		.split("\n")
		.map((line) => line.trimEnd())
		.find((line) => line.includes("将自动处理"));
}

describe("InteractiveMode stall action bar lifecycle", () => {
	let removeInputListener: ReturnType<typeof vi.fn>;
	let addInputListener: ReturnType<typeof vi.fn>;
	let requestRender: ReturnType<typeof vi.fn>;

	function createModeFake(): ModeFake {
		const fake: ModeFake = {
			isInitialized: true,
			settingsManager: { getShowTerminalProgress: () => false },
			footer: { invalidate: vi.fn() },
			connectionState: undefined,
			activityTracker: { handleEvent: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			applyOptimisticContextUsage: vi.fn(),
			refreshConnectionContextUsage: vi.fn(async () => {}),
			checkShutdownRequested: vi.fn(async () => {}),
			showError: vi.fn(),
			ui: { requestRender, addInputListener },
			// turn_end merges the turn's file changes, which resolves paths
			// against the session cwd.
			uiServices: { getInitialCwd: () => "/tmp" },
			// The stall bar's own state: starts empty; the real prototype methods
			// under test own it from here on.
			keybindings: new KeybindingsManager(),
			chatContainer: new Container(),
			stallActionBar: undefined,
			removeStallActionInputListener: undefined,
			// agent_end path needs (streams nothing, owns nothing):
			turnStartedAt: 1,
			currentTurnState: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingBashComponents: [],
			agentRunFileChanges: new Map(),
			recapContainer: undefined,
			syncWorkingLoader: vi.fn(),
			resetPendingToolState: vi.fn(),
			renderRecap: vi.fn(),
			// The subagent spend cell with no family: scheduleSubagentSpendRefresh
			// takes the clear branch and touches none of the timers.
			terminalSuspended: false,
			subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
			subagentSummaryLine: { setSubagentSpend: vi.fn() },
			subagentSpendTickIntervalMs: 0,
			subagentSpendTickTimer: undefined,
			subagentSpendTimer: undefined,
			subagentSpendTimerDeadline: 0,
			subagentSpendTimerForced: false,
			subagentSpendRescanRequested: false,
			subagentSpendRescanForced: false,
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return fake;
	}

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// mountStallActionBar resolves the interrupt label from the real global
		// keybindings table (B2), so the app defaults must be installed.
		setKeybindings(new KeybindingsManager());
		removeInputListener = vi.fn();
		addInputListener = vi.fn(() => removeInputListener);
		requestRender = vi.fn();
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("blind2-F6/blind3-7: agent_end settles the bar: no interrupt left, the diagnostics key still works", async () => {
		const mode = createModeFake();

		await handleEvent.call(mode, stallWarning({ actions: armedActions(Date.now() + 120_000) }));

		const bar = mode.stallActionBar;
		expect(bar).toBeDefined();
		expect(chatOf(mode).children).toContain(bar);
		expect(addInputListener).toHaveBeenCalledTimes(1);
		expect(removeInputListener).not.toHaveBeenCalled();

		// The run ends - no terminal stall stage fires. The bar can no longer
		// interrupt the turn, but the stall's diagnostics are still worth a key:
		// the quiet-step rule stops a silent call right as the warning fires, so
		// removing the bar here made Ctrl+Y dead a moment after it was offered.
		await handleEvent.call(mode, { type: "agent_end", messages: [] });

		const settled = mode.stallActionBar as StallActions | undefined;
		expect(settled).toBeInstanceOf(StallActions);
		expect(settled).not.toBe(bar);
		expect(chatOf(mode).children).not.toContain(bar);
		expect(chatOf(mode).children).toContain(settled);
		const rendered = renderChat(chatOf(mode));
		expect(rendered).toContain("现在已经接着往下走了");
		expect(rendered).toContain("看诊断详情");
		expect(rendered).not.toContain("中断这一轮");
		expect(countdownLine(rendered)).toBeUndefined();

		// Ctrl+Y on the settled bar shows the forensic lines and takes the bar down.
		expect(settled?.handleInput("\x19")).toBe(true);
		// A dim, titled reference block - nothing failed, so never the error channel.
		expect(mode.showError).not.toHaveBeenCalled();
		expect(renderChat(chatOf(mode))).toContain("诊断详情");
		expect(renderChat(chatOf(mode))).toContain("stage: stall_warning");
		expect(mode.stallActionBar).toBeUndefined();
		expect(chatOf(mode).children).not.toContain(settled);
	});

	it("the diagnostics key closes the diagnostics block it opened; other keys pass through", async () => {
		const mode = createModeFake();
		await handleEvent.call(mode, stallWarning());
		const bar = mode.stallActionBar as StallActions;
		const before = chatOf(mode).children.length;

		expect(bar.handleInput("\x19")).toBe(true);
		const opened = renderChat(chatOf(mode));
		expect(opened).toContain("stage: stall_warning");
		expect(opened).toMatch(/ctrl\+y 收起/i);
		const closeRoute = addInputListener.mock.calls.at(-1)?.[0] as (data: string) => { consume?: boolean } | undefined;
		expect(closeRoute).toBeTypeOf("function");

		// Typing goes on to the editor and leaves the block open.
		expect(closeRoute("a")).toBeUndefined();
		expect(renderChat(chatOf(mode))).toContain("stage: stall_warning");

		const removedBefore = removeInputListener.mock.calls.length;
		expect(closeRoute("\x19")).toEqual({ consume: true });
		expect(renderChat(chatOf(mode))).not.toContain("诊断详情");
		expect(chatOf(mode).children.length).toBe(before - 1);
		expect(removeInputListener.mock.calls.length).toBe(removedBefore + 1);
	});

	it("blind3-7: turn_end mid-run settles the stale bar too", async () => {
		const mode = createModeFake();
		// A stalled turn emits no turn_end, so a live bar at a turn_end means the
		// warning's turn went on (recovered). Its interrupt promise goes; its
		// diagnostics stay one key away.
		await handleEvent.call(mode, stallWarning({ actions: armedActions(Date.now() + 120_000) }));
		const bar = mode.stallActionBar;
		expect(bar).toBeDefined();

		await handleEvent.call(mode, { type: "turn_end", message: fauxAssistantMessage("recovered"), toolResults: [] });

		expect(mode.stallActionBar).toBeDefined();
		expect(mode.stallActionBar).not.toBe(bar);
		expect(renderChat(chatOf(mode))).not.toContain("中断这一轮");
		// Settling twice (turn_end, then agent_end) keeps the one settled bar.
		const settled = mode.stallActionBar;
		await handleEvent.call(mode, { type: "agent_end", messages: [] });
		expect(mode.stallActionBar).toBe(settled);
	});

	it("the teardown is not a latch: the next warn re-mounts a fresh bar and re-registers the route", async () => {
		const mode = createModeFake();
		await handleEvent.call(mode, stallWarning());
		const firstBar = mode.stallActionBar;
		expect(firstBar).toBeDefined();

		await handleEvent.call(mode, { type: "agent_end", messages: [] });
		const settled = mode.stallActionBar;
		expect(settled).toBeDefined();

		// A NEW turn that warns again must get a NEW live bar: settling on turn
		// end is recovery, not disarming.
		await handleEvent.call(mode, stallWarning({ silentMs: 420_000 }));

		const secondBar = mode.stallActionBar;
		expect(secondBar).toBeDefined();
		expect(secondBar).not.toBe(firstBar);
		expect(secondBar).not.toBe(settled);
		expect(chatOf(mode).children).toContain(secondBar);
		expect(chatOf(mode).children).not.toContain(firstBar);
		expect(chatOf(mode).children).not.toContain(settled);
		// The mounted bar is the NEW event's, not the torn-down one's: the
		// summary line carries this warning's own silence reading.
		expect(renderChat(chatOf(mode))).toContain("已经 7 分钟没有动静");
		expect(renderChat(chatOf(mode))).toContain("中断这一轮");
	});

	it("F3: the daemon-armed deadline reaches the bar as a static countdown line", async () => {
		const t0 = 1_700_000_000_000;
		vi.useFakeTimers({ now: t0 });
		const mode = createModeFake();

		await handleEvent.call(mode, stallWarning({ actions: armedActions(t0 + 120_000) }));

		const rendered = renderChat(chatOf(mode));
		expect(rendered).toMatch(/\d{2}:\d{2}:\d{2} 将自动处理（还有 120 秒）/);
		// The countdown is the daemon's fact, not a host promise about input:
		// until the daemon lane's F1 input accounting lands, no "input keeps this
		// turn alive" claim may ship.
		expect(rendered).not.toContain("any input keeps this turn alive");
		// The line is static and this host adds no ticker of its own: the TUI
		// already repaints while a turn streams (working loader + chat pulse).
		expect(vi.getTimerCount()).toBe(0);

		// One minute later an ordinary repaint derives the line from the bar's
		// own clock: the countdown moves, and still no timer was created.
		vi.setSystemTime(t0 + 60_000);
		const ticked = countdownLine(renderChat(chatOf(mode)));
		expect(ticked).toMatch(/还有 60 秒/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("F3: an in-process warn (no actions field) mounts the bar without inventing a countdown", async () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const mode = createModeFake();

		await handleEvent.call(mode, stallWarning());

		expect(mode.stallActionBar).toBeDefined();
		const rendered = renderChat(chatOf(mode));
		expect(rendered).toContain("Esc 中断这一轮");
		expect(countdownLine(rendered)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("F3: an unarmed daemon actions field mounts no countdown either", async () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const mode = createModeFake();

		await handleEvent.call(
			mode,
			stallWarning({
				actions: { canAbort: true, canDiagnose: true, autoRecoveryArmed: false, executor: "daemon" },
			}),
		);

		expect(mode.stallActionBar).toBeDefined();
		const rendered = renderChat(chatOf(mode));
		expect(countdownLine(rendered)).toBeUndefined();
		// No field means the bar renders exactly the pre-F3 lines: one per action
		// plus the summary and the dismiss note.
		expect(rendered.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(4);
		expect(vi.getTimerCount()).toBe(0);
	});
});
