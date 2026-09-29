import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	type TableCellSelectionRegion,
	Text,
} from "@earendil-works/pi-tui";
import { LOGIN_RECOVERY_MESSAGE } from "../../../core/auth-guidance.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { type BlockFocusState, decorateFocusedBlock, type FocusableBlock } from "./block-focus.js";
import {
	CollapsibleErrorComponent,
	normalizeErrorDetails,
	shouldCollapseErrorDetails,
	summarizeErrorDetails,
} from "./collapsible-error.js";
import type { MermaidMarkdownTransform } from "./mermaid.js";
import {
	formatTimelineTime,
	TIMELINE_CONTENT_COL,
	type TimelineLane,
	timelineGutter,
	timelineRow,
} from "./timeline-gutter.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const LOGIN_RECOVERY_SUFFIX = `\n\n${LOGIN_RECOVERY_MESSAGE}`;

export interface AssistantMessageComponentOptions {
	cwd?: string;
	/** U6 two-key model: Ctrl+T's thinking-trace lane (O's `expanded` covers the error surface). */
	expanded?: boolean;
	thinkingExpanded?: boolean;
	precededByToolActivity?: boolean;
	/** Replaces Mermaid code blocks in assistant text (never thinking) with Unicode diagrams. */
	mermaidTransform?: MermaidMarkdownTransform;
	/**
	 * TUI v4 quiet conversation: fold this message's text when it carries tool
	 * calls (intermediate narration - "先说再做" preamble), because the turn
	 * footnote carries the process surface instead. The turn's final output
	 * (no tool calls) always renders in full.
	 */
	quiet?: boolean;
	/** The subagent lane column of the timeline rows a quiet summary draws. */
	lane?: TimelineLane;
}

/** Below this width the timeline's 16 left columns leave too little for words; the answer draws plain. */
const TIMELINE_MIN_WIDTH = TIMELINE_CONTENT_COL + 8;

/** A few fixed timeline rows (gaps, the summary header), built once per width. */
class TimelineRows implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly build: (width: number) => string[],
		private readonly narrow: string[] = [],
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = width < TIMELINE_MIN_WIDTH ? this.narrow : this.build(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * One Markdown block of the summary on the timeline: every row behind the
 * answer bar (`┃`), the words from column 16 wrapped at the width minus 16.
 * Paragraph gaps stay as empty bar rows.
 */
class TimelineAnswerBody implements Component {
	private cachedWidth?: number;
	private cachedSource?: string[];
	private cachedLines?: string[];
	private shift = TIMELINE_CONTENT_COL;

	constructor(
		private readonly markdown: Markdown,
		private readonly lane: TimelineLane,
	) {}

	render(width: number): string[] {
		const narrow = width < TIMELINE_MIN_WIDTH;
		const margin = narrow ? 1 : TIMELINE_CONTENT_COL;
		const source = this.markdown.render(Math.max(1, width - (narrow ? 2 : margin)));
		if (this.cachedLines && this.cachedWidth === width && this.cachedSource === source) return this.cachedLines;
		const lead = narrow ? " " : timelineGutter({ main: "answer", lane: this.lane });
		this.shift = margin;
		this.cachedWidth = width;
		this.cachedSource = source;
		this.cachedLines = source.map((line) => lead + line.replace(/ +$/, ""));
		return this.cachedLines;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.markdown.getSelectionRegions().map((region) => ({
			...region,
			col: region.col + this.shift,
			tableLeft: region.tableLeft + this.shift,
			tableRight: region.tableRight + this.shift,
		}));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedSource = undefined;
		this.cachedLines = undefined;
		this.markdown.invalidate();
	}
}

function getThinkingMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	const quiet = (text: string) => theme.fg("thinkingText", text);
	return {
		...baseTheme,
		heading: quiet,
		link: quiet,
		linkUrl: quiet,
		code: quiet,
		codeBlock: quiet,
		codeBlockBorder: quiet,
		quote: quiet,
		quoteBorder: quiet,
		hr: quiet,
		listBullet: quiet,
		highlightCode: (code: string) => code.split("\n").map((line) => quiet(line)),
	};
}

/** An abort reason that only says the user interrupted: shown as a calm `已中断`. */
function isPlainInterrupt(reason: string): boolean {
	return reason === "Request was aborted" || reason === "Operation aborted" || reason.startsWith("已中断");
}

function formatInlineLoginRecoveryMessage(message: string): string | undefined {
	const normalized = normalizeErrorDetails(message);
	if (!normalized.endsWith(LOGIN_RECOVERY_SUFFIX)) {
		return undefined;
	}
	const base = normalized.slice(0, -LOGIN_RECOVERY_SUFFIX.length).trimEnd();
	if (!base || shouldCollapseErrorDetails(base)) {
		return undefined;
	}
	return `${base} · ${LOGIN_RECOVERY_MESSAGE}`;
}

/**
 * Component that renders a complete assistant message.
 *
 * Streaming sends one updateContent() per token, so content updates are
 * reconciled lazily at render time (at most once per frame): when the block
 * structure is unchanged, only the text of changed blocks is updated in place,
 * preserving each Markdown child's render cache instead of rebuilding the tree.
 */
export class AssistantMessageComponent extends Container implements FocusableBlock {
	private blockFocus?: BlockFocusState;
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private expanded = false;
	private thinkingExpanded = false;
	private dirty = false;
	private lastSignature?: string;
	private blockMarkdowns = new Map<number, Markdown>();
	private lastBlockTexts = new Map<number, string>();
	private precededByToolActivity: boolean;
	/** TUI v4 quiet-conversation gate; see {@link AssistantMessageComponentOptions.quiet}. */
	private quiet = false;
	private lane: TimelineLane = "off";
	/** A later reply of the same turn took over: this answer's text lives on as a row in the box. */
	private superseded = false;
	private mermaidTransform?: MermaidMarkdownTransform;
	private baseUrl?: string;
	private isStreaming = false;
	private decoratedSource?: string[];
	private decoratedLines?: string[];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking",
		options: AssistantMessageComponentOptions = {},
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.expanded = options.expanded ?? false;
		this.thinkingExpanded = options.thinkingExpanded ?? false;
		this.precededByToolActivity = options.precededByToolActivity ?? false;
		this.quiet = options.quiet ?? false;
		this.lane = options.lane ?? "off";
		this.mermaidTransform = options.mermaidTransform;
		this.baseUrl = options.cwd ? pathToFileURL(`${resolve(options.cwd)}${sep}`).href : undefined;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Force a full rebuild so theme-dependent children are recreated.
		this.lastSignature = undefined;
		this.dirty = true;
	}

	/** The message this component shows. */
	get message(): AssistantMessage | undefined {
		return this.lastMessage;
	}

	/** Fold this answer's text away: a later reply of the same turn is the one under the box. */
	setSuperseded(superseded: boolean): void {
		if (this.superseded === superseded) return;
		this.superseded = superseded;
		this.dirty = true;
	}

	/** The subagent lane the summary's rows draw; the conversation builder passes what was true when it appended this. */
	setLane(lane: TimelineLane): void {
		if (this.lane === lane) return;
		this.lane = lane;
		this.dirty = true;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.dirty = true;
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.dirty = true;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.dirty = true;
		}
	}

	/** U6: Ctrl+T's lane — show the thinking traces (hideThinkingBlock still wins). */
	setThinkingExpanded(expanded: boolean): void {
		if (this.thinkingExpanded !== expanded) {
			this.thinkingExpanded = expanded;
			this.dirty = true;
		}
	}

	override render(width: number): string[] {
		// The answer reads flush under its turn's box, like any other text.
		const lines = this.renderMessage(width);
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	/** The answer's own Markdown source (text blocks), then the error it ended on, as shown. */
	getBlockCopyText(): string {
		const message = this.lastMessage;
		const parts = (message?.content ?? [])
			.map((block) => (block?.type === "text" ? block.text.trim() : ""))
			.filter((text) => text.length > 0);
		const error = message?.errorMessage?.trim();
		const hasToolCalls = (message?.content ?? []).some((block) => block?.type === "toolCall");
		if (message?.stopReason === "error" && !hasToolCalls) {
			parts.push(`Error: ${error || "Unknown error"}`);
		} else if (message?.stopReason === "aborted" && error && !isPlainInterrupt(error)) {
			parts.push(error);
		}
		return parts.join("\n\n");
	}

	/** Whether the message carries a thinking trace the Thinking lane can open. */
	hasThinkingTrace(): boolean {
		return (this.lastMessage?.content ?? []).some((block) => block?.type === "thinking" && block.thinking.trim());
	}

	private renderMessage(width: number): string[] {
		if (this.dirty) {
			if (this.lastMessage) {
				this.reconcile(this.lastMessage);
			}
			this.dirty = false;
		}
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
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

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.dirty = true;
	}

	/**
	 * Everything that affects child component identity/order, but not the text
	 * inside a block. While the signature is stable, updates reduce to setText()
	 * on changed blocks; any structural change triggers a full rebuild.
	 */
	private computeSignature(message: AssistantMessage): string {
		const parts: string[] = [];
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content?.type === "text") {
				parts.push(`${i}:text:${content.text.trim() ? 1 : 0}`);
			} else if (content?.type === "thinking") {
				parts.push(`${i}:thinking:${content.thinking.trim() ? 1 : 0}`);
			} else {
				parts.push(`${i}:${content?.type ?? "invalid"}`);
			}
		}
		parts.push(
			`hide:${this.hideThinkingBlock}`,
			`label:${this.hiddenThinkingLabel}`,
			`expanded:${this.expanded}`,
			`thinkingExpanded:${this.thinkingExpanded}`,
			// TUI v4: a quiet-mode flip must rebuild so the narration fold applies.
			`quiet:${this.quiet}`,
			`lane:${this.lane}`,
			`superseded:${this.superseded}`,
			// In the signature so the streaming->final transition rebuilds (mermaid renders differently).
			`streaming:${this.isStreaming}`,
			`stop:${message.stopReason ?? ""}`,
			`error:${message.errorMessage ?? ""}`,
		);
		return parts.join("|");
	}

	private reconcile(message: AssistantMessage): void {
		const signature = this.computeSignature(message);
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.rebuild(message);
			return;
		}

		// Structure unchanged: update only blocks whose text changed (during
		// streaming that is just the final block).
		for (let i = 0; i < message.content.length; i++) {
			const markdown = this.blockMarkdowns.get(i);
			if (!markdown) {
				continue;
			}
			const content = message.content[i];
			const text =
				content?.type === "text"
					? content.text.trim()
					: content?.type === "thinking"
						? content.thinking.trim()
						: "";
			if (this.lastBlockTexts.get(i) !== text) {
				markdown.setText(text);
				this.lastBlockTexts.set(i, text);
			}
		}
	}

	private rebuild(message: AssistantMessage): void {
		// Clear content container
		this.contentContainer.clear();
		this.blockMarkdowns.clear();
		this.lastBlockTexts.clear();

		// F2 (DS2 review): a block only counts as visible content if it actually
		// renders - thinking blocks draw nothing while collapsed (or while
		// hideThinkingBlock wins), so they must not earn a Spacer either. The
		// old count left a 2-blank-line wall behind every "thinking + toolCall"
		// message in the default collapsed view.
		const hasToolCalls = message.content.some((c) => c?.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		// TUI v4 quiet gate: every text block of a message that carries tool calls
		// is the event row's (the timeline draws it there in one line), so none of
		// it repeats here as an answer. Error surfaces never fold.
		const foldsText = this.superseded || (this.quiet && hasToolCalls);
		const hasFoldedText = foldsText && message.content.some((c) => c?.type === "text" && c.text.trim().length > 0);
		const rendersThinking = (c: AssistantMessage["content"][number]) =>
			c?.type === "thinking" && c.thinking.trim() && !this.hideThinkingBlock && this.thinkingExpanded;
		// A quiet turn's box already shows a model error as its own red row (or the
		// retry that recovered it); only a login recovery hint still needs the answer area.
		const errorSurface =
			message.stopReason === "error" &&
			!hasToolCalls &&
			(!this.quiet || formatInlineLoginRecoveryMessage(message.errorMessage || "") !== undefined);
		const hasVisibleContent =
			message.content.some(
				(c) =>
					(c?.type === "text" && c.text.trim() && !foldsText) || (c?.type === "thinking" && rendersThinking(c)),
			) ||
			// The error surfaces render in both lanes (aborted, or a
			// non-tool-call error); toolCall blocks render as separate
			// components, not here.
			message.stopReason === "aborted" ||
			errorSurface;

		// The quiet turn's closing answer is the timeline's summary: its own rows
		// (two gaps, the header, the bar) stand in for the leading Spacer.
		const timelineAnswer =
			this.quiet && !hasToolCalls && message.content.some((c) => c?.type === "text" && c.text.trim() && !foldsText);
		const leadingSpacer = hasVisibleContent && !(timelineAnswer && !message.content.some(rendersThinking));
		if (leadingSpacer) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let summaryStarted = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content?.type === "text" && content.text.trim() && !foldsText) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const mermaidTransform = this.mermaidTransform;
				const isStreaming = this.isStreaming;
				const markdown = new Markdown(
					content.text.trim(),
					timelineAnswer ? 0 : 1,
					0,
					this.markdownTheme,
					undefined,
					{
						baseUrl: this.baseUrl,
						transform:
							mermaidTransform && ((md, availableWidth) => mermaidTransform(md, availableWidth, isStreaming)),
					},
				);
				this.blockMarkdowns.set(i, markdown);
				this.lastBlockTexts.set(i, content.text.trim());
				if (timelineAnswer) {
					this.contentContainer.addChild(summaryStarted ? this.summaryGap() : this.summaryLead(message));
					summaryStarted = true;
					this.contentContainer.addChild(new TimelineAnswerBody(markdown, this.lane));
				} else {
					this.contentContainer.addChild(markdown);
				}
			} else if (content?.type === "thinking" && content.thinking.trim()) {
				// U6 noise cut: the collapsed view renders NO thinking rows at all -
				// the turn's aggregate line carries the segment count (`思考 N 段`).
				// The full Markdown trace only renders in the expanded detail view
				// (Ctrl+O). hideThinkingBlock hides it even there.
				// F2: same "actually renders" rule - a following thinking block
				// that stays collapsed must not earn this one a spacer either.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c?.type === "text" && c.text.trim() && !foldsText) ||
							(c?.type === "thinking" && rendersThinking(c)),
					);

				const thinkingLabel = theme.bold(theme.fg("thinkingText", this.hiddenThinkingLabel));
				if (this.hideThinkingBlock) {
					// Hidden: nothing at all, not even in the expanded view.
				} else if (!this.thinkingExpanded) {
					// Collapsed: no rows here - the turn's Thinking block header at the
					// turn head owns the summary and the Ctrl+T affordance.
				} else {
					// Expanded: the label line, then the trace. Thinking traces keep
					// Markdown structure but stay visually quiet.
					// Quiet turns indent their traces under the process line; the
					// answer text keeps column 1.
					const traceIndent = this.quiet ? 3 : 1;
					this.contentContainer.addChild(new Text(`${thinkingLabel}`, traceIndent, 0));
					const markdown = new Markdown(
						content.thinking.trim(),
						traceIndent,
						0,
						getThinkingMarkdownTheme(this.markdownTheme),
						{
							color: (text: string) => theme.fg("thinkingText", text),
						},
						{ baseUrl: this.baseUrl },
					);
					this.blockMarkdowns.set(i, markdown);
					this.lastBlockTexts.set(i, content.thinking.trim());
					this.contentContainer.addChild(markdown);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		if (timelineAnswer) {
			const lane = this.lane;
			this.contentContainer.addChild(
				new TimelineRows((width) => [timelineRow({ main: "rail", lane }, "", "", width)]),
			);
		}

		// The leading Spacer already separates the message from the turn head; the
		// error surfaces add one only when rendered text sits above them.
		const bodyAboveError = this.contentContainer.children.length > (leadingSpacer ? 1 : 0);
		if (message.stopReason === "aborted") {
			const reason = message.errorMessage;
			const plainInterrupt = !reason || isPlainInterrupt(reason);
			if (bodyAboveError) this.contentContainer.addChild(new Spacer(1));
			// A plain interrupt is the user's own action: say so calmly.
			this.contentContainer.addChild(
				plainInterrupt ? new Text(theme.fg("dim", "已中断"), 1, 0) : this.createErrorComponent(reason),
			);
		} else if (errorSurface) {
			const errorMsg = message.errorMessage || "Unknown error";
			if (bodyAboveError) this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(errorMsg, "Error"));
		}

		// A fully folded narration message renders no lines at all, so it must
		// not earn this trailing Spacer either (the leading-separation clause
		// only fires while the message still has a visible face; a message with
		// no text at all keeps the pre-v4 single blank line).
		if (
			hasToolCalls &&
			(hasVisibleContent ||
				message.stopReason === "aborted" ||
				(!this.quiet && !this.precededByToolActivity && !hasFoldedText))
		) {
			this.contentContainer.addChild(new Spacer(1));
		}
	}

	/** Two empty main-line rows, `HH:MM ◆ 总结` and an empty answer row: what opens the summary. */
	private summaryLead(message: AssistantMessage): Component {
		const lane = this.lane;
		const time = Number.isFinite(message.timestamp) ? formatTimelineTime(message.timestamp) : undefined;
		return new TimelineRows(
			(width) => [
				timelineRow({ main: "rail", lane }, "", "", width),
				timelineRow({ main: "rail", lane }, "", "", width),
				timelineRow({ time, main: "ai", lane }, theme.bold(theme.fg("timelineAi", "总结")), "", width),
				timelineRow({ main: "answer", lane }, "", "", width),
			],
			[""],
		);
	}

	/** An empty answer row between two text blocks of one summary. */
	private summaryGap(): Component {
		const lane = this.lane;
		return new TimelineRows((width) => [timelineRow({ main: "answer", lane }, "", "", width)]);
	}

	private createErrorComponent(message: string, prefix?: string): Component {
		const inlineLoginRecovery = formatInlineLoginRecoveryMessage(message);
		if (inlineLoginRecovery) {
			const text = prefix ? `${prefix}: ${inlineLoginRecovery}` : inlineLoginRecovery;
			return new Text(theme.fg("error", text), 1, 0);
		}

		if (!shouldCollapseErrorDetails(message)) {
			const text = prefix ? `${prefix}: ${message}` : message;
			return new Text(theme.fg("error", text), 1, 0);
		}

		const text = prefix ? `${prefix}: ${message}` : message;
		const summary = prefix ? `${prefix}: ${summarizeErrorDetails(message)}` : summarizeErrorDetails(message);
		return new CollapsibleErrorComponent({
			text,
			summary,
			expanded: this.expanded,
		});
	}
}
