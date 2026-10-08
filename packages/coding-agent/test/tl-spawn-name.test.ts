import { describe, expect, it } from "vitest";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";

const T0 = 1_700_000_000_000;

/**
 * W8 2.1 (R5-M7 half-fix): a settled subagent record carries the child's exact
 * session name in `name` next to the display label, whose blanks the kernel's
 * display pipeline collapsed (and whose secrets it redacted). The timeline
 * keyed its spawn row by the collapsed label, so a report arriving under the
 * child's real name ("build  checker") never matched the row: it stayed
 * running forever, and the snapshot's own row for the same child drew beside
 * it as a second lane.
 */
describe("subagent spawn rows keyed by the recorded session name", () => {
	const activity = {
		id: "spawn-1",
		kind: "subagent" as const,
		status: "ok" as const,
		// The kernel's display label collapsed the double space; `name` keeps it.
		label: "build checker",
		name: "build  checker",
		startedAt: T0,
	};

	function spawnTimeline(): TurnTimeline {
		const timeline = new TurnTimeline();
		timeline.mergeStep("cell-1", "ipython", {}, { details: { activities: [activity] } }, false);
		return timeline;
	}

	it("settles the spawn row when the child reports back under its real name", () => {
		const timeline = spawnTimeline();
		expect(timeline.entries.some((entry) => entry.kind === "subagent")).toBe(true);

		timeline.subagentReturned("build  checker", T0 + 5_000);

		const row = timeline.entries.find((entry) => entry.kind === "subagent");
		expect(row?.sub.status).toBe("done");
		expect(row?.sub.endedAt).toBe(T0 + 5_000);
	});

	it("merges the snapshot's row for the same child instead of drawing a second one", () => {
		const timeline = spawnTimeline();
		timeline.upsertSubagent(
			{
				childId: "child-1",
				name: "build  checker",
				laneName: "build  checker",
				status: "done",
				startedAt: T0,
				endedAt: T0 + 5_000,
			},
			T0 + 6_000,
		);
		const rows = timeline.entries.filter((entry) => entry.kind === "subagent");
		expect(rows).toHaveLength(1);
	});

	it("still keys by the label when the record carries no name", () => {
		const timeline = new TurnTimeline();
		timeline.mergeStep(
			"cell-2",
			"ipython",
			{},
			{
				details: {
					activities: [{ id: "spawn-2", kind: "subagent", status: "ok", label: "build checker", startedAt: T0 }],
				},
			},
			false,
		);
		timeline.subagentReturned("build checker", T0 + 5_000);
		const row = timeline.entries.find((entry) => entry.kind === "subagent");
		expect(row?.sub.status).toBe("done");
	});
});
