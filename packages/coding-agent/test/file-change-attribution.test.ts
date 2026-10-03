import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFileChangeDisplay } from "../src/core/kernel/effects.js";
import type { KernelFileChange } from "../src/core/kernel/shared.js";
import { getToolFileChanges } from "../src/modes/interactive/components/edit-summary.js";
import { aggregateChanges, emptyStepFeedData, mergeStepResult } from "../src/modes/interactive/components/feed-data.js";
import { changeDetail } from "../src/modes/interactive/components/timeline-rows.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The attribution field's path from the kernel's display record to the entries the turn
 * surfaces render: `origin` survives parsing, result merging, aggregation (own wins when a
 * path is both), and the footnote's per-tool summaries. Records without it (older kernels)
 * read as the session's own.
 */

const AT = new Date(2026, 9, 3, 10, 0, 0).getTime();

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		path: "/work/app/a.ts",
		relPath: "a.ts",
		kind: "modified",
		scope: "project",
		added: 2,
		removed: 1,
		source: "shell",
		at: AT,
		...overrides,
	};
}

function kernelChange(path: string, origin?: KernelFileChange["origin"]): KernelFileChange {
	return {
		path,
		kind: "modified",
		scope: "project",
		added: 1,
		removed: 0,
		source: "shell",
		at: AT,
		...(origin ? { origin } : {}),
	};
}

describe("file-change attribution pipeline", () => {
	beforeAll(() => initTheme("dark"));

	it("parseFileChangeDisplay carries origin and drops values it does not know", () => {
		expect(parseFileChangeDisplay(payload({ origin: "ambient" }))).toMatchObject({ origin: "ambient" });
		expect(parseFileChangeDisplay(payload({ origin: "own" }))).toMatchObject({ origin: "own" });
		const absent = parseFileChangeDisplay(payload());
		expect(absent && "origin" in absent ? absent.origin : undefined).toBeUndefined();
		const unknown = parseFileChangeDisplay(payload({ origin: "maybe" }));
		expect(unknown && "origin" in unknown ? unknown.origin : undefined).toBeUndefined();
	});

	it("mergeStepResult keeps origin through the tool-result details", () => {
		const data = mergeStepResult(
			emptyStepFeedData(),
			"ipython",
			{},
			{
				details: {
					fileChanges: [payload({ origin: "ambient" }), payload({ path: "/work/app/b.ts", relPath: "b.ts" })],
				},
				content: [],
			},
			false,
		);
		expect(data.fileChanges?.map((change) => change.origin)).toEqual(["ambient", undefined]);
	});

	it("aggregateChanges carries origin and lets an own record win over an ambient one for the same path", () => {
		const steps = [
			{
				order: 0,
				toolName: "ipython",
				data: { ...emptyStepFeedData(), fileChanges: [kernelChange("/work/app/a.ts", "ambient")] },
			},
			{
				order: 1,
				toolName: "ipython",
				data: { ...emptyStepFeedData(), fileChanges: [kernelChange("/work/app/a.ts", "own")] },
			},
		];
		const entries = aggregateChanges(steps, "/work/app");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.origin).toBe("own");
		const ambientOnly = aggregateChanges([steps[0]!], "/work/app");
		expect(ambientOnly[0]?.origin).toBe("ambient");
		const legacy = aggregateChanges(
			[
				{
					order: 0,
					toolName: "ipython",
					data: { ...emptyStepFeedData(), fileChanges: [kernelChange("/work/app/a.ts")] },
				},
			],
			"/work/app",
		);
		expect(legacy[0]?.origin).toBeUndefined();
	});

	it("getToolFileChanges passes the kernel record's origin into the footnote summaries", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{ isError: false, details: { fileChanges: [payload({ origin: "ambient" })] } },
			"/work/app",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.origin).toBe("ambient");
		const own = getToolFileChanges(
			"ipython",
			{},
			{ isError: false, details: { fileChanges: [payload()] } },
			"/work/app",
		);
		expect(own[0]?.origin).toBeUndefined();
	});

	it("an ambient record's opened diff does not claim a session writer", () => {
		const detail = changeDetail({
			key: "/work/app/a.ts",
			path: "a.ts",
			kind: "modified",
			scope: "project",
			added: 1,
			removed: 0,
			rows: [{ kind: "add", line: 1, text: "x" }],
			truncated: false,
			binary: false,
			source: "shell",
			origin: "ambient",
			firstAt: AT,
		})(80);
		expect(stripAnsi(detail[0] ?? "")).toContain("别的窗口或进程");
		const ownDetail = changeDetail({
			key: "/work/app/a.ts",
			path: "a.ts",
			kind: "modified",
			scope: "project",
			added: 1,
			removed: 0,
			rows: [{ kind: "add", line: 1, text: "x" }],
			truncated: false,
			binary: false,
			source: "python",
			firstAt: AT,
		})(80);
		expect(stripAnsi(ownDetail.join("\n"))).toContain("Python 代码改的");
	});
});
