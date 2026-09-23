import { KeybindingsManager as PiKeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager as AppKeybindingsManager } from "../src/core/keybindings.js";
import {
	TURN_FOOT_NOTE_CARETS,
	TURN_FOOT_NOTE_NARROW_COLS,
	TurnFootNote,
	type TurnFootNoteProps,
	turnFootNoteDurationText,
} from "../src/modes/interactive/components/turn-footnote.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** The v4 prototype's reference turn: 1m05s, 14 steps, 7 thinking segments, 2 comms. */
const reference = { steps: 14, thinkSegments: 7, commMessages: 2, durationMs: 65_000 };

const BODY_WIDE = "干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]";
const BODY_NARROW = "干了 1分05秒 · 14步 · 7想 · 2讯";
/** The reference body with every key hint stripped (the overwide fallback). */
const BODY_BARE = "干了 1 分 05 秒 · 14 步 · 想 7 段 · → 通讯 2 条";
/** Indent-aligned lines: the body starts one column in (P3), caret-less. */
const WIDE_LINE = ` ${BODY_WIDE}`;
const NARROW_LINE = ` ${BODY_NARROW}`;

function renderLine(props: TurnFootNoteProps): string {
	const note = new TurnFootNote(props);
	return note.render(200).map(stripAnsi).join("\n");
}

describe("turn footnote (TUI v4 T2b)", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the reference turn as exactly one line in the wide form", () => {
		const note = new TurnFootNote({ ...reference, cols: 120 });
		const lines = note.render(120);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toBe(WIDE_LINE);
		// Key hints carry the prototype accent blue #6ba7ff (P3), in the
		// theme's active color depth: truecolor RGB, or xterm 75 in 256-color.
		expect(lines[0]).toMatch(/\x1b\[38;2;107;167;255m \[O\]\x1b\[39m|\x1b\[38;5;75m \[O\]\x1b\[39m/);
	});

	it("formats the three duration tiers, wide and narrow", () => {
		expect(turnFootNoteDurationText(45_000, false)).toBe("干了 45 秒");
		expect(turnFootNoteDurationText(45_000, true)).toBe("干了 45秒");
		expect(turnFootNoteDurationText(45_400, false)).toBe("干了 45 秒");
		expect(turnFootNoteDurationText(65_000, false)).toBe("干了 1 分 05 秒");
		expect(turnFootNoteDurationText(65_000, true)).toBe("干了 1分05秒");
		expect(turnFootNoteDurationText(4_020_000, false)).toBe("干了 1 时 07 分");
		expect(turnFootNoteDurationText(4_020_000, true)).toBe("干了 1时07分");
		// Minutes stay unpadded; seconds are two digits.
		expect(turnFootNoteDurationText(61_000, false)).toBe("干了 1 分 01 秒");
		expect(turnFootNoteDurationText(0, false)).toBe("干了 0 秒");
	});

	it("switches to the compressed narrow form below 100 columns, same stats (R2.1)", () => {
		// 99 compressed / 100 full / 101 full: the boundary column itself
		// belongs to the wide form (R2.1, matches the prototype's 100ch chat).
		expect(renderLine({ ...reference, cols: TURN_FOOT_NOTE_NARROW_COLS - 1 })).toBe(NARROW_LINE);
		expect(renderLine({ ...reference, cols: TURN_FOOT_NOTE_NARROW_COLS })).toBe(WIDE_LINE);
		expect(renderLine({ ...reference, cols: TURN_FOOT_NOTE_NARROW_COLS + 1 })).toBe(WIDE_LINE);
	});

	it("omits zero-value segments instead of rendering zero counts", () => {
		expect(renderLine({ steps: 14, thinkSegments: 0, commMessages: 0, durationMs: 45_000, cols: 120 })).toBe(
			" 干了 45 秒 · 14 步 [O]",
		);
		expect(renderLine({ steps: 0, thinkSegments: 7, commMessages: 2, durationMs: 45_000, cols: 120 })).toBe(
			" 干了 45 秒 · 想 7 段 [T] · → 通讯 2 条 [P]",
		);
		expect(renderLine({ steps: 0, thinkSegments: 0, commMessages: 2, durationMs: 45_000, cols: 120 })).toBe(
			" 干了 45 秒 · → 通讯 2 条 [P]",
		);
		// The narrow form omits the same way.
		expect(renderLine({ steps: 14, thinkSegments: 0, commMessages: 0, durationMs: 45_000, cols: 80 })).toBe(
			" 干了 45秒 · 14步",
		);
	});

	it("renders no line at all for an all-zero turn", () => {
		const note = new TurnFootNote({ steps: 0, thinkSegments: 0, commMessages: 0, durationMs: 0, cols: 120 });
		expect(note.render(120)).toEqual([]);
	});

	it("renders 想了想 for a thinking-only turn, both widths", () => {
		const thinkingOnly = { steps: 0, thinkSegments: 3, commMessages: 0, durationMs: 36_300 };
		expect(renderLine({ ...thinkingOnly, cols: 120 })).toBe(" 想了想");
		expect(renderLine({ ...thinkingOnly, cols: 80 })).toBe(" 想了想");
	});

	it("drops every key hint first when the line overflows, without an ellipsis", () => {
		// Long-stats stress at the safe-integer ceiling: the wide line with
		// hints spans 103 display columns, the bare body 91. At 102 columns
		// (still wide) every hint disappears but the body stays complete - no
		// ellipsis, every count still readable. Counts at or below
		// Number.MAX_SAFE_INTEGER cannot push the bare wide body past ~91
		// columns, so dropping the hints is always sufficient in wide form;
		// the ellipsis branch is the narrow form's territory.
		const max = Number.MAX_SAFE_INTEGER;
		const lines = new TurnFootNote({
			steps: max,
			thinkSegments: max,
			commMessages: max,
			durationMs: 4_020_000,
			cols: 102,
		}).render(102);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0] ?? "");
		const bare = ` 干了 1 时 07 分 · ${max} 步 · 想 ${max} 段 · → 通讯 ${max} 条`;
		expect(line).toBe(bare);
		expect(visibleWidth(line)).toBe(92);
		expect(line).not.toContain("[O]");
		expect(line).not.toContain("[T]");
		expect(line).not.toContain("[P]");
		expect(line).not.toContain("…");
		// Two columns wider (the indent column costs one) and the hints come back.
		const withKeys = stripAnsi(
			new TurnFootNote({
				steps: max,
				thinkSegments: max,
				commMessages: max,
				durationMs: 4_020_000,
				cols: 104,
			}).render(104)[0] ?? "",
		);
		expect(withKeys).toBe(` 干了 1 时 07 分 · ${max} 步 [O] · 想 ${max} 段 [T] · → 通讯 ${max} 条 [P]`);
		expect(visibleWidth(withKeys)).toBe(104);
	});

	it("truncates at display columns (CJK = 2), not character counts", () => {
		// The narrow reference line is 25 characters but 31 display columns: a
		// 27-column budget fits by character count and must still truncate by
		// display columns.
		const lines = new TurnFootNote({ ...reference, cols: 27 }).render(27);
		const line = stripAnsi(lines[0] ?? "");
		expect(line.endsWith("…")).toBe(true);
		expect(line.startsWith(" 干了")).toBe(true);
		expect(visibleWidth(line)).toBeLessThanOrEqual(27);
	});

	it("derives the bracket hints from the live keybindings, with a literal fallback (R2.2)", () => {
		const line = () => stripAnsi(new TurnFootNote({ ...reference, cols: 120 }).render(120)[0] ?? "");
		// No app keybindings installed: the shipped defaults' literal letters.
		setKeybindings(new PiKeybindingsManager({}));
		expect(line()).toBe(WIDE_LINE);
		// The app defaults (ctrl+o/t/p) derive the same letters - no hardcoding.
		setKeybindings(new AppKeybindingsManager({}));
		expect(line()).toBe(WIDE_LINE);
		// A rebind shows the real letter: ctrl+k → [K].
		setKeybindings(new AppKeybindingsManager({ "app.tools.expand": "ctrl+k" }));
		const rebound = line();
		expect(rebound).toContain("14 步 [K]");
		expect(rebound).not.toContain("[O]");
		expect(rebound).toContain("想 7 段 [T]");
		expect(rebound).toContain("→ 通讯 2 条 [P]");
		// A modifier-less binding renders its bare key in the brackets.
		setKeybindings(new AppKeybindingsManager({ "app.thinking.toggle": "f2" }));
		expect(line()).toContain("想 7 段 [F2]");
		// Restore the bare manager so the remaining tests exercise the fallback.
		setKeybindings(new PiKeybindingsManager({}));
		expect(line()).toBe(WIDE_LINE);
	});

	it("respects showKeys=false by never rendering hints", () => {
		const line = renderLine({ ...reference, cols: 120, showKeys: false });
		expect(line).toBe(` ${BODY_BARE}`);
		expect(renderLine({ ...reference, cols: 120, showKeys: true })).toBe(WIDE_LINE);
	});

	it("renders the caret in the indent column and counts it against the budget (P3)", () => {
		// The canonical glyphs: ▸ while every block is collapsed, ▾ once any
		// of the three detail blocks is open (the wiring owns the flip).
		expect(TURN_FOOT_NOTE_CARETS.collapsed).toBe("▸");
		expect(TURN_FOOT_NOTE_CARETS.expanded).toBe("▾");
		// The caret occupies the indent column - the body column does not move.
		expect(renderLine({ ...reference, cols: 120, caret: TURN_FOOT_NOTE_CARETS.collapsed })).toBe(`▸${BODY_WIDE}`);
		expect(renderLine({ ...reference, cols: 120, caret: TURN_FOOT_NOTE_CARETS.expanded })).toBe(`▾${BODY_WIDE}`);
		// The caret consumes its column: at 59 columns the full line no longer
		// fits even though a caretless footnote would (body bare at 47+1=48).
		const withCaret = stripAnsi(new TurnFootNote({ ...reference, cols: 59, caret: "▸" }).render(59)[0] ?? "");
		expect(visibleWidth(withCaret)).toBeLessThanOrEqual(59);
		expect(withCaret.startsWith("▸")).toBe(true);
		// Default: no caret, a plain space keeps the indent column.
		expect(renderLine({ ...reference, cols: 120 })).toBe(` ${BODY_WIDE}`);
		// Degenerate terminal: the caret column alone fills the width - the
		// line stays bounded instead of overflowing.
		const tiny = stripAnsi(new TurnFootNote({ ...reference, cols: 1, caret: "▸" }).render(1)[0] ?? "");
		expect(visibleWidth(tiny)).toBeLessThanOrEqual(1);
	});

	it("truncates the 空态 line when the terminal is narrower than 想了想", () => {
		// 想了想 is 3 characters but 6 display columns: at 3 columns (one
		// spent on the indent) only the ellipsis survives beside the indent.
		const line = stripAnsi(
			new TurnFootNote({ steps: 0, thinkSegments: 2, commMessages: 0, durationMs: 1_000, cols: 3 }).render(3)[0] ??
				"",
		);
		expect(line).toBe(" …");
		expect(visibleWidth(line)).toBeLessThanOrEqual(3);
	});

	it("recomputes on update() and falls back to the render width when cols is unset", () => {
		const note = new TurnFootNote({ ...reference, cols: 120 });
		expect(stripAnsi(note.render(120)[0] ?? "")).toBe(WIDE_LINE);
		note.update({ steps: 2, thinkSegments: 0, commMessages: 0, durationMs: 165_000, cols: 120 });
		expect(stripAnsi(note.render(120)[0] ?? "")).toBe(" 干了 2 分 45 秒 · 2 步 [O]");
		// cols <= 0 defers to the protocol width: wide at 120, narrow at 80.
		const fallback = new TurnFootNote({ ...reference, cols: 0 });
		expect(stripAnsi(fallback.render(120)[0] ?? "")).toBe(WIDE_LINE);
		const narrowFallback = new TurnFootNote({ ...reference, cols: 0 });
		expect(stripAnsi(narrowFallback.render(80)[0] ?? "")).toBe(NARROW_LINE);
	});
});
