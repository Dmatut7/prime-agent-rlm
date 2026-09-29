import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineRow } from "../src/modes/interactive/components/timeline-gutter.js";
import { TimelineLaneTracker, timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { STRIP_ALL } from "../src/modes/interactive/components/turn-strip.js";
import { thoughtSentence } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

function command(id: string, label: string, start: number) {
	return {
		id,
		code: `r = await bash(${JSON.stringify(label)})`,
		endsAt: start + 1000,
		details: {
			activities: [
				{
					id: `${id}-a`,
					kind: "command",
					label,
					status: "ok",
					detail: "",
					startedAt: start,
					endedAt: start + 1000,
				},
			],
		},
	};
}

describe("an event's words are cut by display width", () => {
	it("keeps a line of wide emoji whole and gives it no open arrow when it fits", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		const family = "👨‍👩‍👧";
		expect(visibleWidth(family.repeat(30))).toBeLessThan(84);
		expect(family.repeat(30).length).toBeGreaterThan(100);
		chat.setClock(at(18, 47));
		chat.user("看一下");
		chat.say(at(18, 48), { words: family.repeat(30) });
		chat.say(at(18, 49), { words: "再看一眼。", calls: [command("k1", "ls", at(18, 49))] });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		const row = plain(chat.lines(100)).find((line) => line.includes(family)) ?? "";
		expect(row.startsWith(" 18:48   ◆      ")).toBe(true);
		expect(row).toContain(family.repeat(30));
		expect(row.trimEnd().endsWith("▸")).toBe(false);
	});
});

describe("a narrow row keeps its open hint", () => {
	const gutter = { main: "ai", time: "18:50" } as const;

	it("gives the content way first, then drops `N 步`, and keeps the arrow", () => {
		const wide = stripAnsi(timelineRow(gutter, "趁它们干活，我自己跑检查", "24 步 ▸", 60));
		expect(wide.trimEnd().endsWith("24 步 ▸")).toBe(true);
		// 16 columns of gutter leave 8: `24 步 ▸` and its two spaces do not fit beside any content.
		const narrow = stripAnsi(timelineRow(gutter, "趁它们干活，我自己跑检查", "24 步 ▸", 24));
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(24);
		expect(narrow.endsWith("▸  ")).toBe(true);
		expect(narrow).not.toContain("24 步");
		expect(narrow).toContain("…");
	});

	it("still drops the right side when not even the arrow fits", () => {
		const tiny = stripAnsi(timelineRow(gutter, "趁它们干活", "24 步 ▸", 18));
		expect(visibleWidth(tiny)).toBeLessThanOrEqual(18);
		expect(tiny).not.toContain("▸");
	});

	it("shows the arrow of every event line of a narrow chat", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		chat.say(at(18, 48), { words: "先看最近的提交，定下审查范围。", calls: [command("k1", "git log", at(18, 48))] });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		const events = plain(chat.lines(24)).filter((line) => /^ \d\d:\d\d {3}◆/.test(line));
		expect(events).toHaveLength(1);
		expect(events[0]?.endsWith("▸  ")).toBe(true);
	});
});

describe("the lane closes only for a subagent that was out", () => {
	it("joins when the last one out reports, and not for a name never spawned or a late second report", () => {
		const tracker = new TimelineLaneTracker();
		expect(tracker.reported("ghost")).toBe("off");
		tracker.spawned(["A", "B"]);
		expect(tracker.reported("ghost")).toBe("sub");
		expect(tracker.pending).toEqual(["A", "B"]);
		expect(tracker.reported("A")).toBe("sub");
		expect(tracker.reported("B")).toBe("join");
		expect(tracker.reported("B")).toBe("off");
		expect(tracker.reported("ghost")).toBe("off");
		expect(tracker.active).toBe(false);
	});

	it("draws no `├──╯` for a report from a subagent the turn never dispatched", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		chat.say(at(18, 48), { words: "派一个。", calls: [{ id: "s", code: "await rlm.spawn(...)", details: {} }] });
		chat.report(handedBack("x1", at(18, 50), "stranger"));
		expect(plain(chat.lines(120)).some((line) => line.includes("├──╯"))).toBe(false);
	});
});

describe("the live tail's sentence is prose", () => {
	it("skips a table, a code fence and its code, a rule, and strips a heading, quote and list marker", () => {
		expect(thoughtSentence("| 文件 | 状态 |\n| --- | --- |\n| a.ts | 红 |\n先看颜色是不是撞了。之后再说。")).toBe(
			"先看颜色是不是撞了",
		);
		expect(thoughtSentence("```ts\nconst x = 1;\n```\n再跑一遍测试。")).toBe("再跑一遍测试");
		expect(thoughtSentence("---\n## 下一步\n看发版。")).toBe("下一步");
		expect(thoughtSentence("> 引用一句。")).toBe("引用一句");
		expect(thoughtSentence("- 先查 grow_fix_copy 这个文件。")).toBe("先查 grow_fix_copy 这个文件");
		expect(thoughtSentence("1. **先**跑 `npm test`。")).toBe("先跑 npm test");
		expect(thoughtSentence("```\nonly code\n```\n| a | b |")).toBe("");
	});

	it("never puts raw markdown on the spinner line", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		vi.setSystemTime(at(18, 57));
		chat.say(
			at(18, 57),
			{
				thought:
					"| 文件 | 状态 |\n| --- | --- |\n| a.ts | 红 |\n\n```ts\nconst x = 1;\n```\n正在查：颜色是不是撞了。",
				calls: [
					{
						id: "r1",
						code: 'r = await bash("npm test")',
						details: {
							activities: [
								{
									id: "r1-a",
									kind: "command",
									label: "npm test",
									status: "running",
									detail: "",
									startedAt: at(18, 57),
								},
							],
						},
					},
				],
			},
			{ open: true },
		);
		const rows = plain(chat.lines(120));
		const spinner = rows.find((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line)) ?? "";
		expect(spinner).toContain("正在查：颜色是不是撞了");
		for (const raw of ["|", "---", "```", "const x"]) expect(spinner).not.toContain(raw);
	});

	it("says what it is doing when the thought is nothing but markup", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		vi.setSystemTime(at(18, 57));
		chat.say(
			at(18, 57),
			{
				thought: "| 文件 | 状态 |\n| --- | --- |",
				calls: [
					{
						id: "r1",
						code: 'r = await bash("npm test")',
						details: {
							activities: [
								{
									id: "r1-a",
									kind: "command",
									label: "npm test",
									status: "running",
									detail: "",
									startedAt: at(18, 57),
								},
							],
						},
					},
				],
			},
			{ open: true },
		);
		const spinner = plain(chat.lines(120)).find((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line)) ?? "";
		expect(spinner).toContain("正在运行命令");
		expect(spinner).not.toContain("|");
	});
});

describe("完整过程 ▸ brings the hidden rows at once", () => {
	const ACK = "查过了，这条通知不用处理。";

	function ackChat(): LiveChat {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.report(handedBack("m0", at(18, 47) + 500, "B"));
		chat.say(at(18, 47) + 1_000, {
			words: "审查完成：都没问题，四个车道都收口了，这批代码本身没问题，远程检查现在是绿的。",
		});
		chat.endRun();
		vi.advanceTimersByTime(1000);
		chat.wakeByNotice("B", { answer: ACK });
		vi.advanceTimersByTime(1000);
		return chat;
	}

	function clickAll(chat: LiveChat): void {
		const strip = chat.flow.stripFor(chat.summaries().at(-1)!);
		expect(strip).toBeDefined();
		strip?.render(120);
		expect(strip?.getFocusOrder()).toContain(STRIP_ALL);
		strip?.activate(STRIP_ALL);
	}

	it("shows the acknowledgement round and the silent-finish notice on the next frame, and hides them again", () => {
		const chat = ackChat();
		const hidden = plain(chat.lines(200)).join("\n");
		expect(hidden).not.toContain(ACK);
		expect(hidden).not.toContain("做完了，没发回消息");
		clickAll(chat);
		expect(timelineShowAll.value).toBe(true);
		const shown = plain(chat.lines(200)).join("\n");
		expect(shown).toContain(ACK);
		expect(shown).toContain("子代理 B 做完了，没发回消息");
		clickAll(chat);
		expect(timelineShowAll.value).toBe(false);
		const again = plain(chat.lines(200)).join("\n");
		expect(again).not.toContain(ACK);
		expect(again).not.toContain("做完了，没发回消息");
		chat.flow.dispose();
	});

	it("calls its listeners when it flips, so a host can repaint", () => {
		const seen: boolean[] = [];
		const listener = () => seen.push(timelineShowAll.value);
		timelineShowAll.listeners.add(listener);
		try {
			timelineShowAll.set(true);
			timelineShowAll.set(true);
			timelineShowAll.set(false);
		} finally {
			timelineShowAll.listeners.delete(listener);
		}
		expect(seen).toEqual([true, false]);
	});
});
