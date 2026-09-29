import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { plain, T0 } from "./ui-blocks-helpers.js";
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
 * The chat as a string of what each line is: T a `◆ prime` title, U a box's top
 * border, D its bottom border, M a handed-back message row, B a blank line, X other
 * text. A box's inside is left out.
 */
function shape(chat: LiveChat): string {
	const marks: string[] = [];
	for (const line of plain(chat.lines())) {
		if (line.trim() === "") marks.push("B");
		else if (line.includes("◆ prime")) marks.push("T");
		else if (line.includes("╭")) marks.push("U");
		else if (line.includes("╰")) marks.push("D");
		else if (line.includes("◇")) marks.push("M");
		else if (!line.includes("│")) marks.push("X");
	}
	return marks.join("");
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
		return chat;
	}

	it("leaves exactly one blank line between a box or an answer and the next group, and never two in a row", () => {
		const marks = shape(threeGroups());
		expect(marks).not.toContain("BB");
		// A group is its message rows and its box: one blank line before it, none inside it.
		expect(marks).toContain("BMUD");
		expect(marks).toContain("BMMUD");
		expect(marks).not.toContain("MB");
		expect(marks).not.toMatch(/D[UT]/);
	});

	it("draws the answer of the last box one blank line under it", () => {
		expect(shape(threeGroups())).toMatch(/UDBX$/);
	});

	it("draws no title inside the woken groups but the first turn's", () => {
		const marks = shape(threeGroups());
		expect(marks.match(/T/g)).toHaveLength(1);
	});

	it("keeps a title in a woken group on another model, straight under its message row", () => {
		const chat = new LiveChat();
		chat.prompt("多个 glm 对最近的提交做代码审查");
		chat.wake("m1", { model: "gpt-5.5" });
		vi.advanceTimersByTime(1_000);
		const marks = shape(chat);
		expect(marks).toContain("BMTUD");
		expect(marks).not.toContain("BB");
	});

	it("puts a blank line between two boxes when the message that woke the second one is not shown", () => {
		const chat = new LiveChat();
		chat.prompt("跑一下后台任务");
		chat.wakeUnseen("m1");
		vi.advanceTimersByTime(1_000);
		const marks = shape(chat);
		expect(marks).toContain("DBUD");
		expect(marks).not.toMatch(/DU/);
		expect(marks).not.toContain("BB");
	});

	it("leaves no blank line above the first turn's box, which the user message already separates", () => {
		const chat = new LiveChat();
		chat.prompt("你好");
		vi.advanceTimersByTime(1_000);
		expect(shape(chat)).toMatch(/^X+BTUD$/);
	});
});
