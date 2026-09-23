import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	TURN_FOOT_NOTE_CARETS,
	TURN_FOOT_NOTE_MAX_FILE_ROWS,
	TurnFootNote,
	type TurnFootNoteProps,
	turnFootNoteDurationText,
} from "../src/modes/interactive/components/turn-footnote.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** Reference turn: 1m05s, 14 steps, 7 thinking segments measured at 6.2s, 2 comms. */
const reference = { steps: 14, thinkSegments: 7, commMessages: 2, durationMs: 65_000, thinkingMs: 6_200 };
const STATS = "Thinking 6.2s · 14 步 · 共 1m05s · 通讯 2 条";

function render(props: TurnFootNoteProps): string[] {
	return new TurnFootNote(props).render(200).map((line) => stripAnsi(line));
}

function renderLine(props: TurnFootNoteProps): string {
	return render(props)[0] ?? "";
}

function columnOf(line: string, substr: string): number {
	return visibleWidth(line.slice(0, line.indexOf(substr)));
}

describe("turn footnote (process line)", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the reference turn as one stats line with no key hints", () => {
		const lines = render({ ...reference, cols: 120 });
		expect(lines).toEqual([` ${STATS}`]);
		expect(lines[0]).not.toMatch(/\[[OTP]\]/);
	});

	it("puts the caret at column 1 followed by a space", () => {
		expect(renderLine({ ...reference, cols: 120, caret: TURN_FOOT_NOTE_CARETS.collapsed })).toBe(` ▸ ${STATS}`);
		expect(renderLine({ ...reference, cols: 120, caret: TURN_FOOT_NOTE_CARETS.expanded })).toBe(` ▾ ${STATS}`);
	});

	it("formats durations as 14.8s, 1m05s and 1h07m", () => {
		expect(turnFootNoteDurationText(0)).toBe("0.0s");
		expect(turnFootNoteDurationText(14_800)).toBe("14.8s");
		expect(turnFootNoteDurationText(59_900)).toBe("59.9s");
		expect(turnFootNoteDurationText(59_950)).toBe("1m00s");
		expect(turnFootNoteDurationText(65_000)).toBe("1m05s");
		expect(turnFootNoteDurationText(4_020_000)).toBe("1h07m");
		expect(turnFootNoteDurationText(-5)).toBe("0.0s");
	});

	it("omits zero-value segments instead of rendering zero counts", () => {
		expect(renderLine({ steps: 14, thinkSegments: 0, commMessages: 0, durationMs: 14_800, cols: 120 })).toBe(
			" 14 步 · 共 14.8s",
		);
		expect(renderLine({ steps: 0, thinkSegments: 7, commMessages: 2, durationMs: 3_200, cols: 120 })).toBe(
			" 3.2s · 通讯 2 条",
		);
		expect(renderLine({ steps: 0, thinkSegments: 3, commMessages: 0, durationMs: 3_200, cols: 120 })).toBe(
			" Thinking 3.2s",
		);
	});

	it("renders nothing for an all-zero turn", () => {
		const note = new TurnFootNote({ steps: 0, thinkSegments: 0, commMessages: 0, durationMs: 9_000, cols: 120 });
		expect(note.render(120)).toEqual([]);
		expect(note.getClickRegions()).toEqual([]);
	});

	it("appends the plain-words summary after the stats, dim", () => {
		const props = { ...reference, cols: 120, caret: "▸", summary: "运行 npm check · 读取 footer.ts" };
		const raw = new TurnFootNote(props).render(120)[0] ?? "";
		expect(stripAnsi(raw)).toBe(` ▸ ${STATS}   运行 npm check · 读取 footer.ts`);
		const dimOnly = new TurnFootNote({ ...props, summary: undefined }).render(120)[0] ?? "";
		expect(raw.length).toBeGreaterThan(dimOnly.length + "   运行 npm check · 读取 footer.ts".length);
	});

	it("truncates the summary with an ellipsis and drops it below 12 columns", () => {
		const summary = "运行 npm run check · 读取 src/modes/interactive/components/footer.ts";
		const base = { steps: 2, thinkSegments: 0, commMessages: 0, durationMs: 1_000, summary, caret: "▸" };
		const stats = " ▸ 2 步 · 共 1.0s";
		const statsWidth = visibleWidth(stats);
		// Exactly 12 columns of summary room: it renders, truncated.
		const fit = renderLine({ ...base, cols: statsWidth + 3 + 12 });
		expect(fit.startsWith(`${stats}   `)).toBe(true);
		expect(fit.endsWith("…")).toBe(true);
		expect(visibleWidth(fit)).toBeLessThanOrEqual(statsWidth + 15);
		// 11 columns: the summary drops whole.
		expect(renderLine({ ...base, cols: statsWidth + 3 + 11 })).toBe(stats);
	});

	it("truncates at display columns (CJK = 2) when the stats alone overflow", () => {
		for (const cols of [6, 9, 12, 15]) {
			const line = renderLine({ ...reference, cols, caret: "▸" });
			expect(visibleWidth(line), `cols ${cols}`).toBeLessThanOrEqual(cols);
			expect(line.endsWith("…"), `cols ${cols}`).toBe(true);
		}
	});

	it("lists changed files under the line, capped with a count row", () => {
		const change = (i: number) => ({ path: `src/file-${i}.ts`, added: i, removed: 1 });
		const two = render({ ...reference, cols: 120, fileChanges: [change(1), change(2)] });
		expect(two.slice(1)).toEqual(["   改动  src/file-1.ts  +1 −1", "   改动  src/file-2.ts  +2 −1"]);

		const exact = render({
			...reference,
			cols: 120,
			fileChanges: Array.from({ length: TURN_FOOT_NOTE_MAX_FILE_ROWS }, (_, i) => change(i)),
		});
		expect(exact).toHaveLength(1 + TURN_FOOT_NOTE_MAX_FILE_ROWS);
		expect(exact.some((line) => line.includes("还有"))).toBe(false);

		const many = render({ ...reference, cols: 120, fileChanges: Array.from({ length: 8 }, (_, i) => change(i)) });
		expect(many).toHaveLength(1 + TURN_FOOT_NOTE_MAX_FILE_ROWS);
		expect(many.at(-1)).toBe("   … 还有 4 个文件");
	});

	it("keeps changed-file rows within the width, truncating the path", () => {
		const rows = render({
			...reference,
			cols: 30,
			fileChanges: [
				{ path: "packages/coding-agent/src/modes/interactive/components/footer.ts", added: 3, removed: 5 },
			],
		});
		expect(rows[1]?.endsWith("+3 −5")).toBe(true);
		expect(rows[1]).toContain("…");
		expect(visibleWidth(rows[1] ?? "")).toBeLessThanOrEqual(30);
	});

	it("recomputes on update() and falls back to the render width when cols is unset", () => {
		const note = new TurnFootNote({ ...reference, cols: 120 });
		expect(stripAnsi(note.render(120)[0] ?? "")).toBe(` ${STATS}`);
		note.update({ ...reference, steps: 3, cols: 120 });
		expect(stripAnsi(note.render(120)[0] ?? "")).toBe(" Thinking 6.2s · 3 步 · 共 1m05s · 通讯 2 条");
		note.update({ ...reference, cols: 0 });
		const line = stripAnsi(note.render(8)[0] ?? "");
		expect(visibleWidth(line)).toBeLessThanOrEqual(8);
	});

	it("registers one click region per rendered stats segment at exact columns", () => {
		const onSegmentClick = vi.fn();
		const note = new TurnFootNote({ ...reference, cols: 120, onSegmentClick });
		const line = stripAnsi(note.render(120)[0] ?? "");
		const regions = note.getClickRegions();
		expect(regions).toHaveLength(3);
		const expected = [
			{ text: "Thinking 6.2s", segment: "think" },
			{ text: "14 步", segment: "steps" },
			{ text: "通讯 2 条", segment: "comm" },
		];
		for (const [index, entry] of expected.entries()) {
			const region = regions[index];
			expect(region?.line).toBe(0);
			expect(region?.col).toBe(columnOf(line, entry.text));
			expect(region?.width).toBe(visibleWidth(entry.text));
			region?.onClick?.({ line: 0, col: region.col } as never);
			expect(onSegmentClick).toHaveBeenLastCalledWith(entry.segment);
		}
	});

	it("gives the caret its own click lane and offsets segments by the 3-column indent", () => {
		const onCaretClick = vi.fn();
		const onSegmentClick = vi.fn();
		const note = new TurnFootNote({ ...reference, cols: 120, caret: "▸", onCaretClick, onSegmentClick });
		const line = stripAnsi(note.render(120)[0] ?? "");
		const [caret, think] = note.getClickRegions();
		expect(caret).toMatchObject({ line: 0, col: 0, width: 2 });
		caret?.onClick?.({ line: 0, col: 0 } as never);
		expect(onCaretClick).toHaveBeenCalledTimes(1);
		expect(think?.col).toBe(3);
		expect(columnOf(line, "Thinking")).toBe(3);
	});

	it("registers no click regions without callbacks", () => {
		const note = new TurnFootNote({ ...reference, cols: 120, caret: "▸" });
		note.render(120);
		expect(note.getClickRegions()).toEqual([]);
	});

	it("keeps the regions clipped to the budget when the stats overflow", () => {
		const onSegmentClick = vi.fn();
		const cols = 14;
		const note = new TurnFootNote({ ...reference, cols, caret: "▸", onSegmentClick, onCaretClick: () => {} });
		note.render(cols);
		const regions = note.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		for (const region of regions) {
			expect(region.col + region.width).toBeLessThanOrEqual(cols);
			expect(region.width).toBeGreaterThan(0);
		}
		// The comm segment sits past the budget, so it has no region.
		expect(regions.some((region) => region.col >= cols)).toBe(false);
	});

	it("reads a running turn as 运行中 with the step reached so far and a whole-second clock", () => {
		const line = renderLine({ ...reference, cols: 120, running: true, caret: TURN_FOOT_NOTE_CARETS.expanded });
		expect(line).toBe(" ▾ 运行中 · 第 14 步 · 1m 05s");
		expect(
			renderLine({ steps: 0, thinkSegments: 1, commMessages: 0, durationMs: 3_000, cols: 120, running: true }),
		).toBe(" 运行中 · 3s");
	});

	it("keeps the tail of a long changed-file path readable", () => {
		const path = "/private/tmp/claude-501/very-long-session-directory-name/scratchpad/shop.md";
		const [, row] = new TurnFootNote({
			...reference,
			cols: 50,
			fileChanges: [{ path, added: 1, removed: 1 }],
		})
			.render(50)
			.map((line) => stripAnsi(line));
		expect(row).toMatch(/^ {3}改动 {2}…\/.*shop\.md {2}\+1 −1$/);
		expect(visibleWidth(row ?? "")).toBeLessThanOrEqual(50);
	});

	it("names thinking only when it was measured, and an answer-only turn by its thinking time", () => {
		expect(renderLine({ steps: 2, thinkSegments: 1, commMessages: 0, durationMs: 4_000, cols: 120 })).toBe(
			" 2 步 · 共 4.0s",
		);
		expect(
			renderLine({ steps: 2, thinkSegments: 1, commMessages: 0, durationMs: 4_000, thinkingMs: 20, cols: 120 }),
		).toBe(" 2 步 · 共 4.0s");
		expect(
			renderLine({ steps: 2, thinkSegments: 0, commMessages: 0, durationMs: 4_000, thinkingMs: 900, cols: 120 }),
		).toBe(" 2 步 · 共 4.0s");
		expect(
			renderLine({ steps: 2, thinkSegments: 1, commMessages: 0, durationMs: 4_000, thinkingMs: 900, cols: 120 }),
		).toBe(" Thinking 0.9s · 2 步 · 共 4.0s");
		expect(
			renderLine({ steps: 0, thinkSegments: 1, commMessages: 0, durationMs: 4_000, thinkingMs: 1_500, cols: 120 }),
		).toBe(" Thinking 1.5s");
		expect(renderLine({ steps: 0, thinkSegments: 1, commMessages: 0, durationMs: 4_000, cols: 120 })).toBe(
			" Thinking 4.0s",
		);
	});

	it("previews the latest thinking in two dim rows under the line", () => {
		const preview = "先确认两个数据源。".repeat(20);
		const lines = render({ ...reference, cols: 80, caret: "▾", thinkingPreview: preview });
		expect(lines).toHaveLength(3);
		expect(lines[1]?.startsWith("   Thinking  ")).toBe(true);
		expect(lines[2]?.startsWith("             ")).toBe(true);
		expect(lines[2]).toContain("…");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("renders no preview rows for an empty trace", () => {
		expect(render({ ...reference, cols: 80, thinkingPreview: "   " })).toHaveLength(1);
	});
});
