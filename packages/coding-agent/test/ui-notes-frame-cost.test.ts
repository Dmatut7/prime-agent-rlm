import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import {
	addCommand,
	addSay,
	host,
	lineIndexWith,
	plain,
	type QuietTurn,
	quietTurn,
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

afterEach(() => {
	setMotionReduced(false);
});

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
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
		}
		turn.summary.render(120);
		return turn;
	}

	function withoutNotes(notes: number): QuietTurn {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 60 }) });
		for (let index = 0; index < notes; index++) {
			addCommand(turn, `n${index}`, `echo note ${index}`, { output: "x" });
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
		}
		turn.summary.render(120);
		return turn;
	}

	it("draws a turn of many long notes about as fast as one of as many commands", () => {
		const base = frameMs(withoutNotes(100), 120);
		const notes = frameMs(withNotes(100, 3_000), 120);
		// Wrapping every note whole on every frame took 15 to 17 times as long.
		expect(notes / base).toBeLessThan(5);
	});

	it("still shows a long note as a block and a short one as plain text", () => {
		const turn = withNotes(1, 3_000);
		addSay(turn, "趁等待，查一个风险点。", "short", Date.now());
		const lines = turn.summary.render(120);
		const shown = plain(lines);
		const longAt = lineIndexWith(lines, "第 0 段说明");
		expect(longAt).toBeGreaterThan(0);
		expect(shown[longAt]).toContain("▸");
		const shortAt = lineIndexWith(lines, "趁等待，查一个风险点。");
		expect(shortAt).toBeGreaterThan(0);
		expect(shown[shortAt]).not.toContain("▸");
	});

	it("draws a note that grew past three lines as a block once its words change", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "先说一句。", "s1", Date.now() - 2_000);
		let lines = turn.summary.render(80);
		expect(plain(lines)[lineIndexWith(lines, "先说一句。")]).not.toContain("▸");
		const key = turn.state.boxView().rows.find((row) => row.kind === "say")?.key ?? "";
		expect(key).not.toBe("");
		turn.timeline.dropEntry(turn.timeline.entries.find((entry) => entry.kind === "message")?.key ?? "");
		addSay(turn, `先说一句。${"后面还有很多很多话，".repeat(20)}`, "s1", Date.now() - 2_000);
		lines = turn.summary.render(80);
		expect(plain(lines)[lineIndexWith(lines, "先说一句")]).toContain("▸");
	});
});
