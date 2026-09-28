import { describe, expect, it } from "vitest";
import {
	aggregateChanges,
	emptyStepFeedData,
	mergeStepResult,
	type StepFeedData,
} from "../src/modes/interactive/components/feed-data.js";

describe("the kernel's symlink flag survives parsing into the feed", () => {
	it("mergeStepResult keeps symlink: true on a file-change record", () => {
		const merged = mergeStepResult(
			emptyStepFeedData(),
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/blink.txt",
							relPath: "blink.txt",
							kind: "created",
							scope: "project",
							added: 0,
							removed: 0,
							symlink: true,
							source: "python",
							at: 1,
						},
					],
				},
			},
			false,
		);
		expect(merged.fileChanges).toHaveLength(1);
		expect(merged.fileChanges?.[0]?.symlink).toBe(true);
	});

	it("aggregateChanges carries the symlink flag onto the ChangeEntry", () => {
		const data: StepFeedData = {
			...emptyStepFeedData(),
			fileChanges: [
				{
					path: "/work/app/blink.txt",
					relPath: "blink.txt",
					kind: "created",
					scope: "project",
					added: 0,
					removed: 0,
					symlink: true,
					source: "python",
					at: 1,
				},
			],
		};
		const changes = aggregateChanges([{ data, toolName: "ipython", order: 0 }], "/work/app");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.symlink).toBe(true);
	});
});
