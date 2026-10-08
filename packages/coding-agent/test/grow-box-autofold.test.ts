import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import type { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, assistant, host, plain, type QuietTurn, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/** Past the settle a finished box waits for (a retry or a compaction may still carry it on). */
const SETTLE_MS = 500;

beforeAll(() => {
	initTheme("prime");
});

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
});

let counter = 0;

/** One reply of the live run that calls `count` commands, each started and finished, as the interactive mode feeds them. */
function runSteps(live: LiveChat, count: number, stopReason: "stop" | "toolUse" = "stop"): void {
	const started = Date.now();
	const calls = Array.from({ length: count }, () => {
		counter += 1;
		return {
			type: "toolCall" as const,
			id: `call-${counter}`,
			name: "ipython",
			arguments: { code: `await bash('echo ${counter}')` },
		};
	});
	live.flow.assistantStart(assistant(started, calls, "toolUse"));
	for (const call of calls) {
		live.flow.noteToolCall(call, false);
		live.flow.toolStart(call.id, call.name, call.arguments);
	}
	for (const call of calls) {
		live.flow.toolEnd(call.id, call.name, { content: [{ type: "text", text: "ok" }] }, false);
	}
	live.flow.assistantEnd(assistant(started, calls, stopReason));
}

/** A prompt whose run does `count` steps and ends; the box is now settling. */
function promptWithSteps(live: LiveChat, count: number): void {
	live.flow.agentStart();
	live.flow.userMessage("go", Date.now());
	runSteps(live, count);
	live.flow.agentEnd();
}

/** The user opens a running turn's steps to read them: an opening of their own, made while it ran. */
function openByHand(box: TurnSummaryComponent | undefined): void {
	box?.toggleBox();
}

/** The steps a turn lists: a step line is `$  echo N`. */
function bodyRows(lines: readonly string[]): number {
	return plain(lines).filter((line) => /\$ +echo/.test(line)).length;
}

/** Open the turn's first event and list every step under it (`全部 ›`). */
function listAll(turn: QuietTurn): void {
	turn.summary.render(100);
	const event = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:"));
	if (!event) throw new Error("the turn has no event");
	if (!turn.timeline.ui.expanded.has(event)) turn.summary.activate(event);
	turn.summary.render(100);
	const all = turn.summary.getFocusOrder().find((key) => key.startsWith("all:"));
	if (all) turn.summary.activate(all);
}

describe("a box that finished folds on its own", () => {
	it("folds an opening the user made while the turn still ran", () => {
		vi.useFakeTimers({ now: T0 });
		const turn = quietTurn({ host: host({ openWhileWorking: () => false }) });
		addCommand(turn, "c1", "npm test");
		expect(turn.state.boxOpen).toBe(false);
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(true);

		turn.state.markTurnEnded();
		turn.state.finishBox();
		vi.advanceTimersByTime(SETTLE_MS);

		expect(turn.state.boxOpen).toBe(false);
		expect(plain(turn.summary.render(100)).join("\n")).not.toContain("npm test");
	});

	it("folds a box the user opened while the turn ran, once the turn is over", () => {
		vi.useFakeTimers({ now: T0 });
		const live = new LiveChat();
		live.flow.agentStart();
		live.flow.userMessage("go", Date.now());
		runSteps(live, 2);
		const [box] = live.summaries();
		openByHand(box);
		expect(box?.state.boxOpen).toBe(true);
		expect(bodyRows(box?.render(100) ?? [])).toBe(2);
		live.flow.agentEnd();
		vi.advanceTimersByTime(SETTLE_MS);

		expect(box?.state.boxLive).toBe(false);
		expect(box?.state.boxOpen).toBe(false);
		expect(bodyRows(box?.render(100) ?? [])).toBe(0);
	});

	it("keeps a box the user closed while the turn ran closed", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "npm test");
		// Nothing is open by default, while the turn runs or after.
		expect(turn.state.boxOpen).toBe(false);
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(true);
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(false);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.state.boxOpen).toBe(false);
	});

	it("respects an opening the user made after the turn finished", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "npm test");
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.state.boxOpen).toBe(false);
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(true);
		expect(plain(turn.summary.render(100)).join("\n")).toContain("npm test");
	});

	it("ignores the setting that keeps finished boxes open: the box folds whatever the user did before it ended", () => {
		const idle = quietTurn({ host: host({ autoFold: () => false }) });
		addCommand(idle, "c1", "npm test");
		idle.state.markTurnEnded();
		idle.state.finishBox();
		expect(idle.state.boxOpen).toBe(false);
		expect(plain(idle.summary.render(100)).join("\n")).not.toContain("npm test");

		const opened = quietTurn({ host: host({ autoFold: () => false }) });
		addCommand(opened, "c1", "npm test");
		opened.summary.toggleBox();
		expect(opened.state.boxOpen).toBe(true);
		opened.state.markTurnEnded();
		opened.state.finishBox();
		expect(opened.state.boxOpen).toBe(false);
	});

	it("keeps a box the user opened after it ended open through a retry that carries it on, and folds it when the turn ends again", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "npm test");
		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(true);
		turn.state.reopen();
		expect(turn.state.boxOpen).toBe(true);
		expect(plain(turn.summary.render(100)).join("\n")).toContain("npm test");
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.state.boxOpen).toBe(false);
	});
});

describe("a turn a subagent's report wakes right after it ended", () => {
	it("leaves every earlier box folded while the next one runs, also when the wake comes inside the settle", () => {
		vi.useFakeTimers({ now: T0 });
		const live = new LiveChat();
		promptWithSteps(live, 3);
		vi.advanceTimersByTime(100);
		const [first] = live.summaries();
		// The user had opened the running box to read it.
		openByHand(first);
		expect(first?.state.boxOpen).toBe(true);

		live.wake("report-1");
		vi.advanceTimersByTime(SETTLE_MS);

		expect(live.summaries()).toHaveLength(2);
		expect(first?.state.boxLive).toBe(false);
		expect(first?.state.boxOpen).toBe(false);
		expect(bodyRows(first?.render(100) ?? [])).toBe(0);
	});

	it("folds each box before the one after it, three reports in a row, however they were opened", () => {
		vi.useFakeTimers({ now: T0 });
		const live = new LiveChat();
		promptWithSteps(live, 2);
		openByHand(live.summaries()[0]);
		vi.advanceTimersByTime(SETTLE_MS);
		live.wake("report-1");
		openByHand(live.summaries()[1]);
		live.wake("report-2");
		openByHand(live.summaries()[2]);
		vi.advanceTimersByTime(SETTLE_MS);

		const boxes = live.summaries();
		expect(boxes.length).toBeGreaterThanOrEqual(3);
		expect(boxes.every((box) => !box.state.boxLive)).toBe(true);
		expect(boxes.map((box) => box.state.boxOpen)).toEqual(boxes.map(() => false));
		expect(boxes.map((box) => bodyRows(box.render(100)))).toEqual(boxes.map(() => 0));
	});

	it("keeps an earlier box open that the user opened after it finished, while the next one runs", () => {
		vi.useFakeTimers({ now: T0 });
		const live = new LiveChat();
		promptWithSteps(live, 2);
		vi.advanceTimersByTime(SETTLE_MS);
		const [first] = live.summaries();
		first?.toggleBox();
		expect(first?.state.boxOpen).toBe(true);
		live.wake("report-1");
		vi.advanceTimersByTime(SETTLE_MS);

		expect(first?.state.boxOpen).toBe(true);
		expect(bodyRows(first?.render(100) ?? [])).toBeGreaterThan(0);
		expect(live.summaries()[1]?.state.boxOpen).toBe(false);
	});
});

describe("a replayed box", () => {
	it("stays folded", () => {
		const turn = quietTurn({ live: false });
		addCommand(turn, "c1", "npm test");
		turn.state.markTurnEnded();
		expect(turn.state.boxOpen).toBe(false);
		const shown = plain(turn.summary.render(100));
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatch(/跑了 1 条命令 +1 步 ▸ {2}$/);
		expect(shown.join("\n")).not.toContain("npm test");
	});
});

describe("expand-all (Ctrl+O) on a failed turn", () => {
	it("opens the fail event's detail, not just step lists", () => {
		// A turn that ended on a model error: its fail event has no steps and no
		// `more`, only the failed row's detail (why it failed). The event line
		// shows the error's first line; the rest only shows when the row is open.
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			{
				...assistant(T0 + 1_000, [], "error"),
				errorMessage: "boom: model exploded\nstack line two\nstack line three",
			},
			true,
		);
		turn.state.markTurnEnded();
		const events = turn.state.boxView().events;
		const fail = events.find((event) => event.kind === "fail");
		expect(fail, "the failed turn shows its failure as an event").toBeDefined();
		expect(fail?.row?.detail, "the fail row carries its reason").toBeDefined();

		const closed = plain(turn.summary.render(100)).join("\n");
		expect(closed).toContain("boom: model exploded");
		expect(closed).not.toContain("stack line two");

		turn.summary.toggleBox();
		const shown = plain(turn.summary.render(100)).join("\n");
		expect(shown).toContain("stack line two");
	});
});

describe("a wake report's join to the row above it", () => {
	it("a steer (or any timeline entry) between two reports blocks the join", () => {
		const turn = quietTurn();
		const row: Component = { render: () => ["report"], invalidate: () => {} };
		turn.summary.addInlineRow(row, T0 + 1_000);
		// Nothing between them: the next report joins the row above.
		expect(turn.summary.inlineRowBefore(T0 + 3_000)).toBe(row);
		// An interjection at T0+2_000 sits between them: no join across it.
		turn.timeline.addSteer("等等", T0 + 2_000);
		expect(turn.summary.inlineRowBefore(T0 + 3_000)).toBeUndefined();
	});
});

describe("the turn-end fold", () => {
	it("re-anchors the keyboard focus a fold took away, instead of stranding it on a vanished row", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "npm test");
		// Open the event so its step rows are focusable, then focus a step row.
		turn.summary.render(100);
		const event = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:"));
		if (!event) throw new Error("the turn has no event");
		turn.summary.activate(event);
		turn.summary.render(100);
		const stepKey = turn.summary
			.getFocusOrder()
			.find((key) => !key.startsWith("ev:") && !key.startsWith("all:") && key !== "header");
		expect(stepKey, "an open event lists its step rows").toBeDefined();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = stepKey;

		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.render(100);

		const order = turn.summary.getFocusOrder();
		expect(order, "focus re-anchors to a row the box still shows").toContain(turn.timeline.ui.focusKey);
		expect(turn.summary.activate(turn.timeline.ui.focusKey ?? "header"), "Enter works on the re-anchored row").toBe(
			true,
		);
	});
	it("folds a long body at once instead of line by line", () => {
		vi.useFakeTimers({ now: T0 });
		const turn = quietTurn({ host: host({ viewportRows: () => 200 }) });
		for (let index = 0; index < 40; index++) addCommand(turn, `c${index}`, `echo ${index}`);
		listAll(turn);
		// The event line, forty steps, the `▴ 收起` line, a blank rail line and the spinner line.
		const before = turn.summary.render(100).length;
		expect(before).toBe(44);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.summary.render(100)).toHaveLength(1);
	});

	it("folds a short body at once too, with no line-by-line animation in between", () => {
		vi.useFakeTimers({ now: T0 });
		const turn = quietTurn({ host: host({ viewportRows: () => 40 }) });
		for (let index = 0; index < 3; index++) addCommand(turn, `c${index}`, `echo ${index}`);
		listAll(turn);
		// The event line, three steps, a blank rail line and the spinner line.
		expect(turn.summary.render(100)).toHaveLength(6);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.summary.render(100)).toHaveLength(1);
		vi.advanceTimersByTime(150);
		expect(turn.summary.render(100)).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(turn.summary.render(100)).toHaveLength(1);
	});

	it("folds at once when motion is reduced, as it does when it is not", () => {
		vi.useFakeTimers({ now: T0 });
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 40 }) });
		for (let index = 0; index < 3; index++) addCommand(turn, `c${index}`, `echo ${index}`);
		listAll(turn);
		expect(turn.summary.render(100)).toHaveLength(6);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.summary.render(100)).toHaveLength(1);
	});
});
