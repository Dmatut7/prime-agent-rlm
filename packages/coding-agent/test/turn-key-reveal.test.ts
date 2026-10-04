import { FullscreenViewport } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { TURN_KEY_REVEAL_MARKER, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createReplayHost, modeMethod, type ReplayHost, replayInto } from "./tl-fix-host.js";
import { assistant, T0 } from "./ui-blocks-helpers.js";

/**
 * wave-49 F1: a --resume'd old-format session is taller than the fullscreen
 * window, so its turn head sits above the bottom-glued viewport. The expansion
 * keys (Ctrl+O / Ctrl+T / Ctrl+P and the Alt globals) toggled the turn's state
 * correctly but armed no reveal: the composed frame was row-for-row identical
 * and the key looked dead (no expansion, no toast, zero render). The fix arms
 * a one-shot reveal marker on the toggled turn's head, so the next frame
 * scrolls it into view; a head already on screen does not move.
 *
 * The tests replay the session the way renderSessionContext does, drive the
 * mode's own key handlers, and feed the rendered transcript through a real
 * FullscreenViewport - the assertion is on what lands on screen.
 */

const W = 100;
const WINDOW = 12;

const toggleTools = modeMethod<(this: ReplayHost, global?: boolean) => void>("toggleToolOutputExpansion");
const toggleThinking = modeMethod<(this: ReplayHost, global?: boolean) => void>("toggleThinkingBlockVisibility");
const toggleMessages = modeMethod<(this: ReplayHost, global?: boolean) => void>("toggleAgentMessageExpansion");

interface UiProbe {
	ui: ReplayHost["ui"];
	markers: (string | undefined)[];
	toasts: string[];
}

/** A fullscreen ui stand-in: records the reveal markers and toasts the mode raises. */
function fullscreenUi(): UiProbe {
	const markers: (string | undefined)[] = [];
	const toasts: string[] = [];
	return {
		markers,
		toasts,
		ui: {
			requestRender: () => {},
			requestRenderPreservingViewport: () => {},
			isFullscreen: () => true,
			setFullscreenRevealMarker: (marker: string | undefined) => {
				markers.push(marker);
			},
			terminal: { rows: 40, columns: W },
		},
	};
}

async function replayedOldFormatTurn(ui: UiProbe): Promise<ReplayHost> {
	const host = createReplayHost();
	host.ui = ui.ui;
	host.showToast = (message: string) => {
		ui.toasts.push(message);
	};
	host.showStatus = (message: string) => {
		ui.toasts.push(message);
	};
	// The shape of a 2026-09 session (F1's repro): one owner question, thinking +
	// tool steps, then a final answer long enough to push the turn head above a
	// small window. The thinking says more than its one-line summary so its box
	// rows carry an expandable detail (timeline-rows.ts saysMoreThan).
	const finalAnswer = Array.from({ length: 30 }, (_, index) => `FINAL_LINE_${index}`).join("\n");
	await replayInto(host, [
		{ role: "user", content: "老会话的问题", timestamp: T0 },
		assistant(T0 + 1000, [
			{
				type: "thinking",
				thinking: "THINKTRACE_WORD 第一段。然后还有第二句分析，说明细节超过摘要。",
			},
			{ type: "text", text: "TURNHEAD_WORD 先查引用" },
			{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
		]),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "ipython",
			content: [{ type: "text", text: "1" }],
			isError: false,
			timestamp: T0 + 2000,
		},
		assistant(T0 + 3000, [
			{
				type: "thinking",
				thinking: "THINKTRACE_WORD 第二段。同样带第二句，让细节超过一行摘要。",
			},
			{ type: "text", text: "再读文件" },
			{ type: "toolCall", id: "c2", name: "ipython", arguments: { code: "print(2)" } },
		]),
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "ipython",
			content: [{ type: "text", text: "2" }],
			isError: false,
			timestamp: T0 + 4000,
		},
		assistant(T0 + 5000, [{ type: "text", text: finalAnswer }], "stop"),
	]);
	return host;
}

/** The chat as the fullscreen transcript's raw lines (markers kept). */
function transcriptLines(host: ReplayHost): string[] {
	return host.chatContainer.children.flatMap((child) => child.render(W));
}

function plainText(lines: readonly string[]): string {
	return stripAnsi(lines.join("\n")).replace(/\x1b_[^\x07]*\x07/g, "");
}

function latestSummary(host: ReplayHost): TurnSummaryComponent {
	const summaries = host.chatContainer.children.filter(
		(child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent,
	);
	const summary = summaries.at(-1);
	if (!summary) throw new Error("replay produced no turn summary");
	return summary;
}

beforeAll(() => {
	initTheme("prime");
});

describe("turn key reveal (wave-49 F1)", () => {
	it("Ctrl+O on a resumed turn taller than the window reveals the expanded box", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);

		const viewport = new FullscreenViewport();
		const before = viewport.composeFrame(transcriptLines(host), [], WINDOW);
		expect(plainText(before)).not.toContain("TURNHEAD_WORD");
		expect(plainText(before)).toContain("FINAL_LINE_29");

		toggleTools.call(host);

		expect(ui.toasts).toEqual([]);
		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		const lines = transcriptLines(host);
		expect(lines.some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(true);

		// The mode handed the marker to the ui; the next frame reveals its row.
		viewport.setRevealMarker(ui.markers.at(-1));
		const after = viewport.composeFrame(lines, [], WINDOW);
		const afterText = plainText(after);
		expect(afterText).toContain("TURNHEAD_WORD");
		// The box is open: its steps are on screen now.
		expect(afterText).toContain("print(1)");
		// The marker is stripped by the frame, never painted.
		expect(after.some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(false);
		expect(viewport.scrollInfo().following).toBe(false);
	});

	it("Ctrl+T on a resumed turn reveals the opened thinking rows", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);

		const viewport = new FullscreenViewport();
		const before = viewport.composeFrame(transcriptLines(host), [], WINDOW);
		expect(plainText(before)).not.toContain("THINKTRACE_WORD");

		toggleThinking.call(host);

		expect(ui.toasts).toEqual([]);
		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		viewport.setRevealMarker(ui.markers.at(-1));
		const after = viewport.composeFrame(transcriptLines(host), [], WINDOW);
		expect(plainText(after)).toContain("THINKTRACE_WORD");
	});

	it("Ctrl+P flips the turn's comms lane and arms the same reveal", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);
		toggleMessages.call(host);
		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		expect(latestSummary(host).state.agentMessagesExpanded).toBe(true);
	});

	it("Alt+O (global) reveals the latest turn's head", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);

		const viewport = new FullscreenViewport();
		viewport.composeFrame(transcriptLines(host), [], WINDOW);

		toggleTools.call(host, true);

		expect(ui.toasts).toEqual([]);
		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		expect(latestSummary(host).state.processBlockExpanded).toBe(true);
		viewport.setRevealMarker(ui.markers.at(-1));
		const after = viewport.composeFrame(transcriptLines(host), [], WINDOW);
		expect(plainText(after)).toContain("TURNHEAD_WORD");
	});

	it("a turn head already on screen does not move (fresh-session behavior holds)", async () => {
		const ui = fullscreenUi();
		const host = createReplayHost();
		host.ui = ui.ui;
		host.showToast = (message: string) => {
			ui.toasts.push(message);
		};
		host.showStatus = () => {};
		// A short turn: head and tail fit one window even after the box opens.
		await replayInto(host, [
			{ role: "user", content: "小会话", timestamp: T0 },
			assistant(T0 + 1000, [
				{ type: "text", text: "TURNHEAD_WORD 只有一步" },
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
			]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: T0 + 2000,
			},
			assistant(T0 + 3000, [{ type: "text", text: "SHORT_TAIL 答完了" }], "stop"),
		]);

		// A window tall enough to show the whole transcript: the head is visible.
		const viewport = new FullscreenViewport();
		const fullHeight = 60;
		const before = viewport.composeFrame(transcriptLines(host), [], fullHeight);
		expect(plainText(before)).toContain("TURNHEAD_WORD");
		expect(viewport.scrollInfo().following).toBe(true);

		toggleTools.call(host);

		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		viewport.setRevealMarker(ui.markers.at(-1));
		const after = viewport.composeFrame(transcriptLines(host), [], fullHeight);
		// The reveal sees the marked row inside the window and never scrolls.
		expect(viewport.scrollInfo().following).toBe(true);
		expect(plainText(after)).toContain("SHORT_TAIL");
		expect(plainText(after)).toContain("TURNHEAD_WORD");
	});

	it("inline mode arms nothing: the marker never leaks into un-stripped output", async () => {
		const host = createReplayHost();
		const markers: (string | undefined)[] = [];
		host.ui = {
			requestRender: () => {},
			requestRenderPreservingViewport: () => {},
			isFullscreen: () => false,
			setFullscreenRevealMarker: (marker: string | undefined) => {
				markers.push(marker);
			},
			terminal: { rows: 40, columns: W },
		};
		host.showToast = () => {};
		host.showStatus = () => {};
		await replayInto(host, [
			{ role: "user", content: "inline", timestamp: T0 },
			assistant(T0 + 1000, [
				{ type: "thinking", thinking: "traces" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
			]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: T0 + 2000,
			},
		]);

		toggleTools.call(host);
		toggleThinking.call(host);

		expect(markers).toEqual([]);
		expect(transcriptLines(host).some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(false);
	});

	it("the reveal marker is one-shot: only the next render carries it", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);
		toggleTools.call(host);
		expect(transcriptLines(host).some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(true);
		expect(transcriptLines(host).some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(false);
	});

	it("the legacy (verbose) turn head arms the same reveal", async () => {
		const ui = fullscreenUi();
		const host = await replayedOldFormatTurn(ui);
		const settings = host.settingsManager as { getProcessMode: () => string };
		settings.getProcessMode = () => "verbose";
		await replayInto(host, [
			{ role: "user", content: "老会话的问题", timestamp: T0 },
			assistant(T0 + 1000, [
				{ type: "thinking", thinking: "THINKTRACE_WORD 第一段" },
				{ type: "text", text: "TURNHEAD_WORD 先查引用" },
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
			]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: T0 + 2000,
			},
			assistant(T0 + 3000, [{ type: "text", text: "答完了" }], "stop"),
		]);
		expect(latestSummary(host).state.boxMode).toBe(false);

		toggleTools.call(host);

		expect(ui.markers).toEqual([TURN_KEY_REVEAL_MARKER]);
		expect(transcriptLines(host).some((line) => line.includes(TURN_KEY_REVEAL_MARKER))).toBe(true);
	});
});
