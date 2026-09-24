import {
	type Component,
	Container,
	type MarkdownTheme,
	type TableCellSelectionRegion,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { builtinSlashCommandTakesArgument, parseSlashCommand } from "../../../core/slash-commands.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { type BlockFocusState, decorateFocusedBlock, type FocusableBlock } from "./block-focus.js";
import { PromptTokenMask } from "./prompt-highlight.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * The user's text exactly as typed: wrapped, never parsed as Markdown (a
 * `__name__` stays `__name__`, not a bold `name`). Slash-command and argument
 * tokens keep their highlight through the PromptTokenMask round trip.
 */
class HighlightedText implements Component {
	private readonly mask: PromptTokenMask;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, commandEnd = 0, includeBareSeparator = false) {
		this.mask = new PromptTokenMask(
			text.replace(/\r\n?/g, "\n").replace(/\s+$/, ""),
			commandEnd,
			includeBareSeparator,
		);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		for (const raw of this.mask.text.split("\n")) {
			const expanded = raw.replace(/\t/g, "   ");
			for (const wrapped of wrapTextWithAnsi(expanded, safeWidth)) {
				lines.push(this.mask.restoreLine(theme.fg("userMessageText", wrapped)));
			}
		}
		this.cachedWidth = width;
		this.cachedLines = lines.length > 0 ? lines : [""];
		return this.cachedLines;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return [];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * How far the bubble sits in from the left: the same one-column margin as the
 * AI header, gutter and running card (some terminals clip column 0), so both
 * edges line up with everything else; the tint alone marks the user's words.
 * Below 10 columns every cell goes to the text.
 */
export function userBubbleIndent(width: number): number {
	return width >= 10 ? 1 : 0;
}

/** Columns of padding inside the bubble, left and right. */
const BUBBLE_PAD = 2;

/**
 * When the message was sent: `20:14` today, `昨天 20:14`, `9月23日 20:14`
 * earlier this year, `2025年9月23日 20:14` before that - a session left
 * running for days still says which day each message is from.
 */
export function sentAtText(sentAt: number | undefined, now = Date.now()): string {
	if (sentAt === undefined || !Number.isFinite(sentAt)) return "";
	const date = new Date(sentAt);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	if (sentAt >= dayStart) return time;
	const yesterdayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
	if (sentAt >= yesterdayStart) return `昨天 ${time}`;
	const day = `${date.getMonth() + 1}月${date.getDate()}日`;
	return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`;
}

/**
 * v3 chat layers: the user's words in a tinted bubble on the one-column margin,
 * with a `you` label and the send time on top - so a screen of text shows at
 * a glance which lines are the user's.
 */
class UserBubble implements Component {
	private lastIndent = 0;
	private cachedWidth?: number;
	private cachedTime?: string;
	private cachedLines?: string[];

	constructor(
		private readonly child: HighlightedText,
		private readonly sentAt: number | undefined,
	) {}

	render(width: number): string[] {
		// The label moves on at midnight (`20:14` becomes `昨天 20:14`), so it is part of the cache key.
		const time = sentAtText(this.sentAt);
		if (this.cachedLines && this.cachedWidth === width && this.cachedTime === time) {
			return this.cachedLines;
		}
		const indent = userBubbleIndent(width);
		this.lastIndent = indent;
		const bubbleWidth = Math.max(1, width - indent);
		const innerWidth = Math.max(1, bubbleWidth - BUBBLE_PAD * 2);
		const paint = theme.getUserBubbleBackgroundColor();
		const lead = " ".repeat(indent);
		const pad = " ".repeat(BUBBLE_PAD);
		const row = (content: string): string => {
			const body = truncateToWidth(`${pad}${content}`, bubbleWidth, "");
			return lead + paint(body + " ".repeat(Math.max(0, bubbleWidth - visibleWidth(body))));
		};
		const header = `${theme.bold(theme.fg("userLabel", "you"))}${time ? theme.fg("dim", `  ${time}`) : ""}`;
		this.cachedWidth = width;
		this.cachedTime = time;
		this.cachedLines = [row(header), ...this.child.render(innerWidth).map((line) => row(line)), row("")];
		return this.cachedLines;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		// The text sits one row under the label, after the indent and the padding.
		const shift = this.lastIndent + BUBBLE_PAD;
		return this.child.getSelectionRegions().map((region) => ({
			...region,
			line: region.line + 1,
			col: region.col + shift,
			tableLeft: region.tableLeft + shift,
			tableRight: region.tableRight + shift,
		}));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.child.invalidate();
	}
}

export class UserMessageComponent extends Container implements FocusableBlock {
	private decoratedSource?: string[];
	private decoratedLines?: string[];
	private blockFocus?: BlockFocusState;

	constructor(
		private readonly text: string,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
		sentAt?: number,
	) {
		super();
		const command = parseSlashCommand(text);
		const commandEnd = command && isRecognizedSlashCommand(command.name) ? command.name.length + 1 : 0;
		const includeBareSeparator =
			command !== undefined && commandEnd > 0 && builtinSlashCommandTakesArgument(command.name);
		this.addChild(new UserBubble(new HighlightedText(text, commandEnd, includeBareSeparator), sentAt));
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
			return this.blockFocus
				? decorateFocusedBlock(this.decoratedLines, width, this.blockFocus)
				: this.decoratedLines;
		}
		const decorated = lines.slice();
		decorated[0] = OSC133_ZONE_START + decorated[0];
		decorated[decorated.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + decorated[decorated.length - 1];
		this.decoratedSource = lines;
		this.decoratedLines = decorated;
		return this.blockFocus ? decorateFocusedBlock(decorated, width, this.blockFocus) : decorated;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	getBlockCopyText(): string {
		return this.text;
	}
}
