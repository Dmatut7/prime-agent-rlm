import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	convertToLlm,
	createRefinementFailureMessage,
	createRefinementOutcomeMessage,
	isRefinementOutcomeMessage,
} from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "rhyme-response-guidance",
		kind: "prompt",
		title: "Rhyme response guidance",
		content: "Make conversational responses rhyme.",
		path: "prompts/rhyme-response-guidance.md",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refinement",
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function result(): RefinementResult {
	const after = entry();
	return {
		id: "refine-rhyme",
		summary: "Added local guidance to make conversational responses rhyme.",
		rationale: "The user requested rhyming guidance.",
		expectedOutcome: "Conversational responses rhyme.",
		appliedEdits: [
			{
				action: "create",
				kind: "prompt",
				id: after.id,
				title: after.title,
				content: after.content,
				path: after.path,
				after,
				applied: true,
			},
		],
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	};
}

function getMessageText(message: unknown): string {
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function rendered(component: RefinementOutcomeMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("RefinementOutcomeMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	// The background tidy is hidden until the closing row's `完整过程 ▸` is on; these tests look at it shown.
	beforeEach(() => {
		timelineShowAll.set(true);
	});

	afterEach(() => {
		timelineShowAll.set(false);
	});

	test("is hidden by default; shown it is one dim note that opens to what it kept", () => {
		const message = createRefinementOutcomeMessage(result());
		const component = new RefinementOutcomeMessageComponent(message);

		timelineShowAll.set(false);
		expect(component.render(120)).toEqual([]);
		expect(component.getBlockCopyText()).toContain("回合后整理记忆：新记 1 条（本会话）");
		timelineShowAll.set(true);

		const collapsed = rendered(component);
		// The first row is the blank rail row that keeps the note off the line above it.
		expect(collapsed.split("\n")[0]).toBe("         │      ");
		const lines = collapsed.split("\n").filter((line) => line.includes("回合后整理记忆"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			new RegExp(
				`^ ${formatTimelineTime(message.timestamp)} {3}· {6}回合后整理记忆：新记 1 条（本会话） +展开 ▸ {2}$`,
			),
		);
		expect(collapsed).not.toContain("memory updated");
		expect(collapsed).not.toContain("Ctrl+O");
		expect(collapsed).not.toContain("Rhyme response guidance");

		component.setExpanded(true);
		const expanded = rendered(component);
		expect(expanded).toContain("收起 ▴");
		expect(expanded).toContain("记住了提示   Rhyme response guidance");
		expect(expanded).toContain("Make conversational responses rhyme.");
		expect(expanded).not.toContain("+ Make conversational responses rhyme.");
		// No JSON dump of the whole entry.
		expect(expanded).not.toContain('"content"');
	});

	test("a user-invoked /refine that changed nothing still lands one dim line (wave-47 A)", () => {
		timelineShowAll.set(false);
		const message = createRefinementOutcomeMessage(
			{ ...result(), appliedEdits: [], summary: "No refinement needed: nothing reusable." },
			true,
			Date.now(),
			"user",
		);
		const component = new RefinementOutcomeMessageComponent(message);
		const lines = component.render(120).map((line) => stripAnsi(line));
		const head = lines.find((line) => line.includes("回合后整理记忆"));
		expect(head).toBeDefined();
		// A deliberate no-op is an answer, not a failure: none of the failed-tidy wording.
		expect(head).not.toContain("没写进去");
		expect(head).not.toContain("下一轮会再试");
	});

	test("a user-invoked /refine with edits shows its row without 完整过程 (wave-47 A)", () => {
		timelineShowAll.set(false);
		const message = createRefinementOutcomeMessage(result(), true, Date.now(), "user");
		const text = stripAnsi(new RefinementOutcomeMessageComponent(message).render(120).join("\n"));
		expect(text).toContain("回合后整理记忆：新记 1 条（本会话）");
	});

	test("auto and legacy (sourceless) clean tidies stay hidden (wave-47 A)", () => {
		timelineShowAll.set(false);
		const sources = ["auto", undefined] as const;
		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) {
			const message =
				source === undefined
					? createRefinementOutcomeMessage({ ...result(), appliedEdits: [] })
					: createRefinementOutcomeMessage({ ...result(), appliedEdits: [] }, true, Date.now(), source);
			expect(new RefinementOutcomeMessageComponent(message).render(120)).toEqual([]);
		}
	});

	test("opens with its own click, never with the process key", () => {
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result()));
		component.render(120);
		const region = component.getClickRegions()[0];
		expect(region?.line).toBe(1);
		region?.onClick({ row: 0, col: 0 });
		expect(component.isBlockExpanded()).toBe(true);
	});

	test("says a partly failed memory update in amber, and a failed refiner that nothing was kept", () => {
		const partial = result();
		partial.appliedEdits = [
			...partial.appliedEdits,
			{ ...partial.appliedEdits[0]!, id: "second", title: "Second", applied: false, error: "disk full" },
		];
		const failed = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(partial));
		const failedRow = failed.render(120).find((line) => stripAnsi(line).includes("回合后整理记忆")) ?? "";
		expect(stripAnsi(failedRow)).toContain("回合后整理记忆：新记 1 条，1 条没写进去（本会话）");
		const ok = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result()));
		const okRow = ok.render(120).find((line) => stripAnsi(line).includes("回合后整理记忆")) ?? "";
		const colour = (row: string) => /(\x1b\[38;[0-9;]*m)回合后/.exec(row)?.[1];
		expect(colour(failedRow)).toBeDefined();
		expect(colour(failedRow)).not.toBe(colour(okRow));

		// Block navigation can focus the line, copy its text, and open it with Enter.
		failed.setBlockFocus({ reveal: false, toggleLabel: "展开" });
		expect(stripAnsi(failed.render(160).join("\n"))).toContain("Enter 展开");
		failed.setBlockFocus(undefined);
		expect(failed.getBlockCopyText()).toContain("回合后整理记忆：新记 1 条，1 条没写进去");
		expect(failed.isBlockExpanded()).toBe(false);
		failed.setExpanded(true);
		expect(failed.isBlockExpanded()).toBe(true);
		expect(failed.getBlockCopyText()).toContain("没写进去：disk full");

		const nothing = new RefinementOutcomeMessageComponent(
			createRefinementFailureMessage({
				refinementId: "r",
				scope: "local",
				reason: "Refiner did not return a JSON object",
			}),
		);
		const line = rendered(nothing);
		expect(line).toContain("回合后整理记忆：没写进去");
		expect(line).toContain("下一轮会再试");
		expect(line).not.toContain("记住了");
	});

	test("truncates a rejected edit's reason at its first line (R3-M23)", () => {
		// The failure row is one accounted timeline row; a reason with a bare \n
		// used to make it two physical ones. The :94 sibling (`missedNoteText`)
		// already takes the first line only.
		const partial = result();
		partial.appliedEdits = [
			{
				...partial.appliedEdits[0]!,
				id: "second",
				title: "Second",
				applied: false,
				error: "first line\nsecond line",
			},
		];
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(partial));
		component.setExpanded(true);
		const rows = component.render(160);
		expect(rows.every((row) => !row.includes("\n"))).toBe(true);
		const row = stripAnsi(rows.find((line) => stripAnsi(line).includes("没写进去：")) ?? "");
		expect(row).toContain("没写进去：first line");
		expect(row).not.toContain("second line");
	});

	test("never draws a row wider than the screen, collapsed or open", () => {
		const long = result();
		const title =
			"Local memory entries for the verifiers project context and running subagent tracking, plus a subagent spec";
		const after = entry({ title });
		long.appliedEdits = [{ ...long.appliedEdits[0]!, title, after }];
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(long));

		const lines = component.render(80).map((line) => stripAnsi(line));
		const content = lines.filter((line) => line.trim().length > 0 && line.includes("回合后整理记忆"));
		expect(content).toHaveLength(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}

		for (const open of [false, true]) {
			component.setExpanded(open);
			const widths = [80, 40, 24, 12, 1];
			expect(widths.length).toBeGreaterThan(0);
			for (const width of widths) {
				for (const line of component.render(width)) {
					expect(visibleWidth(stripAnsi(line)), `width ${width}, open ${open}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("shows only the changed lines of an update, a rename in words, and what a delete removed", () => {
		const base = result();
		const before = entry({
			id: "tone-guidance",
			title: "tone_guidance_2026-09-01",
			content: "Respond plainly.\nKeep it short.",
		});
		const after = entry({
			id: "tone-guidance",
			title: "Tone guidance",
			content: "Respond in rhyme.\nKeep it short.",
			version: 2,
		});
		const deleted = entry({ id: "obsolete-guidance", title: "Obsolete", content: "Use prose." });
		const message = createRefinementOutcomeMessage({
			...base,
			appliedEdits: [
				{ action: "update", kind: "prompt", id: before.id, before, after, applied: true },
				{ action: "delete", kind: "prompt", id: deleted.id, before: deleted, applied: true },
			],
		});
		const component = new RefinementOutcomeMessageComponent(message);
		component.setExpanded(true);
		const output = rendered(component);

		expect(output).toContain("改名  tone guidance → Tone guidance");
		expect(output).toContain("− Respond plainly.");
		expect(output).toContain("+ Respond in rhyme.");
		expect(output).not.toContain("Keep it short.");
		expect(output).toContain("删掉的");
		expect(output).toContain("− Use prose.");
	});

	test("replays the durable outcome collapsed: the process lane does not open it", () => {
		const message = createRefinementOutcomeMessage(result());
		const [component] = buildConversationComponents([message], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
			toolsExpanded: true,
		});

		expect(component).toBeInstanceOf(RefinementOutcomeMessageComponent);
		expect(stripAnsi(component!.render(120).join("\n"))).toContain("回合后整理记忆：新记 1 条");
		expect(stripAnsi(component!.render(120).join("\n"))).not.toContain("Make conversational responses rhyme.");
		timelineShowAll.set(false);
		expect(component!.render(120)).toEqual([]);
	});

	test("renders an informative outcome into the model context as a system receipt", () => {
		const message = createRefinementOutcomeMessage(result());
		expect(isRefinementOutcomeMessage(message)).toBe(true);

		const [rendered] = convertToLlm([message]);
		expect(rendered?.role).toBe("user");
		const text = getMessageText(rendered);
		expect(text).toContain("not a new instruction");
		expect(text).toContain("Added local guidance to make conversational responses rhyme.");
		expect(text).toContain("applied: create prompt:rhyme-response-guidance");

		expect(isRefinementOutcomeMessage({ ...message, details: { ...message.details, edits: [{}] } })).toBe(false);
	});

	test("keeps a malformed or empty outcome out of the model context", () => {
		const malformed = {
			...createRefinementOutcomeMessage(result()),
			details: { summary: "x", scope: "local", edits: [{}] },
		};
		expect(convertToLlm([malformed])).toEqual([]);
		expect(convertToLlm([createRefinementOutcomeMessage({ ...result(), appliedEdits: [] })])).toEqual([]);
	});
});
