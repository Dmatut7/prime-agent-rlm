import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	createAutoContinueMessage,
	createCompactionSummaryMessage,
	createRefinementOutcomeMessage,
} from "../src/core/messages.js";
import type { RefinementResult } from "../src/core/refinement/refinement.js";
import type { ParsedSkillBlock } from "../src/core/skill-blocks.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { InjectedPromptMessageComponent } from "../src/modes/interactive/components/injected-prompt-message.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addSay, quietTurn, T0 } from "./ui-blocks-helpers.js";

/**
 * R3-M19: `y` on an expanded card copied its *rendered rows*, and the copy helper trimmed every row
 * and dropped the blank ones - a card's code lost its indentation and its prose lost its paragraph
 * breaks. The cards hold the text they render, so the copy takes that.
 */

const CODE = ["运行：", "", "    npm run check", "    git status", "", "两段之间有空行。"].join("\n");

let restoreKeys: (() => void) | undefined;

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterAll(() => restoreKeys?.());

describe("a block copy keeps the source's shape", () => {
	it("copies a skill's markdown, indentation and blank lines included", () => {
		const block: ParsedSkillBlock = {
			name: "deploy-check",
			location: "/skills/deploy-check",
			content: CODE,
			userMessage: undefined,
		};
		const card = new SkillInvocationMessageComponent(block);
		card.setExpanded(true);
		expect(card.getBlockCopyText()).toBe(`deploy-check\n\n${CODE}`);
	});

	it("copies a compaction summary under the card's own line", () => {
		const card = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage(CODE, 123456, "2026-10-06T10:00:00.000Z", "只看显示层"),
		);
		card.setExpanded(true);
		expect(card.getBlockCopyText()).toBe(
			`Compacted from ${(123456).toLocaleString()} tokens · focus: 只看显示层\n\n${CODE}`,
		);
	});

	it("copies an injected prompt's whole text, paragraphs intact", () => {
		const card = new InjectedPromptMessageComponent(
			createAutoContinueMessage({ reason: "announced_next_step", excerpt: "接着跑检查", ordinal: 1, maxOrdinal: 3 }),
		);
		card.setExpanded(true);
		const copied = card.getBlockCopyText();
		// The notice's own line heads it, and the prompt's paragraph breaks survive the copy.
		expect(copied.startsWith("↻ 自动继续")).toBe(true);
		expect(copied).toContain("\n\n");
		expect(copied).toContain("[auto-continue]");
		for (const paragraph of copied.split("\n\n").slice(1)) expect(paragraph).not.toMatch(/^\s+/);
	});

	it("copies every memory a refinement kept, with its own text, open or not", () => {
		const memory = ["记住三件事：", "", "    一、缩进要留着", "    二、空行要留着", "", "完。"].join("\n");
		const result: RefinementResult = {
			id: "refine-shape",
			summary: "记下了显示层的三条结论。",
			rationale: "老板要求。",
			expectedOutcome: "复制不丢格式。",
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "shape",
					title: "复制要留格式",
					content: memory,
					path: "memory/shape.md",
					after: {
						id: "shape",
						kind: "memory",
						title: "复制要留格式",
						content: memory,
						path: "memory/shape.md",
						scope: "local",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refinement",
						created_at: "2026-10-06T00:00:00.000Z",
						updated_at: "2026-10-06T00:00:00.000Z",
						version: 1,
					},
					applied: true,
				},
				{ action: "delete", kind: "memory", id: "gone", title: "旧条目", applied: false, error: "disk full" },
			],
			harnessStatePath: "/tmp/harness/state.json",
			scope: "local",
		};
		const card = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result));
		timelineShowAll.set(true);
		try {
			// Closed, the card shows one row; the copy still carries what it kept.
			const closed = card.getBlockCopyText();
			expect(closed).toContain("回合后整理记忆：新记 1 条，1 条没写进去（本会话）");
			expect(closed).toContain(memory);
			expect(closed).toContain("✗ 旧条目  没写进去：disk full");
			card.setExpanded(true);
			expect(card.getBlockCopyText()).toBe(closed);
		} finally {
			timelineShowAll.set(false);
		}
	});

	it("keeps the blank rows between the paragraphs of an opened turn-box event", () => {
		const turn = quietTurn({ live: false, startedAt: T0 });
		addSay(turn, "第一段说完了。\n\n    第二段带缩进。", "s1", T0 + 1_000);
		turn.state.markTurnEnded(T0 + 2_000);
		turn.state.finishBox(T0 + 2_000);
		turn.summary.render(100);
		const event = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:"));
		expect(event).toBeDefined();
		if (event !== undefined) turn.summary.activate(event);
		const copied = turn.summary.getBlockCopyText();
		expect(copied).toContain("第一段说完了。");
		expect(copied).toContain("第二段带缩进。");
		// The paragraph break and the second paragraph's own indentation survive the copy.
		expect(copied).toContain("\n\n");
		expect(copied.split("\n").some((line) => /^\s+第二段带缩进。/.test(line))).toBe(true);
	});
});
