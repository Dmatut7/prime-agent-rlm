import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import {
	addCommand,
	addSay,
	host,
	plain,
	type QuietTurn,
	quietTurn,
	T0,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

beforeEach(() => {
	// Each step's message is keyed by its time: give every one its own millisecond.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

/** The clock moves on, so the next message is a new one. */
function later(): void {
	vi.setSystemTime(Date.now() + 10);
}

/** The first line of the turn that carries the event's words (an event line starts with its time and `◆`). */
function eventLine(turn: QuietTurn, width: number, needle: string): string {
	const line = plain(turn.summary.render(width)).find(
		(entry) => /^ \d\d:\d\d {3}◆/.test(entry) && entry.includes(needle),
	);
	expect(line, `event line with ${needle}`).toBeDefined();
	return line ?? "";
}

/** Milliseconds one frame takes, as the best of a few runs (a noisy machine only ever adds time). */
function frameMs(turn: QuietTurn, width: number): number {
	const frames = 8;
	let best = Number.POSITIVE_INFINITY;
	for (let run = 0; run < 5; run++) {
		const started = performance.now();
		for (let frame = 0; frame < frames; frame++) {
			turn.timeline.ui.bump();
			turn.summary.render(width);
		}
		best = Math.min(best, (performance.now() - started) / frames);
	}
	return best;
}

describe("notes cost a frame nearly nothing", () => {
	function withNotes(notes: number, chars: number): QuietTurn {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 60 }) });
		const words = "这里是 AI 在两个步骤之间说的一大段话，包含很多细节 and English words mixed in. ";
		for (let index = 0; index < notes; index++) {
			addSay(
				turn,
				`第 ${index} 段说明。${words.repeat(Math.ceil(chars / words.length))}`,
				`s${index}`,
				Date.now() - 30_000 + index * 10,
			);
			later();
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
			later();
		}
		turn.summary.render(120);
		return turn;
	}

	it("draws a turn of many long notes about as fast as one of as many short notes", () => {
		const base = frameMs(withNotes(100, 30), 120);
		const notes = frameMs(withNotes(100, 3_000), 120);
		// A note's length must not tax a frame: it is one line, cut to the width, however long it is.
		expect(notes / base).toBeLessThan(5);
	});

	it("shows a long note cut to one line and a short one whole, and opens a note of several paragraphs to its text", () => {
		const turn = withNotes(1, 3_000);
		addSay(turn, "趁等待，查一个风险点。", "short", Date.now());
		later();
		addSay(turn, "先看整体。\n\n第二段：这里才是细节。", "multi", Date.now());
		const shown = plain(turn.summary.render(120));
		const long = eventLine(turn, 120, "第 0 段说明");
		expect(long).toMatch(/^ \d\d:\d\d {3}◆ {6}第 0 段说明。这里是 AI 在两个步骤之间说的一大段话.*…/);
		expect(long).toMatch(/2 步 ▸ {2}$/);
		const short = eventLine(turn, 120, "趁等待，查一个风险点。");
		expect(short).toMatch(/^ \d\d:\d\d {3}◆ {6}趁等待，查一个风险点。 +1 步 ▸ {2}$/);
		expect(short).not.toContain("…");
		// A note of several paragraphs draws its first paragraph and keeps the rest behind the event.
		const multi = eventLine(turn, 120, "先看整体。");
		expect(multi).toMatch(/^ \d\d:\d\d {3}◆ {6}先看整体。 +1 步 ▸ {2}$/);
		expect(shown.join("\n")).not.toContain("第二段");
		const key = turn.summary.getFocusOrder().at(-1) ?? "";
		expect(key.startsWith("ev:")).toBe(true);
		turn.summary.activate(key);
		const opened = plain(turn.summary.render(120));
		const at = opened.findIndex((line) => line.includes("先看整体。"));
		expect(opened[at]?.trimEnd().endsWith("1 步 ▴")).toBe(true);
		expect(opened[at + 1]).toMatch(/^ {9}│ {6}先看整体。/);
		expect(opened[at + 2]).toMatch(/^ {9}│ +$/);
		expect(opened[at + 3]).toMatch(/^ {9}│ {6}第二段：这里才是细节。/);
	});

	it("draws a note that grew longer as its new words once they change", () => {
		for (const ended of [false, true]) {
			setMotionReduced(true);
			const turn = quietTurn();
			addSay(turn, "先说一句。", "s1", Date.now() - 2_000);
			if (ended) turn.state.markTurnEnded(Date.now());
			expect(eventLine(turn, 80, "先说一句。"), `short note, ended ${ended}`).toMatch(
				/^ \d\d:\d\d {3}◆ {6}先说一句。 +1 步 ▸ {2}$/,
			);
			expect(turn.state.boxView().events.map((event) => event.text)).toEqual(["先说一句。"]);
			turn.timeline.dropEntry(turn.timeline.entries.find((entry) => entry.kind === "message")?.key ?? "");
			addSay(turn, `先说一句。${"后面还有很多很多话，".repeat(20)}`, "s1", Date.now() - 2_000);
			const grown = eventLine(turn, 80, "先说一句");
			expect(grown, `grown note, ended ${ended}`).toMatch(
				/^ \d\d:\d\d {3}◆ {6}先说一句。后面还有很多很多话，后面还有.*…/,
			);
			expect(grown.trimEnd().endsWith("步 ▸")).toBe(true);
			expect(turn.state.boxView().events.map((event) => event.text)).toEqual([
				`先说一句。${"后面还有很多很多话，".repeat(20)}`,
			]);
		}
	});
});
