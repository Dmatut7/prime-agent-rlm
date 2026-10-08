import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { renderMachineBlock } from "../src/core/compaction/machine-blocks.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../src/core/messages.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import {
	CompactionSummaryMessageComponent,
	QuietCompactionNoticeComponent,
} from "../src/modes/interactive/components/compaction-summary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * R6-M7: an expanded compaction/branch summary card rendered the summary's raw
 * tail - the `<fact-appendix>`/`<user-requests>`/`<session-handoff>` machine
 * ledgers written for the next summarizer, hundreds of JSON lines in a real
 * session. The cards show the narrative; the machine blocks are stripped.
 */

const NARRATIVE = "上一段在修显示层的对账，结论都留在这了。";

/** A summary as the compaction renderer writes it: narrative, then the machine tail. */
function summaryWithMachineTail(): string {
	return (
		NARRATIVE +
		renderMachineBlock("fact-appendix", { facts: 1 }, '{"fact":"显示层对账完"}') +
		renderMachineBlock("user-requests", { count: 1 }, "- 把幻行修掉") +
		renderMachineBlock("session-handoff", { active: 0 }, '{"agents":[]}')
	);
}

function plain(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(100).join("\n"));
}

function expectNarrativeOnly(rendered: string): void {
	expect(rendered).toContain(NARRATIVE);
	expect(rendered).not.toContain("fact-appendix");
	expect(rendered).not.toContain("user-requests");
	expect(rendered).not.toContain("session-handoff");
	expect(rendered).not.toContain('{"fact"');
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("summary cards hide the machine ledger tail", () => {
	it("compaction card, expanded", () => {
		const card = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage(summaryWithMachineTail(), 123456, "2026-10-06T10:00:00.000Z"),
		);
		card.setExpanded(true);
		expectNarrativeOnly(plain(card));
	});

	it("quiet compaction notice, expanded", () => {
		const notice = new QuietCompactionNoticeComponent(
			createCompactionSummaryMessage(summaryWithMachineTail(), 123456, "2026-10-06T10:00:00.000Z"),
		);
		notice.setExpanded(true);
		expectNarrativeOnly(plain(notice));
	});

	it("branch summary card, expanded", () => {
		const card = new BranchSummaryMessageComponent(
			createBranchSummaryMessage(summaryWithMachineTail(), "entry-1", "2026-10-06T10:00:00.000Z"),
		);
		card.setExpanded(true);
		expectNarrativeOnly(plain(card));
	});
});
