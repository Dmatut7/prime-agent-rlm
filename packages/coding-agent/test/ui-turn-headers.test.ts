import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { QuietCompactionNoticeComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import {
	buildConversationComponents,
	resolveTurnHeaders,
} from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, assistant, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

const HEADER = "◆ prime";
/** An event line: time, the AI's diamond, then its words at column 16. */
const EVENT_LINE = /^ \d\d:\d\d {3}◆ {6}\S/;
/** A blank row on the rail: what a woken turn puts above its first event. */
const RAIL_ROW = "         │      ";

function shows(summary: TurnSummaryComponent): boolean {
	return plain(summary.render(100)).some((line) => line.includes(HEADER));
}

/** The lines of the turn that are events. */
function eventLines(summary: TurnSummaryComponent): string[] {
	return plain(summary.render(100)).filter((line) => EVENT_LINE.test(line));
}

/** A finished turn with one command, so it draws its event line (a turn with nothing to list draws nothing). */
function turn(model: string, startedByUser: boolean): TurnSummaryComponent {
	const made = quietTurn({ live: false });
	made.state.modelId = model;
	made.state.startedByUser = startedByUser;
	addCommand(made, "c1", "echo one");
	made.state.markTurnEnded(Date.now());
	return made.summary;
}

/** Every turn of a live chat gets one finished command, so it draws its event line. */
function withEvents(screen: LiveChat): LiveChat {
	screen.summaries().forEach((summary, index) => {
		addCommand({ state: summary.state, summary, timeline: summary.state.timeline }, `c${index}`, `echo ${index}`);
	});
	return screen;
}

const compactionNotice = () =>
	new QuietCompactionNoticeComponent({
		role: "compactionSummary",
		summary: "总结",
		tokensBefore: 120_000,
		timestamp: T0,
	});

describe("a woken turn draws no title, whichever title is above it", () => {
	it("starts a turn that no user message opened on its event line, however many turns follow each other", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		const later = turn("glm-5.3-prime", false);
		resolveTurnHeaders([
			new UserMessageComponent("审查提交"),
			first,
			new AgentMessageComponent(handedBack("m1")),
			woken,
			new AgentMessageComponent(handedBack("m2")),
			later,
		]);
		expect([first, woken, later].map(shows)).toEqual([false, false, false]);
		for (const summary of [first, woken, later]) {
			expect(plain(summary.render(100))[0]).toMatch(EVENT_LINE);
			expect(eventLines(summary)).toHaveLength(1);
		}
	});

	it("draws no title for the first turn, for a turn after a user message or for a turn on another model", () => {
		const alone = turn("glm-5.3-prime", false);
		resolveTurnHeaders([alone]);
		expect(shows(alone)).toBe(false);
		expect(plain(alone.render(100))[0]).toMatch(EVENT_LINE);

		const before = turn("glm-5.3-prime", true);
		const prompted = turn("glm-5.3-prime", true);
		resolveTurnHeaders([before, new UserMessageComponent("再来一次"), prompted]);
		expect(shows(prompted)).toBe(false);
		expect(plain(prompted.render(100))[0]).toMatch(EVENT_LINE);

		const other = turn("glm-5.3-prime", true);
		const switched = turn("gpt-5.5", false);
		const back = turn("glm-5.3-prime", false);
		resolveTurnHeaders([other, new AgentMessageComponent(handedBack("m3")), switched, back]);
		// A model change starts no title over; a turn straight under another turn gets a blank rail row instead.
		expect([shows(other), shows(switched), shows(back)]).toEqual([false, false, false]);
		expect(plain(other.render(100))[0]).toMatch(EVENT_LINE);
		expect(plain(switched.render(100))[0]).toMatch(EVENT_LINE);
		const backLines = plain(back.render(100));
		expect(backLines).toHaveLength(2);
		expect(backLines[0]).toBe(RAIL_ROW);
		expect(backLines[1]).toMatch(EVENT_LINE);
	});

	it("draws no title for the first turn after a compaction", () => {
		const before = turn("glm-5.3-prime", true);
		const after = turn("glm-5.3-prime", false);
		resolveTurnHeaders([before, compactionNotice(), new AgentMessageComponent(handedBack("m4")), after]);
		expect([shows(before), shows(after)]).toEqual([false, false]);
		expect(plain(before.render(100))[0]).toMatch(EVENT_LINE);
		expect(plain(after.render(100))[0]).toMatch(EVENT_LINE);
	});

	it("leaves the woken turn a working event line and click area when no title is drawn", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		resolveTurnHeaders([first, new AgentMessageComponent(handedBack("m5")), woken]);
		const lines = plain(woken.render(100));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +1 步 ▸ {2}$/);
		const regions = woken.getClickRegions();
		const eventRow = regions.find((region) => region.line === 0 && !region.passive);
		expect(eventRow).toBeDefined();
		expect(eventRow).toMatchObject({ col: 0, width: 100 });
		expect(regions.some((region) => region.line !== 0)).toBe(false);
		const before = woken.state.boxOpen;
		eventRow?.onClick({ row: 0, col: 0 });
		expect(woken.state.boxOpen).toBe(!before);
	});

	it("moves the event's click area down with the blank rail row a woken turn gets when no message row is above it", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		resolveTurnHeaders([first, woken]);
		const lines = plain(woken.render(100));
		expect(lines[0]).toBe(RAIL_ROW);
		expect(lines[1]).toMatch(EVENT_LINE);
		const regions = woken.getClickRegions();
		const eventRow = regions.find((region) => region.line === 1 && !region.passive);
		expect(eventRow).toBeDefined();
		expect(regions.some((region) => region.line < 1)).toBe(false);
	});
});

describe("the live view draws no title, whichever question a turn belongs to", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	it("draws no title for the turns a handed-back message wakes on the same model", () => {
		const screen = new LiveChat();
		screen.prompt("审查最近的提交");
		screen.wake("m1");
		screen.wake("m2");
		withEvents(screen);
		expect(screen.summaries()).toHaveLength(3);
		expect(screen.summaries().map(shows)).toEqual([false, false, false]);
		// The flow still knows which turns a message woke; only the first one a prompt opened.
		expect(screen.summaries().map((summary) => summary.state.startedByUser)).toEqual([true, false, false]);
		for (const summary of screen.summaries()) expect(eventLines(summary)).toHaveLength(1);
		screen.flow.dispose();
	});

	it("draws no title after a new prompt or when the model changes, and keeps track of which turns a prompt opened", () => {
		const screen = new LiveChat();
		screen.prompt("第一个问题");
		screen.wake("m1");
		screen.prompt("第二个问题");
		screen.wake("m2");
		screen.wake("m3", { model: "gpt-5.5" });
		screen.wake("m4", { model: "gpt-5.5" });
		withEvents(screen);
		const summaries = screen.summaries();
		expect(summaries).toHaveLength(6);
		expect(summaries.map(shows)).toEqual([false, false, false, false, false, false]);
		expect(summaries.map((summary) => summary.state.startedByUser)).toEqual([true, false, true, false, false, false]);
		expect(summaries.map((summary) => summary.state.modelId)).toEqual([
			"glm-5.3-prime",
			"glm-5.3-prime",
			"glm-5.3-prime",
			"glm-5.3-prime",
			"gpt-5.5",
			"gpt-5.5",
		]);
		for (const summary of summaries) expect(eventLines(summary)).toHaveLength(1);
		screen.flow.dispose();
	});

	it("keeps a run no message started in the box it continues, with no title", () => {
		const screen = new LiveChat();
		screen.prompt("第一个问题");
		screen.continueOnItsOwn();
		withEvents(screen);
		expect(screen.summaries()).toHaveLength(1);
		expect(screen.summaries().map(shows)).toEqual([false]);
		expect(eventLines(screen.summaries()[0] as TurnSummaryComponent)).toHaveLength(1);
		screen.flow.dispose();
	});
});

function toolResult(id: string, at: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: at,
	};
}

describe("a replayed conversation draws no title, one box per question", () => {
	it("keeps the runs a handed-back message woke in the question's own box, with no title", () => {
		const call = (id: string, at: number) =>
			assistant(at, [{ type: "toolCall", id, name: "ipython", arguments: { code: "await bash('ls')" } }]);
		const messages: AgentMessage[] = [
			{ role: "user", content: "审查最近的提交", timestamp: T0 },
			call("t1", T0 + 1_000),
			toolResult("t1", T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "派出去了。" }], "stop"),
			handedBack("m1", T0 + 4_000),
			call("t2", T0 + 5_000),
			toolResult("t2", T0 + 6_000),
			assistant(T0 + 7_000, [{ type: "text", text: "审查完成。" }], "stop"),
			{ role: "user", content: "再看一下测试", timestamp: T0 + 8_000 },
			assistant(T0 + 9_000, [{ type: "text", text: "测试都过了。" }], "stop"),
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
		expect(summaries).toHaveLength(2);
		expect(summaries.map(shows)).toEqual([false, false]);
		const titles = components
			.flatMap((component) => plain(component.render(100)))
			.filter((line) => line.includes(HEADER));
		expect(titles).toHaveLength(0);
		// The run the handed-back message woke is the question's own box: both runs' steps are in the first box.
		const [question, followUp] = summaries;
		const events = plain(question?.render(100) ?? []);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatch(new RegExp(`^ ${formatTimelineTime(T0 + 1_000)} {3}◆ {6}\\S.* +1 步 ▸ {2}$`));
		expect(events[1]).toMatch(new RegExp(`^ ${formatTimelineTime(T0 + 3_000)} {3}◆ {6}派出去了。 +1 步 ▸ {2}$`));
		// A turn that only answered has nothing to list: its answer is drawn by the reply itself.
		expect(plain(followUp?.render(100) ?? [])).toEqual([]);
	});
});
