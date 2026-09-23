import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { LOGIN_RECOVERY_MESSAGE } from "../../../core/auth-guidance.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import {
	CollapsibleErrorComponent,
	normalizeErrorDetails,
	shouldCollapseErrorDetails,
	summarizeErrorDetails,
} from "./collapsible-error.js";
import type { MermaidMarkdownTransform } from "./mermaid.js";

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
export class AssistantMessageComponent extends Container {
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
		// TUI v4 quiet gate, block-level (batch1 review P1-1): only the text
		// BEFORE the first tool call is the "先说再做" preamble narration that
		// folds into the turn stats. Text AFTER a tool call - the same
		// message's closing narrative / conclusion - stays visible, exactly
		// like the turn's final no-tool output. Error surfaces never fold.
		const firstToolCallIndex = message.content.findIndex((c) => c?.type === "toolCall");
		const foldsText = (index: number): boolean =>
			this.quiet && firstToolCallIndex !== -1 && index < firstToolCallIndex;
		const hasFoldedText = message.content.some(
			(c, index) => c?.type === "text" && c.text.trim().length > 0 && foldsText(index),
		);
		const rendersThinking = (c: AssistantMessage["content"][number]) =>
			c?.type === "thinking" && c.thinking.trim() && !this.hideThinkingBlock && this.thinkingExpanded;
		const hasVisibleContent =
			message.content.some(
				(c, index) =>
					(c?.type === "text" && c.text.trim() && !foldsText(index)) ||
					(c?.type === "thinking" && rendersThinking(c)),
			) ||
			// The error surfaces render in both lanes (aborted, or a
			// non-tool-call error); toolCall blocks render as separate
			// components, not here.
			message.stopReason === "aborted" ||
			(message.stopReason === "error" && !hasToolCalls);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content?.type === "text" && content.text.trim() && !foldsText(i)) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const mermaidTransform = this.mermaidTransform;
				const isStreaming = this.isStreaming;
				const markdown = new Markdown(content.text.trim(), 1, 0, this.markdownTheme, undefined, {
					baseUrl: this.baseUrl,
					transform:
						mermaidTransform && ((md, availableWidth) => mermaidTransform(md, availableWidth, isStreaming)),
				});
				this.blockMarkdowns.set(i, markdown);
				this.lastBlockTexts.set(i, content.text.trim());
				this.contentContainer.addChild(markdown);
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
						(c, index) =>
							(c?.type === "text" && c.text.trim() && !foldsText(i + 1 + index)) ||
							(c?.type === "thinking" && rendersThinking(c)),
					);

				const thinkingLabel = theme.bold(theme.fg("thinkingText", this.hiddenThinkingLabel));
				if (this.hideThinkingBlock) {
					// Hidden: nothing at all, not even in the expanded view.
				} else if (!this.thinkingExpanded) {
					// Collapsed: no rows here - the turn's 思考 block header at the
					// turn head owns the summary and the Ctrl+T affordance.
				} else {
					// Expanded: the label line, then the trace. Thinking traces keep
					// Markdown structure but stay visually quiet.
					this.contentContainer.addChild(new Text(`${thinkingLabel}`, 1, 0));
					const markdown = new Markdown(
						content.thinking.trim(),
						1,
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

		if (message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(abortMessage));
		} else if (!hasToolCalls && message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			this.contentContainer.addChild(new Spacer(1));
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
