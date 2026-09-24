import {
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import {
	buildSubagentPanelRows,
	formatSubagentElapsed,
	ROW_STATE_WORDS,
	type SubagentPanelRow,
} from "./subagent-summary-line.js";

/** Card content column cap: wide enough for wrapped previews, narrow enough to stay a card. */
const CONTENT_MAX_WIDTH = 72;
/** Cap on wrapped 任务/最新/出错 blocks so a chatty child cannot push the card off screen. */
const MAX_BLOCK_LINES = 8;
/** Left indent of every card line. */
const CARD_INDENT = " ";
/** Label column: two CJK label chars plus a gap; content aligns after it. */
const LABEL_COLUMN_WIDTH = 6;

export interface SubagentDetailOverlayOptions {
	/** Live snapshot getter; `undefined` (child deleted or evicted) renders the removed state. */
	getChild: () => AgentConnectionRlmChildAgentSnapshot | undefined;
	onDismiss: () => void;
}

function childRow(child: AgentConnectionRlmChildAgentSnapshot): SubagentPanelRow | undefined {
	// The single-child projection reuses the panel's own classifier so the card's
	// 状态 word, elapsed time, and activity line cannot disagree with the tray row.
	const rows = buildSubagentPanelRows([child], child.parentId);
	return rows.length > 0 ? rows[0] : undefined;
}

/** Wrap one preview block, cap it, and keep the cap visible with a trailing ellipsis. */
function wrapBlock(text: string, contentWidth: number, maxLines: number): string[] {
	const lines = text
		.split("\n")
		.flatMap((part) => wrapTextWithAnsi(part.trim(), contentWidth))
		.filter((line) => line.trim().length > 0);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	kept[maxLines - 1] = truncateToWidth(`${kept[maxLines - 1]} …`, contentWidth, "…");
	return kept;
}

/**
 * The subagent detail card: click a row in the subagent panel
 * (SubagentSummaryLine.onRowActivate) and this overlay shows everything the
 * connection knows about that child - status, model, spend counters, the
 * progress recap, the latest answer preview or error, and the session
 * directory - without leaving the chat. Read-only; Esc closes.
 *
 * Data is read through the live getter on every render, so an in-flight child
 * updates the card as snapshots arrive.
 */
export class SubagentDetailOverlay implements Component, Focusable {
	focused = false;

	constructor(private readonly options: SubagentDetailOverlayOptions) {}

	invalidate(): void {
		// Render output is derived from the live getter.
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
			this.options.onDismiss();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, CONTENT_MAX_WIDTH));
		const child = this.options.getChild();
		if (!child) {
			return this.renderRemoved(safeWidth);
		}
		const row = childRow(child);
		const name = row?.name ?? child.label;
		const title = truncateToWidth(`${CARD_INDENT}子代理详情 · ${name}`, safeWidth, "…");
		const lines = [theme.fg("text", title), this.renderRule(safeWidth)];
		lines.push(
			...this.renderLabeledLine("状态", this.statusText(child, row), child.status === "error" ? "error" : "text"),
		);
		if (child.model) lines.push(...this.renderLabeledLine("模型", child.model, "text"));
		lines.push(...this.usageLine(child));
		if (child.recap?.trim()) lines.push(...this.renderLabeledBlock("任务", child.recap, "text"));
		if (child.answerPreview?.trim()) lines.push(...this.renderLabeledBlock("最新", child.answerPreview, "text"));
		if (child.error?.trim()) lines.push(...this.renderLabeledBlock("出错", child.error, "error"));
		lines.push(...this.renderLabeledLine("目录", child.sessionDir, "muted"));
		lines.push(this.renderRule(safeWidth));
		lines.push(...this.renderHint(safeWidth));
		return lines;
	}

	private renderRemoved(safeWidth: number): string[] {
		return [
			theme.fg("text", truncateToWidth(`${CARD_INDENT}子代理详情`, safeWidth, "…")),
			theme.fg("muted", `${CARD_INDENT}这个子代理已经不在列表里（可能已删除或收口）。`),
			...this.renderHint(safeWidth),
		];
	}

	private renderRule(safeWidth: number): string {
		return theme.fg("dim", `${CARD_INDENT}${"─".repeat(Math.max(2, safeWidth - 2))}`);
	}

	private statusText(child: AgentConnectionRlmChildAgentSnapshot, row: SubagentPanelRow | undefined): string {
		if (!row) return child.status;
		const stateWord = ROW_STATE_WORDS[row.state];
		const elapsed = row.elapsedMs !== undefined ? ` ${formatSubagentElapsed(row.elapsedMs)}` : "";
		const activity = row.activity ? ` · ${row.activity}` : "";
		return `${stateWord}${elapsed}${activity}`;
	}

	private usageLine(child: AgentConnectionRlmChildAgentSnapshot): string[] {
		const parts: string[] = [];
		if (child.toolUseCount !== undefined) parts.push(`${child.toolUseCount} 步`);
		if (child.tokenCount !== undefined) parts.push(`${formatTokenCount(child.tokenCount)} tok`);
		if (child.repliedSinceTask === true) parts.push("已回复");
		if (parts.length === 0) return [];
		return this.renderLabeledLine("用量", parts.join(" · "), "text");
	}

	private renderLabeledLine(label: string, content: string, color: "text" | "muted" | "error"): string[] {
		return [theme.fg(color, `${CARD_INDENT}${this.labelColumn(label)}${this.truncateContent(content)}`)];
	}

	private renderLabeledBlock(label: string, content: string, color: "text" | "muted" | "error"): string[] {
		const indent = `${CARD_INDENT}${this.labelColumn(label)}`;
		const contentWidth = this.contentWidth();
		const lines = wrapBlock(content, contentWidth, MAX_BLOCK_LINES);
		return lines.map((line, index) =>
			theme.fg(color, index === 0 ? `${indent}${line}` : `${" ".repeat(visibleWidth(indent))}${line}`),
		);
	}

	private labelColumn(label: string): string {
		return `${label}${" ".repeat(Math.max(0, LABEL_COLUMN_WIDTH - visibleWidth(label)))}`;
	}

	private truncateContent(content: string): string {
		return truncateToWidth(content, this.contentWidth(), "…");
	}

	private contentWidth(): number {
		return Math.max(4, CONTENT_MAX_WIDTH - visibleWidth(CARD_INDENT) - LABEL_COLUMN_WIDTH);
	}

	private renderHint(safeWidth: number): string[] {
		const escapeKey = keyText("tui.select.cancel", { primaryOnly: true });
		return [theme.fg("dim", truncateToWidth(`${CARD_INDENT}${escapeKey || "Esc"} 关闭`, safeWidth, ""))];
	}
}
