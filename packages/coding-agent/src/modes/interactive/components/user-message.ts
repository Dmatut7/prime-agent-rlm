import {
	Box,
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	type TableCellSelectionRegion,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { builtinSlashCommandTakesArgument, parseSlashCommand } from "../../../core/slash-commands.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { PromptTokenMask } from "./prompt-highlight.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class HighlightedMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly mask: PromptTokenMask;

	constructor(text: string, markdownTheme: MarkdownTheme, commandEnd = 0, includeBareSeparator = false) {
		this.mask = new PromptTokenMask(text, commandEnd, includeBareSeparator);
		this.markdown = new Markdown(this.mask.text, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	render(width: number): string[] {
		return this.markdown.render(width).map((line) => this.mask.restoreLine(line));
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.markdown.getSelectionRegions().map((region) => ({
			...region,
			content: this.mask.restoreText(region.content),
		}));
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

/** The user's turn marker: an accent `›` on the first line, a matching indent on the rest. */
class MarkedLines implements Component {
	constructor(private readonly child: HighlightedMarkdown) {}

	render(width: number): string[] {
		const marker = ` ${theme.fg("accent", "›")} `;
		const indent = "   ";
		const lines = this.child.render(Math.max(1, width - visibleWidth(indent)));
		return lines.map((line, index) => `${index === 0 ? marker : indent}${line}`);
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.child.getSelectionRegions().map((region) => ({
			...region,
			col: region.col + 3,
			tableLeft: region.tableLeft + 3,
			tableRight: region.tableRight + 3,
		}));
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export class UserMessageComponent extends Container {
	private contentBox: Box;
	private decoratedSource?: string[];
	private decoratedLines?: string[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
	) {
		super();
		const command = parseSlashCommand(text);
		const commandEnd = command && isRecognizedSlashCommand(command.name) ? command.name.length + 1 : 0;
		const includeBareSeparator =
			command !== undefined && commandEnd > 0 && builtinSlashCommandTakesArgument(command.name);
		this.contentBox = new Box(0, 1, (content: string) => theme.getUserMessageBackgroundColor()(content));
		this.contentBox.addChild(
			new MarkedLines(new HighlightedMarkdown(text, markdownTheme, commandEnd, includeBareSeparator)),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// Container.render hands back the same memoized array while the children are
		// unchanged, so the markers go onto a copy that is cached against that array's
		// identity: decorating in place would stack markers on every frame, and
		// returning a fresh array every frame would defeat the parent's identity cache.
		if (this.decoratedSource === lines && this.decoratedLines) {
			return this.decoratedLines;
		}
		const decorated = lines.slice();
		decorated[0] = OSC133_ZONE_START + decorated[0];
		decorated[decorated.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + decorated[decorated.length - 1];
		this.decoratedSource = lines;
		this.decoratedLines = decorated;
		return decorated;
	}
}
