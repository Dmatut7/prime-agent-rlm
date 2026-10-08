import { Clickable, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { stripMachineBlocks } from "../../../core/compaction/machine-blocks.js";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { copyFromSource } from "./block-focus.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";
import { SystemNoticeLine } from "./system-notice.js";
import { formatBoxTokens } from "./turn-timeline.js";

/**
 * The summary as the card shows it: the model's narrative, without the machine
 * ledger tail (`<fact-appendix>`/`<user-requests>`/`<session-handoff>`) the
 * compaction renderer bolts on for the next summarizer.
 */
function displaySummary(summary: string): string {
	return stripMachineBlocks(summary);
}

/** Compaction summary card: full markdown summary when expanded. */
export class CompactionSummaryMessageComponent extends ExpandableCustomMessageBox {
	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	/** The summary's own markdown under the line the card shows: the copy keeps its paragraphs and code. */
	protected override sourceCopyText(): string {
		return copyFromSource(this.headline(), this.message.summary);
	}

	/** `Compacted from 12,345 tokens · focus: …` - the card's own line, in plain words. */
	private headline(): string {
		const instructions = this.message.customInstructions;
		return `Compacted from ${this.message.tokensBefore.toLocaleString()} tokens${
			instructions ? ` · focus: ${instructions}` : ""
		}`;
	}

	protected updateDisplay(): void {
		this.clear();
		const toggle = () => this.setExpanded(!this.expanded);

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = customMessageLabel("compaction");
		this.addChild(new Clickable(new Text(label, 0, 0), toggle));
		this.addChild(new Spacer(1));

		const instructions = this.message.customInstructions;
		if (this.expanded) {
			let header = `**Compacted from ${tokenStr} tokens**\n\n`;
			if (instructions) {
				header += `**Focus:** ${instructions}\n\n`;
			}
			this.addChild(
				new Markdown(header + displaySummary(this.message.summary), 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// U6: no per-line expand hint — the global tail line states the keys.
			this.addChild(new Clickable(new Text(theme.fg("customMessageText", this.headline()), 0, 0), toggle));
		}
	}
}

/**
 * The quiet conversation's face of a compaction that happened before any turn
 * on screen: one faint line in plain words, the summary once opened. (A
 * compaction inside a turn is a row of that turn's box instead.)
 */
export class QuietCompactionNoticeComponent extends Container {
	private expanded = false;

	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const toggle = () => this.setExpanded(!this.expanded);
		const before = `原来 ${formatBoxTokens(this.message.tokensBefore)} tokens，重要的结论都留着`;
		this.addChild(new Spacer(1));
		this.addChild(new Clickable(new SystemNoticeLine("⇣ 前面的对话整理过了", before), toggle));
		if (!this.expanded) return;
		const focus = this.message.customInstructions ? `**重点：** ${this.message.customInstructions}\n\n` : "";
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(focus + displaySummary(this.message.summary), 1, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
