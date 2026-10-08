import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addStep, assistant, quietTurn } from "./ui-blocks-helpers.js";

/**
 * R5-M16: BoxRow.sub/window lost their renderer when the box stopped drawing
 * live sub-lines; the feed still produced them (and TurnTimeline kept the
 * steady* tickers alive for them alone). A row carries only what the box draws.
 */
describe("timeline rows carry no dead live-line fields", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("produces no sub/window on any row", () => {
		const turn = quietTurn({ live: true });
		// A running command with fresh output: its live tail used to ride on `sub`.
		addStep(turn, "c1", "await bash('npm test')", "running");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{ code: "await bash('npm test')" },
			{
				content: [{ type: "text", text: "suite one passed\nrunning suite two" }],
				details: {
					activities: [
						{
							id: "a1",
							kind: "command",
							label: "npm test",
							status: "running",
							detail: "running suite two",
							startedAt: 1,
						},
					],
				},
			},
			true,
		);
		// A subagent still out: its current step used to ride on `sub`.
		turn.timeline.upsertSubagent({
			childId: "child-1",
			name: "worker",
			laneName: "worker",
			status: "running",
			line: "在写回答",
			startedAt: 2,
		});
		// A thinking block still streaming: its three-line window used to ride on `window`.
		turn.timeline.noteMessage(assistant(Date.now(), [{ type: "thinking", thinking: "再想想边界怎么处理。" }]), false);

		const rows = turn.state.boxView().rows;
		expect(rows.some((row) => row.kind === "cmd" && row.status === "running")).toBe(true);
		expect(rows.some((row) => row.kind === "subagent" && row.status === "running")).toBe(true);
		expect(rows.some((row) => row.kind === "think" && row.status === "running")).toBe(true);
		for (const row of rows) {
			expect(Object.keys(row)).not.toContain("sub");
			expect(Object.keys(row)).not.toContain("window");
		}
	});
});
