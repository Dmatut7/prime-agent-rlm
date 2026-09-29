import { setKeybindings } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementFailureMessage, createRefinementOutcomeMessage } from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

const AT = new Date(2026, 8, 29, 19, 7, 5).getTime();

let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	chalkLevel = chalk.level;
	chalk.level = 3;
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
});

afterEach(() => {
	timelineShowAll.set(false);
});

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "grow-review",
		kind: "memory",
		title: "grow 批次审查结论",
		content: "范围：16 个提交。",
		path: "memories/grow-review.md",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refinement",
		created_at: "2026-09-29T00:00:00.000Z",
		updated_at: "2026-09-29T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function result(applied: boolean[] = [true]): RefinementResult {
	return {
		id: "refine-1",
		summary: "记下审查结论。",
		rationale: "r",
		expectedOutcome: "o",
		appliedEdits: applied.map((ok, index) => {
			const after = entry({ id: `m${index}`, title: `记忆 ${index}` });
			return {
				action: "create" as const,
				kind: "memory" as const,
				id: after.id,
				title: after.title,
				content: after.content,
				path: after.path,
				after,
				applied: ok,
				...(ok ? {} : { error: "disk full" }),
			};
		}),
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	};
}

const outcome = (applied?: boolean[]) =>
	new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result(applied), true, AT));

const failure = (reason = "provider timeout") =>
	new RefinementOutcomeMessageComponent(
		createRefinementFailureMessage({ refinementId: "refine-2", scope: "local", reason }, true, AT),
	);

describe("a background memory tidy that failed stays on the timeline", () => {
	it("draws a tidy that produced nothing in amber without the full process on", () => {
		const rows = failure().render(160);
		expect(rows.length).toBeGreaterThan(0);
		const text = plain(rows).join("\n");
		expect(text).toContain("回合后整理记忆：没写进去");
		expect(text).toContain("provider timeout");
		expect(rows.join("\n")).toContain(theme.getFgAnsi("timelineFix"));
	});

	it("draws every one of several failures in a row, not one of them", () => {
		const rows = [failure("第一次超时"), failure("第二次超时"), failure("第三次超时")].map((note) =>
			plain(note.render(160)).join("\n"),
		);
		expect(rows.map((row) => row.includes("没写进去"))).toEqual([true, true, true]);
	});

	it("draws a tidy where some edit was refused, in amber, and lets it open", () => {
		const note = outcome([true, false]);
		const rows = note.render(160);
		expect(plain(rows).join("\n")).toContain("新记 1 条，1 条没写进去（本会话）");
		expect(rows.join("\n")).toContain(theme.getFgAnsi("timelineFix"));
		expect(note.getClickRegions()).toHaveLength(1);
		note.setExpanded(true);
		expect(plain(note.render(160)).join("\n")).toContain("没写进去：disk full");
	});

	it("still hides a tidy that kept everything until the full process is on", () => {
		const note = outcome([true, true]);
		expect(note.render(160)).toEqual([]);
		expect(note.getClickRegions()).toEqual([]);
		timelineShowAll.set(true);
		expect(plain(note.render(160)).join("\n")).toContain("新记 2 条");
	});

	it("still hides a tidy where the refiner found nothing worth keeping", () => {
		const note = outcome([]);
		expect(note.render(160)).toEqual([]);
	});

	it("keeps the failed row when the full process is turned off again", () => {
		const note = failure();
		timelineShowAll.set(true);
		expect(note.render(160).length).toBeGreaterThan(0);
		timelineShowAll.set(false);
		expect(plain(note.render(160)).join("\n")).toContain("没写进去");
	});
});
