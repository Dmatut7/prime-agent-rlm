import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ChangeEntry } from "../src/modes/interactive/components/feed-data.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import type { TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function assistant(timestamp: number, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function host(): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 20,
		openWhileWorking: () => true,
		autoFold: () => false,
		requestRender: vi.fn(),
	};
}

/** A live turn: its lines grow with it and nothing is open until an event or a step is clicked. */
function liveTurn() {
	const state = new TurnActivityState(Date.now() - 5_000);
	state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

type Turn = ReturnType<typeof liveTurn>;

/** One finished command step whose row opens to its output. */
function addCommand(turn: Turn, index: number, at: number): void {
	const id = `s${index}`;
	const code = `await bash('echo ${index}')`;
	turn.timeline.noteMessage(assistant(at, [{ type: "toolCall", id, name: "ipython", arguments: { code } }]), true);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code }, status: "queued" });
	turn.state.setStepStatus(id, "running", at);
	turn.state.setStepStatus(id, "done", at + 500);
	turn.timeline.mergeStep(
		id,
		"ipython",
		{},
		{
			details: {
				activities: [
					{
						id: `a${index}`,
						kind: "command",
						label: `echo ${index}`,
						status: "ok",
						detail: `out ${index}`,
						startedAt: at,
						endedAt: at + 400,
					},
				],
				stdout: `out ${index}\nmore ${index}`,
			},
		},
		false,
	);
}

/**
 * The turn's lines at `width` columns with every kind of click area on screen: the event line, the steps it
 * lists, and `⋯ 另外 N 步   全部 ›`; or, once that was taken, every step with the first one opened. A step
 * that arrived while the event was open joins it.
 */
function openTimeline(width: number, listAll: boolean) {
	setMotionReduced(true);
	const turn = liveTurn();
	const t0 = Date.now() - 4_000;
	for (let index = 0; index < 20; index++) addCommand(turn, index, t0 + index);
	turn.summary.render(width);
	const eventKey = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:")) ?? "";
	expect(turn.summary.activate(eventKey)).toBe(true);
	turn.summary.render(width);
	if (listAll) {
		expect(turn.summary.activate(`all:${eventKey}`)).toBe(true);
		turn.summary.render(width);
		expect(turn.summary.activate("act:s0:a0")).toBe(true);
	}
	addCommand(turn, 20, t0 + 20);
	const lines = turn.summary.render(width);
	return { lines, regions: turn.summary.getClickRegions(), order: turn.summary.getFocusOrder(), ui: turn.timeline.ui };
}

function change(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
	return {
		key: "/work/app/src/审查.ts",
		path: "src/审查.ts",
		kind: "modified",
		scope: "project",
		added: 12,
		removed: 4,
		rows: [],
		truncated: false,
		binary: false,
		firstAt: 1,
		...overrides,
	};
}

function stripFacts(): TimelineFacts {
	return {
		thinkCount: 0,
		commandCount: 0,
		readCount: 0,
		stepCount: 1,
		subagentCount: 0,
		errorCount: 0,
		projectChanges: [change(), change({ key: "/work/app/b.go", path: "b.go", added: 1, removed: 0 })],
		scratchChanges: [],
		memories: [
			{
				key: "m1",
				change: { op: "created", kind: "memory", scope: "global", title: "一条记忆", after: "x", at: 1 },
			},
		],
		trackingIncomplete: false,
	};
}

/** A finished turn's change strip with one of its lists open, rendered at `width`. */
function openStrip(list: "edits" | "memories", width: number) {
	setMotionReduced(true);
	const timeline = new TurnTimeline();
	if (list === "edits") timeline.ui.stripOpen = "edits";
	else timeline.ui.stripExpanded.add("m1");
	const strip = new TurnStripComponent({ timeline, facts: stripFacts, requestRender: vi.fn() });
	const lines = strip.render(width);
	return { lines, regions: strip.getClickRegions() };
}

const NARROW_TO_THIRTY = Array.from({ length: 30 }, (_, index) => index + 1);
/** Narrow to wide; below 5 columns the change strip's frame cannot be drawn whole, the timeline's lines can. */
const FRAME_WIDTHS = [1, 2, 3, 4, 5, 6, 30, 80, 120, 121, 122, 200];

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
});

describe("the timeline's click areas stay on the screen", () => {
	it("puts no area of an open event past the last column at 1 to 30 columns", () => {
		expect(NARROW_TO_THIRTY.length).toBeGreaterThan(0);
		for (const width of NARROW_TO_THIRTY) {
			for (const listAll of [false, true]) {
				const { lines, regions, order, ui } = openTimeline(width, listAll);
				const where = `${width} columns, ${listAll ? "every step listed" : "three steps listed"}`;
				const onLines = new Set(regions.map((region) => region.line));
				// The event line, its steps (three and `全部 ›`, or all 21) and nothing else has an area.
				expect(order.length, `targets at ${where}`).toBe(listAll ? 22 : 5);
				expect(regions.length, `areas at ${where}`).toBe(order.length);
				expect(onLines.has(0), `event area at ${where}`).toBe(true);
				expect(
					regions.filter((region) => region.line > 0 && region.line < lines.length).length,
					`step areas at ${where}`,
				).toBe(order.length - 1);
				if (!listAll) {
					expect(
						[...onLines].sort((a, b) => a - b),
						`lines with an area at ${where}`,
					).toEqual([0, 1, 2, 3, 4]);
				} else {
					// The opened step adds lines of its own (its output) that carry no area.
					expect(lines.length, `lines at ${where}`).toBeGreaterThan(order.length + 2);
				}
				for (const key of order) {
					expect(
						regions.some((region) => region.hoverKey === `${ui.id}:${key}`),
						`area of ${key} at ${where}`,
					).toBe(true);
				}
				for (const region of regions) {
					expect(region.col + region.width, `area on line ${region.line} at ${where}`).toBeLessThanOrEqual(width);
					// Every area opens or folds something; none is a passive strip the wheel passes through.
					expect(region.passive, `area on line ${region.line} at ${where}`).not.toBe(true);
				}
			}
		}
	});

	it("gives every line of the timeline the whole line's width, from 1 column up", () => {
		expect(FRAME_WIDTHS.length).toBeGreaterThan(0);
		for (const width of FRAME_WIDTHS) {
			const { regions } = openTimeline(width, false);
			expect(regions.length, `areas at ${width}`).toBeGreaterThan(0);
			for (const region of regions) {
				expect(region.col, `column of line ${region.line} at ${width}`).toBe(0);
				expect(region.width, `width of line ${region.line} at ${width}`).toBe(width);
				expect(region.height, `height of line ${region.line} at ${width}`).toBe(1);
			}
		}
	});
});

describe("the change strip's click areas stay on the screen", () => {
	it("puts no area of an open list past the last column at 1 to 30 columns", () => {
		expect(NARROW_TO_THIRTY.length).toBeGreaterThan(0);
		for (const list of ["edits", "memories"] as const) {
			for (const width of NARROW_TO_THIRTY) {
				const { lines, regions } = openStrip(list, width);
				expect(lines.length, `${list} strip lines at ${width}`).toBeGreaterThan(0);
				expect(regions.length, `${list} strip areas at ${width}`).toBeGreaterThan(0);
				for (const region of regions) {
					expect(region.col + region.width, `${list} area on line ${region.line} at ${width}`).toBeLessThanOrEqual(
						width,
					);
				}
			}
		}
	});

	it("gives every listed item the whole frame's width, and 5 columns and up stay as they were", () => {
		expect(FRAME_WIDTHS.length).toBeGreaterThan(0);
		for (const list of ["edits", "memories"] as const) {
			for (const width of FRAME_WIDTHS) {
				const { lines, regions } = openStrip(list, width);
				// The first row is the gap above the strip's rows; every row it draws below is a whole-width area.
				const items = regions.filter((region) => region.line > 0);
				expect(items.length, `${list} item areas at ${width}`).toBeGreaterThan(0);
				for (const region of items) {
					expect(region.col).toBe(0);
					expect(region.width, `${list} item width at ${width}`).toBe(width);
					expect(region.line, `${list} item line at ${width}`).toBeLessThan(lines.length);
				}
			}
		}
	});
});
