import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { TurnFootNote, type TurnFootNoteProps } from "../src/modes/interactive/components/turn-footnote.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Change attribution in the per-turn process line: per-file rows are this session's own
 * changes; changes another window or process made while the turn ran fold into one dim
 * `工作区另有 N 个变动` row that does not consume the own-rows budget.
 */

const reference = { steps: 3, thinkSegments: 0, commMessages: 0, durationMs: 12_000 };

function render(props: TurnFootNoteProps): string[] {
	return new TurnFootNote(props).render(200).map((line) => stripAnsi(line));
}

describe("turn footnote change attribution", () => {
	beforeAll(() => initTheme("dark"));

	it("renders own file rows as before when nothing is ambient", () => {
		const lines = render({
			...reference,
			cols: 120,
			fileChanges: [
				{ path: "src/a.ts", added: 3, removed: 1 },
				{ path: "src/b.ts", added: 1, removed: 0 },
			],
		});
		const text = lines.join("\n");
		expect(text).toContain("改动");
		expect(text).toContain("src/a.ts");
		expect(text).toContain("src/b.ts");
		expect(text).not.toContain("另有");
	});

	it("keeps ambient changes out of the file rows and folds them into one count row", () => {
		const lines = render({
			...reference,
			cols: 120,
			fileChanges: [
				{ path: "src/a.ts", added: 3, removed: 1 },
				{ path: "ext/b.ts", added: 5, removed: 0, origin: "ambient" },
				{ path: "ext/c.ts", added: 1, removed: 1, origin: "ambient" },
			],
		});
		const text = lines.join("\n");
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("ext/b.ts");
		expect(text).not.toContain("ext/c.ts");
		expect(text).toContain("工作区另有 2 个变动");
	});

	it("shows the ambient count row for a turn whose only changes are ambient", () => {
		const lines = render({
			...reference,
			cols: 120,
			fileChanges: [{ path: "ext/b.ts", added: 5, removed: 0, origin: "ambient" }],
		});
		const text = lines.join("\n");
		expect(text).not.toContain("ext/b.ts");
		expect(text).toContain("工作区另有 1 个变动");
	});
});
