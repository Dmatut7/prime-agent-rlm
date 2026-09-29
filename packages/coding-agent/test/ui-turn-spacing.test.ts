import { Container, Spacer, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { resolveTurnHeaders } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, assistant, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

/**
 * The chat as a string of what each line is: T a `◆ prime` title (there is none any
 * more), E an event line, S a running turn's spinner line, M a handed-back message
 * row, R a blank row on the rail (what a woken turn puts above its first event), B a
 * blank line, X other text (a user bubble, an answer).
 */
function shape(chat: LiveChat): string {
	const marks: string[] = [];
	for (const line of plain(chat.lines())) {
		if (line.trim() === "") marks.push("B");
		else if (/^ {9}│ *$/.test(line)) marks.push("R");
		else if (line.includes("◆ prime")) marks.push("T");
		else if (/^ \d\d:\d\d {3}◆/.test(line)) marks.push("E");
		else if (/^ \d\d:\d\d {3}[⠀-⣿]/.test(line)) marks.push("S");
		else if (/^ {3}◇ /.test(line)) marks.push("M");
		else marks.push("X");
	}
	return marks.join("");
}

/** Every turn of the chat gets one finished command, so it draws an event line (a turn with nothing to list draws nothing). */
function withEvents(chat: LiveChat): LiveChat {
	chat.summaries().forEach((summary, index) => {
		addCommand({ state: summary.state, summary, timeline: summary.state.timeline }, `c${index}`, `echo ${index}`);
	});
	return chat;
}

describe("the groups of consecutive turns are one blank line apart", () => {
	function threeGroups(): LiveChat {
		const chat = new LiveChat();
		chat.prompt("多个 glm 对最近的提交做代码审查", { answer: "派出去了，等它们交回。" });
		chat.wake("m1", { name: "ff-review-c-screen" });
		chat.wake("m2", {
			name: "ff-review-d-keys",
			also: [{ id: "m3", name: "ff-review-b-tracking" }],
			answer: "审查完成。汇总如下。",
		});
		vi.advanceTimersByTime(1_000);
		return withEvents(chat);
	}

	it("leaves exactly one blank line between an event or an answer and the next group, and never two in a row", () => {
		const marks = shape(threeGroups());
		expect(marks).not.toContain("BB");
		// A group is its message rows and its event line: one blank line before it, none inside it.
		expect(marks).toContain("BME");
		expect(marks).toContain("BMME");
		expect(marks).not.toContain("MB");
		expect(marks).not.toContain("EE");
	});

	it("draws the answer of the last turn one blank line under its event", () => {
		expect(shape(threeGroups())).toMatch(/EBX$/);
	});

	it("draws no title in any group, the first turn's included", () => {
		const marks = shape(threeGroups());
		expect(marks).not.toContain("T");
		expect(marks.match(/E/g)).toHaveLength(3);
	});

	it("keeps a woken group on another model straight under its message row, with no title", () => {
		const chat = new LiveChat();
		chat.prompt("多个 glm 对最近的提交做代码审查");
		chat.wake("m1", { model: "gpt-5.5" });
		vi.advanceTimersByTime(1_000);
		const marks = shape(withEvents(chat));
		expect(marks).toContain("BME");
		expect(marks).not.toContain("T");
		expect(marks).not.toContain("BB");
	});

	it("puts a blank rail row between two events when the message that woke the second one is not shown", () => {
		const chat = new LiveChat();
		chat.prompt("跑一下后台任务");
		chat.wakeUnseen("m1");
		vi.advanceTimersByTime(1_000);
		const marks = shape(withEvents(chat));
		expect(marks).toContain("ERE");
		expect(marks).not.toMatch(/EE/);
		expect(marks).not.toContain("BB");
		expect(plain(chat.lines()).filter((line) => /^ {9}│ *$/.test(line))).toEqual(["         │      "]);
	});

	it("leaves no blank line above the first turn's event, which the user message already separates", () => {
		const chat = new LiveChat();
		chat.prompt("你好");
		vi.advanceTimersByTime(1_000);
		expect(shape(withEvents(chat))).toMatch(/^X+BE$/);
	});

	it("draws nothing for a turn with nothing to list", () => {
		const chat = new LiveChat();
		chat.prompt("你好", { answer: "在的。" });
		chat.wake("m1");
		vi.advanceTimersByTime(1_000);
		expect(chat.summaries()).toHaveLength(2);
		for (const summary of chat.summaries()) expect(summary.render(100)).toEqual([]);
		expect(shape(chat)).not.toMatch(/[ESR]/);
	});
});

describe("a woken turn does not add a blank line to one that is already there", () => {
	it("leaves a single blank line between a stopped reply and the event of a wake-up that shows no message", () => {
		const chat = new LiveChat();
		chat.prompt("跑一个很久的命令", { cutMidStep: true });
		chat.wakeUnseen("m1");
		vi.advanceTimersByTime(1_000);
		const marks = shape(withEvents(chat));
		// The stopped reply's step is the first event; its `已中断` reply ends in its own blank line.
		expect(marks).toContain("EBXBE");
		expect(marks).not.toContain("BB");
	});

	it("still adds the blank rail row under an answer that ends in text", () => {
		const chat = new LiveChat();
		chat.prompt("你好", { answer: "在的。" });
		chat.wakeUnseen("m1");
		vi.advanceTimersByTime(1_000);
		expect(shape(withEvents(chat))).toContain("XRE");
	});

	function wokenSummary() {
		const woken = quietTurn({ live: false });
		woken.state.startedByUser = false;
		addCommand(woken, "c1", "echo woken");
		woken.state.markTurnEnded(Date.now());
		return woken.summary;
	}

	function firstBox() {
		const first = quietTurn({ live: false });
		addCommand(first, "c0", "echo first");
		first.state.markTurnEnded(Date.now());
		return first.summary;
	}

	it("counts an empty component between as nothing when it looks for what is above", () => {
		const stopped = new AssistantMessageComponent(
			assistant(
				T0,
				[{ type: "toolCall", id: "t1", name: "ipython", arguments: { code: "await bash('sleep 60')" } }],
				"aborted",
			),
			false,
			undefined,
			"Thinking",
			{ quiet: true },
		);
		const woken = wokenSummary();
		resolveTurnHeaders([firstBox(), stopped, new Container(), woken]);
		expect(plain(woken.render(100))[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令/);
	});

	it("adds the blank rail row when what is above ends in text, a spacer excepted", () => {
		const answer = new AssistantMessageComponent(
			assistant(T0, [{ type: "text", text: "在的。" }], "stop"),
			false,
			undefined,
			"Thinking",
			{
				quiet: true,
			},
		);
		const woken = wokenSummary();
		resolveTurnHeaders([firstBox(), answer, new Container(), woken]);
		const lines = plain(woken.render(100));
		expect(lines[0]).toBe("         │      ");
		expect(lines[1]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令/);

		const spaced = wokenSummary();
		resolveTurnHeaders([firstBox(), answer, new Spacer(1), spaced]);
		expect(plain(spaced.render(100))[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令/);
	});
});
