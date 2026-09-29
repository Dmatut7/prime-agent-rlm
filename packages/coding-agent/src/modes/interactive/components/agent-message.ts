import {
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentSessionMessage } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `◆ <label> · <participant>[ · <preview>]` summary line shared by received and sent agent-message UI. */
export function agentMessageSummaryLine(label: string, participant: string, preview?: string): string {
	const parts = [`${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`, theme.fg("muted", participant)];
	if (preview) {
		parts.push(theme.fg("muted", preview));
	}
	return parts.join(theme.fg("dim", " · "));
}

/**
 * The row of a message received from another agent: `◇ <name> 交回：<preview>`
 * from a subagent the receiver started, `◇ <name> 发来：<preview>` from anyone
 * else (`◆` is prime's own mark). Without a preview the row is just the head.
 */
export function receivedAgentMessageLine(name: string, verb: "交回" | "发来", preview?: string): string {
	const head = `${theme.fg("kindSubagent", "◇")} ${theme.fg("kindSubagent", name)} ${theme.fg("muted", verb)}`;
	return preview ? `${head}${theme.fg("muted", `：${preview}`)}` : head;
}

/** Who sent a message, as its row names them; the same fallbacks the participant label uses. */
function senderName(from: AgentSessionMessage["details"]["from"]): string {
	return (
		from?.sessionName?.trim() ||
		from?.activeSessionId?.trim() ||
		from?.clientId?.trim() ||
		from?.sessionId?.trim() ||
		"unknown"
	);
}

/** Single-line message preview sized to fit after the summary-line prefix. */
export function agentMessagePreview(prefixWidth: number, message: string): string {
	return truncateToWidth(collapseText(message), Math.max(20, 100 - prefixWidth));
}

/** `╰─`-guttered message body lines shared by received and sent agent-message UI. */
export function agentMessageBodyLines(message: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const textWidth = Math.max(1, safeWidth - 4);
	const bodyLines = message.split("\n").flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, textWidth);
		return wrapped.length > 0 ? wrapped : [""];
	});
	return bodyLines.map((line, index) => {
		const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
		return truncateToWidth(` ${prefix}${theme.fg("customMessageText", line)}`, safeWidth, "");
	});
}

class AgentMessageBodyComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly message: string) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = agentMessageBodyLines(this.message, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Columns an agent-message row is inset inside a quiet turn, matching the turn's step rows. */
export const AGENT_MESSAGE_TURN_INSET = 2;

export class AgentMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private readonly suppressLeadingSpace: boolean;
	/** Columns the row sits in, so it lines up with the steps of the turn it belongs to. */
	private readonly inset: number;
	private insetSource?: string[];
	private insetLines?: string[];
	private expanded = false;

	constructor(
		private readonly message: AgentSessionMessage,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: { suppressLeadingSpace?: boolean; inset?: number } = {},
	) {
		super();
		this.suppressLeadingSpace = options.suppressLeadingSpace ?? false;
		this.inset = Math.max(0, options.inset ?? 0);
		if (!this.suppressLeadingSpace) this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	override render(width: number): string[] {
		const lines = this.withInset(super.render(Math.max(1, width - this.inset)));
		const leadingSpace = !this.suppressLeadingSpace;
		this.clickRegions =
			lines.length > 0
				? [
						{
							line: leadingSpace ? 1 : 0,
							col: 0,
							width,
							height: this.header.render(width).length,
							onClick: () => this.setExpanded(!this.expanded),
						},
					]
				: [];
		return lines;
	}
	private withInset(lines: string[]): string[] {
		if (this.inset === 0) return lines;
		if (this.insetSource !== lines || !this.insetLines) {
			const pad = " ".repeat(this.inset);
			this.insetSource = lines;
			this.insetLines = lines.map((line) => (line.trim().length > 0 ? pad + line : line));
		}
		return this.insetLines;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded) {
			this.content.addChild(new AgentMessageBodyComponent(this.message.details.message));
		}
	}

	private headerText(): string {
		const name = senderName(this.message.details.from);
		const verb = this.message.details.fromRelationship === "child" ? "交回" : "发来";
		// U6: no per-line expand hint — the global tail line owns the Ctrl+O
		// affordance (the header row stays clickable).
		if (this.expanded) {
			return receivedAgentMessageLine(name, verb);
		}

		const prefixWidth = visibleWidth(`◇ ${name} ${verb}：`);
		const preview = agentMessagePreview(prefixWidth, this.message.details.message);
		return receivedAgentMessageLine(name, verb, preview);
	}
}
