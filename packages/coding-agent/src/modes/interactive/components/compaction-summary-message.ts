import { Clickable, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";

/** Compaction summary card: full markdown summary when expanded. */
export class CompactionSummaryMessageComponent extends ExpandableCustomMessageBox {
	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
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
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const focus = instructions ? ` · focus: ${instructions}` : "";
			// U6: no per-line expand hint — the global tail line states the keys.
			this.addChild(
				new Clickable(
					new Text(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens${focus}`), 0, 0),
					toggle,
				),
			);
		}
	}
}
