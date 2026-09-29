import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import type { TimelineEvent } from "../src/modes/interactive/components/timeline-rows.js";
import { foldedEventRuns } from "../src/modes/interactive/components/turn-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { at } from "./tl-fc-host.js";
import { plain } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/** What the box folds: a stretch of events between boundaries, where news and the user's own picks stay. */

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(at(18, 47));
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

function say(index: number, text: string): TimelineEvent {
	return { key: `e${index}`, kind: "say", at: at(18, 47) + index * 1_000, text, steps: [], spawned: [] };
}

function events(texts: readonly string[]): TimelineEvent[] {
	return texts.map((text, index) => say(index, text));
}

const PLAIN = "跑了一批检查";

describe("which events count as news to a fold", () => {
	it("does not take `没问题` for a problem: a stretch of all-clear lines folds whole", () => {
		const texts = [
			PLAIN,
			...Array.from({ length: 5 }, (_, index) => `第 ${index} 批：没问题（3 条小建议）`),
			PLAIN,
			PLAIN,
		];
		expect(foldedEventRuns(events(texts), [])).toEqual([[1, 2, 3, 4, 5]]);
	});

	it("does not take other negations for news either: nothing found, nothing failed", () => {
		const texts = [PLAIN, "没有发现问题", "未发现异常", "没出错", "无失败项", "不存在问题", PLAIN, PLAIN];
		expect(foldedEventRuns(events(texts), [])).toEqual([[1, 2, 3, 4, 5]]);
	});

	it("still keeps a line that reports a problem, a finding or a failure", () => {
		const texts = [PLAIN, "发现一个问题：路径写死了", "没问题", "测试失败了 2 个", "没问题", "没问题", PLAIN, PLAIN];
		expect(foldedEventRuns(events(texts), [])).toEqual([[4, 5]]);
	});

	it("keeps a bold line and a conclusion", () => {
		const texts = [PLAIN, "**范围定了**", "没问题", "没问题", "结论：能发", "没问题", PLAIN, PLAIN];
		const runs = foldedEventRuns(events(texts), []);
		expect(runs).toEqual([[2, 3]]);
	});
});

describe("the fold's threshold", () => {
	it("folds nothing under five events, and from five on hides the middle ones", () => {
		for (const count of [2, 3, 4]) {
			expect(foldedEventRuns(events(Array.from({ length: count }, () => PLAIN)), []), `${count}`).toEqual([]);
		}
		expect(foldedEventRuns(events(Array.from({ length: 5 }, () => PLAIN)), [])).toEqual([[1, 2]]);
	});

	it("an event the user opened splits the stretch around it, and a piece of one folds nothing", () => {
		const list = events(Array.from({ length: 8 }, () => PLAIN));
		expect(foldedEventRuns(list, [], new Set(["e3"]))).toEqual([
			[1, 2],
			[4, 5],
		]);
		expect(foldedEventRuns(list, [], new Set(["e2"]))).toEqual([[3, 4, 5]]);
		const short = events(Array.from({ length: 5 }, () => PLAIN));
		expect(foldedEventRuns(short, [], new Set(["e2"]))).toEqual([]);
	});
});

describe("the closing row's `完整过程`", () => {
	function longTurn(count: number): LiveChat {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		for (let index = 0; index < count; index++) {
			const time = at(18, 47) + index * 20_000;
			vi.setSystemTime(time);
			chat.say(time, {
				words: `第 ${index + 1} 件：跑了一批检查`,
				calls: [{ id: `k${index}`, code: "print(1)", details: {}, endsAt: time + 2_000 }],
			});
		}
		chat.say(at(19, 30), { words: "审查完成。" });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	const rows = (chat: LiveChat) => plain(chat.lines(160)).map((row) => row.trimEnd());
	const eventRows = (chat: LiveChat) =>
		rows(chat).filter((row) => /^ \d\d:\d\d {3}◆ {2}[ ┆]/.test(row) && !row.endsWith("总结"));

	it("shows every event, not the folded stretch, and folds again when it is turned off", () => {
		const chat = longTurn(20);
		const folded = eventRows(chat).length;
		expect(rows(chat).some((row) => row.includes("⋯  中间还有"))).toBe(true);
		timelineShowAll.set(true);
		expect(rows(chat).some((row) => row.includes("⋯  中间还有"))).toBe(false);
		expect(eventRows(chat).length).toBeGreaterThan(folded);
		expect(eventRows(chat)).toHaveLength(20);
		timelineShowAll.set(false);
		expect(rows(chat).some((row) => row.includes("⋯  中间还有"))).toBe(true);
		chat.flow.dispose();
	});
});
