import {
	type Component,
	getCapabilities,
	truncateToWidth,
	VersionedRenderCache,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { parseIpythonBashCell } from "../../../core/tools/ipython-cell-code.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, WORKING_ICON_FRAMES, workingIconFrame } from "../theme/working-icon.js";
import { agentMessageBodyLines, agentMessagePreview, agentMessageSummaryLine } from "./agent-message.js";
import { normalizeErrorDetails, summarizeErrorDetails } from "./collapsible-error.js";
import { renderDiffSeparator, renderRichDiff } from "./diff.js";
import { countChangedLines, FILE_CHANGE_DIFF_INDENT, formatFileChangeSummaryLine } from "./edit-summary.js";
import { keyText } from "./keybinding-hints.js";
import { isFallbackPythonLabel, turnStepLabel } from "./step-label.js";
import { QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES, quietConversationBudget, toolOutputFull } from "./tool-output-budget.js";

export interface IPythonCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface IPythonCellState {
	code: string;
	content?: readonly IPythonCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	agentMessagesExpanded?: boolean;
	editDiffsExpanded?: boolean;
	showExpandHint?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	showImages?: boolean;
	/** Session cwd — edit paths nested under it render relative, else absolute. */
	cwd?: string;
}

interface DiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

interface SentAgentMessageDisplay {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

interface IpythonDetails {
	durationMs?: number;
	status?: string;
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	backgroundOutput?: string;
	diffs?: DiffDisplay[];
	sentAgentMessages?: SentAgentMessageDisplay[];
	error?: IpythonErrorDetails;
}

interface IpythonErrorDetails {
	ename: string;
	evalue: string;
	traceback: readonly string[];
}

interface TracebackParts {
	output: string;
	traceback: string;
	preview: string;
}

const MAGIC_LINE_PATTERN = /^\s*!/;

/** The marker the host appends to model-facing text before unattributed background output. */
const BACKGROUND_OUTPUT_MARKER = "[background output (unattributed)]";

// Two columns, matching the code body's "│ " gutter so output aligns under it.
const OUTPUT_INDENT = "  ";

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append `ESC[0m` when `line` ends with a foreground or background color still
 * open, so a span that wrapTextWithAnsi split across lines cannot bleed into the
 * trailing padding or the next line.
 */
function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the color data of `38;5;n` / `38;2;r;g;b` so a component (e.g. 38) isn't read as a code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function getIpythonCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) {
		return "";
	}
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

function readDetails(details: unknown): IpythonDetails {
	if (!details || typeof details !== "object") {
		return {};
	}
	const record = details as Record<string, unknown>;
	const error = readErrorDetails(record.error);
	return {
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		errorEname: error?.ename ?? (typeof record.errorEname === "string" ? record.errorEname : undefined),
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
		result: typeof record.result === "string" ? record.result : undefined,
		backgroundOutput: typeof record.backgroundOutput === "string" ? record.backgroundOutput : undefined,
		diffs: readDiffDisplays(record.diffs),
		sentAgentMessages: readSentAgentMessages(record.sentAgentMessages),
		error,
	};
}

function readSentAgentMessages(value: unknown): SentAgentMessageDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const messages = value.flatMap((entry): SentAgentMessageDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		const target = record.target;
		if (!target || typeof target !== "object") {
			return [];
		}
		const targetRecord = target as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			typeof record.message !== "string" ||
			(record.deliveryStatus !== "delivered" && record.deliveryStatus !== "queued") ||
			typeof targetRecord.activeSessionId !== "string" ||
			typeof targetRecord.sessionId !== "string"
		) {
			return [];
		}
		return [
			{
				id: record.id,
				message: record.message,
				deliveryStatus: record.deliveryStatus,
				...(record.receiverRole === "parent" || record.receiverRole === "sibling" || record.receiverRole === "child"
					? { receiverRole: record.receiverRole }
					: {}),
				target: {
					activeSessionId: targetRecord.activeSessionId,
					sessionId: targetRecord.sessionId,
					...(typeof targetRecord.sessionName === "string" ? { sessionName: targetRecord.sessionName } : {}),
				},
			},
		];
	});
	return messages.length > 0 ? messages : undefined;
}

function readDiffDisplays(value: unknown): DiffDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const diffs = value.flatMap((entry): DiffDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.oldStr !== "string" || typeof record.newStr !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				oldStr: record.oldStr,
				newStr: record.newStr,
				startLine: typeof record.startLine === "number" ? record.startLine : undefined,
			},
		];
	});
	return diffs.length > 0 ? diffs : undefined;
}

/** Strip one layer of repr quotes so an `execute_result` string compares cleanly. */
function stripReprQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** True when `text` is just the edit skill's "Edited <path>" confirmation for one of `diffs`. */
function isEditConfirmation(text: string | undefined, diffs: readonly DiffDisplay[]): boolean {
	if (!text) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return diffs.some((diff) => stripped === `Edited ${diff.path}`);
}

/**
 * True when `text` is the `agent_message.send` receipt dict for one of the sent
 * messages already summarized above the output, so the raw receipt isn't shown.
 * Matches only a single-receipt repr — the receipt dict always starts with its
 * `id` key — so broadcast `{'receipts': [...]}` results (which can carry error
 * entries with no summary line) and results that merely mention an ID still render.
 */
function isAgentMessageReceipt(text: string | undefined, messages: readonly SentAgentMessageDisplay[]): boolean {
	if (!text || messages.length === 0) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return messages.some(
		(message) => stripped.startsWith(`{'id': '${message.id}'`) || stripped.startsWith(`{"id": "${message.id}"`),
	);
}

function readErrorDetails(value: unknown): IpythonErrorDetails | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.ename !== "string") {
		return undefined;
	}
	return {
		ename: record.ename,
		evalue: typeof record.evalue === "string" ? record.evalue : "",
		traceback: Array.isArray(record.traceback)
			? record.traceback.filter((line): line is string => typeof line === "string")
			: [],
	};
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) {
		return undefined;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function isImageBlock(block: IPythonCellContentBlock): boolean {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function textFromBlocks(blocks: readonly IPythonCellContentBlock[] | undefined): string {
	if (!blocks) {
		return "";
	}
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function splitTraceback(text: string, errorName: string | undefined): TracebackParts | undefined {
	const normalized = normalizeErrorDetails(text);
	if (!normalized.trim()) {
		return undefined;
	}

	const lines = normalized.split("\n");
	let tracebackIndex = lines.findIndex((line) => line.includes("Traceback (most recent call last):"));
	if (tracebackIndex < 0 && errorName) {
		tracebackIndex = lines.findIndex((line) => line.trim().startsWith(`${errorName}:`));
	}
	if (tracebackIndex < 0) {
		return undefined;
	}

	const output = lines.slice(0, tracebackIndex).join("\n").trimEnd();
	const traceback = lines.slice(tracebackIndex).join("\n").trim();
	const preview = summarizeErrorDetails(traceback);
	return { output, traceback, preview: preview === "Error" && errorName ? errorName : preview };
}

/** The user (or the host) stopped the cell: a calm `已中断`, not an error. */
function isInterruptedCell(details: IpythonDetails, text: string): boolean {
	const ename = details.error?.ename ?? details.errorEname;
	return (
		details.status === "aborted" ||
		ename === "KeyboardInterrupt" ||
		(details.error === undefined && /^KeyboardInterrupt\b/m.test(normalizeErrorDetails(text)))
	);
}

function formatIpythonErrorSummary(error: IpythonErrorDetails): string {
	const normalizedValue = normalizeErrorDetails(error.evalue);
	if (!normalizedValue.trim()) {
		return error.ename;
	}
	const value = summarizeErrorDetails(normalizedValue);
	if (value === "Error") {
		return error.ename;
	}
	return visibleWidth(value) <= 48 ? `${error.ename}: ${value}` : error.ename;
}

export class IPythonCellComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: IPythonCellState;
	private stateVersion = 0;

	constructor(state: IPythonCellState) {
		this.state = state;
	}

	update(state: IPythonCellState): void {
		this.state = state;
		this.stateVersion += 1;
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = readDetails(this.state.details);
		// Fold the animation frame into the cache key while running (offset within
		// a stateVersion slot so it never collides with another version).
		const frames = WORKING_ICON_FRAMES.length;
		const baseVersion =
			this.statusKind(details) === "running"
				? this.stateVersion * frames + (getWorkingPulseFrame() % frames)
				: this.stateVersion * frames;
		// The output budget modes change what an expanded cell shows, so they
		// are part of the cache key: toggling full output repaints at once.
		const cacheVersion = baseVersion * 4 + (toolOutputFull() ? 2 : 0) + (quietConversationBudget() ? 1 : 0);
		const cached = this.renderCache.get(safeWidth, cacheVersion);
		if (cached) {
			return cached;
		}

		// The top line is identical whether collapsed or expanded — same marker,
		// counts, duration, and expand hint — so toggling never shifts the layout
		// or indentation; expanding only attaches code and output below it.
		// Cached by state version so unrelated repaints don't re-render (flicker).
		const lines = [this.topLine(details, safeWidth)];

		// An expanded step shows what it produced; its code joins only in the full
		// view, or when the label could not say what the cell does.
		const showCode = this.state.expanded && (toolOutputFull() || isFallbackPythonLabel(this.state.code));
		const hasCode = showCode ? this.renderCode(lines, safeWidth) : false;
		if ((details.diffs?.length ?? 0) > 0) {
			this.renderDiffs(lines, safeWidth, details.diffs ?? [], hasCode);
		}
		if ((details.sentAgentMessages?.length ?? 0) > 0) {
			this.renderSentAgentMessages(lines, safeWidth, details.sentAgentMessages ?? []);
		}

		if (!this.state.expanded) {
			return this.renderCache.set(safeWidth, cacheVersion, lines);
		}

		this.renderOutput(lines, safeWidth, details, hasCode);
		return this.renderCache.set(safeWidth, cacheVersion, lines);
	}

	/**
	 * The cell's fixed top line, in plain words: `✓ 运行 npm check · 12 行输出 · 1.2s`.
	 * A cell without a recognizable effect shows its most telling code line.
	 */
	/**
	 * The cell's fixed top line, in plain words, with its facts right-aligned:
	 * `✓ 运行 npm check                      12 行输出 · 1.2s`. The label never
	 * carries raw source; the code is in the expanded view.
	 */
	private topLine(details: IpythonDetails, width: number): string {
		const code = this.state.code.trimEnd();
		const label = this.stepLabel();
		let left = ` ${this.marker(details)} ${theme.fg("text", label)}`;
		if (!code && !this.state.executionStarted) {
			left += ` ${theme.fg("muted", "等待代码")}`;
		}

		const facts: string[] = [];
		const outputLines = this.outputLineCount(details);
		if (outputLines > 0) {
			facts.push(theme.fg("muted", `${outputLines} 行输出`));
		}
		const duration = formatDuration(details.durationMs);
		if (duration) {
			facts.push(theme.fg("muted", duration));
		}
		const errorName = !this.state.isPartial ? (details.error?.ename ?? details.errorEname) : undefined;
		if (!this.state.isPartial && isInterruptedCell(details, textFromBlocks(this.state.content))) {
			facts.push(theme.fg("dim", "已中断"));
		} else if (errorName) {
			facts.push(theme.fg("error", errorName));
		}
		const right = facts.length > 0 ? `${facts.join(theme.fg("dim", " · "))} ` : "";
		const rightWidth = visibleWidth(right);
		if (!right) {
			return truncateToWidth(left, width, "");
		}
		if (visibleWidth(left) + 2 + rightWidth > width) {
			// The facts are figures: they stay whole and right-aligned; the label gives way.
			const leftBudget = width - rightWidth - 2;
			if (leftBudget < 6) {
				return truncateToWidth(left, width, "…");
			}
			const clipped = truncateToWidth(left, leftBudget, "…");
			return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped) - rightWidth))}${right}`;
		}
		return `${left}${" ".repeat(width - visibleWidth(left) - rightWidth)}${right}`;
	}

	private stepLabel(): string {
		const code = this.state.code.trimEnd();
		return code ? turnStepLabel({ toolName: "ipython", args: { code } }) : "python";
	}

	/** Status marker — color carries running/done/error; ✓/✗ once finished. */
	private marker(details: IpythonDetails): string {
		if (!this.state.isPartial && isInterruptedCell(details, textFromBlocks(this.state.content))) {
			return theme.fg("dim", "✗");
		}
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", workingIconFrame(getWorkingPulseFrame()));
			default: // queued
				return theme.fg("muted", "◇");
		}
	}

	// Output is omitted for edits (the diff shows on expand).
	private outputLineCount(details: IpythonDetails): number {
		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		const sentMessages = details.sentAgentMessages ?? [];
		const result = isAgentMessageReceipt(details.result, sentMessages) ? undefined : details.result;
		const structured = [details.stdout, details.stderr, result, details.backgroundOutput]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		const blocksText = textFromBlocks(this.state.content);
		let fallback = isAgentMessageReceipt(blocksText, sentMessages) ? "" : blocksText;
		// A traceback in the fallback text is not output: count what ran before it.
		const traceback = structured ? undefined : splitTraceback(fallback, details.errorEname);
		if (traceback) fallback = traceback.output;
		else if (!structured && this.isQuietInterrupt(details, blocksText)) fallback = "";
		const outputText = (structured || fallback).trim();
		return hasDiffs || !outputText ? 0 : outputText.split("\n").length;
	}

	/** An interrupt in the normal (not full) view: its kernel text is plumbing, not output. */
	private isQuietInterrupt(details: IpythonDetails, text: string): boolean {
		return !this.state.isPartial && !toolOutputFull() && isInterruptedCell(details, text);
	}

	private statusKind(details: IpythonDetails): "error" | "aborted" | "running" | "queued" | "done" {
		const status = details.status;
		if (this.state.isError || status === "error") {
			return "error";
		}
		if (status === "aborted") {
			return "aborted";
		}
		// Keyed off the result, not executionStarted, so calls rehydrated from a
		// past session (which never saw the live start) render done, not running.
		if (!this.state.isPartial && (status !== undefined || this.state.executionStarted || this.hasResult(details))) {
			return "done";
		}
		if (this.state.isPartial || this.state.executionStarted) {
			return "running";
		}
		return "queued";
	}

	private hasResult(details: IpythonDetails): boolean {
		return (
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined ||
			(details.diffs?.length ?? 0) > 0 ||
			(details.sentAgentMessages?.length ?? 0) > 0 ||
			(this.state.content?.length ?? 0) > 0
		);
	}

	// Only runs when expanded — shows the full source below the fixed top line.
	private renderCode(lines: string[], width: number): boolean {
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addBlank(lines, width);
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "等待代码"), width);
			return false;
		}

		this.addBlank(lines, width);
		const isBashCell = parseIpythonBashCell(code) !== undefined;
		const rawLines = code.split("\n");
		// Highlight the whole cell at once so multi-line strings keep their color.
		const highlightedLines = isBashCell ? [] : highlightCode(code, "python");
		for (const [index, rawLine] of rawLines.entries()) {
			// A plain gutter: `›` is the user's turn marker.
			const prefix = theme.fg("dim", "│ ");
			const highlighted =
				isBashCell || MAGIC_LINE_PATTERN.test(rawLine) || parseIpythonBashCell(rawLine) !== undefined
					? theme.fg("bashMode", rawLine)
					: (highlightedLines[index] ?? theme.fg("mdCodeBlock", rawLine));
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}

		return true;
	}

	// Only runs when expanded — shows full output below the code, no previews.
	private renderOutput(lines: string[], width: number, details: IpythonDetails, hasCode: boolean): void {
		const blocks = this.state.content ?? [];
		const text = textFromBlocks(blocks);
		const imageCount = blocks.filter(isImageBlock).length;
		const hasStructuredOutput =
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined;
		const traceback =
			!hasStructuredOutput && (this.state.isError || details.status === "error")
				? splitTraceback(text, details.errorEname)
				: undefined;
		let outputStarted = false;
		let renderedTextOutput = false;

		const diffs = details.diffs ?? [];
		const sentMessages = details.sentAgentMessages ?? [];

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (hasStructuredOutput) {
			if (details.stdout?.trim() && !isEditConfirmation(details.stdout, diffs)) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out");
			}
			if (details.stderr?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err");
			}
			if (
				details.result?.trim() &&
				!isEditConfirmation(details.result, diffs) &&
				!isAgentMessageReceipt(details.result, sentMessages)
			) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.result), "out");
			}
		} else if (traceback) {
			if (traceback.output) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, traceback.output, "out");
			}
		} else if (text.trim() && !isAgentMessageReceipt(text, sentMessages) && !this.isQuietInterrupt(details, text)) {
			startOutput();
			renderedTextOutput = true;
			// The model-facing background marker reads in the UI's language here.
			const shown = normalizeErrorDetails(text).replaceAll(BACKGROUND_OUTPUT_MARKER, "[后台输出（来源未知）]");
			this.renderOutputText(lines, width, shown, this.state.isError ? "err" : "out");
		}

		// Without structured fields the fallback content text above already contains the appended background block.
		const backgroundOutput =
			hasStructuredOutput && details.backgroundOutput?.trim() ? details.backgroundOutput : undefined;
		if (backgroundOutput) {
			// Suppresses the placeholders below when background output is the cell's only output; rendered after the traceback to match the model-facing order.
			renderedTextOutput = true;
		}

		if (!renderedTextOutput && this.state.isPartial) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "等待输出…"), width);
		} else if (!renderedTextOutput && this.state.executionStarted && !this.state.argsComplete) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "等待输出…"), width);
		} else if (
			!renderedTextOutput &&
			!traceback &&
			!details.error &&
			!isInterruptedCell(details, text) &&
			diffs.length === 0 &&
			(details.sentAgentMessages?.length ?? 0) === 0 &&
			this.state.executionStarted &&
			imageCount === 0
		) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "没有输出"), width);
		}

		if (isInterruptedCell(details, text) && !toolOutputFull()) {
			// An interrupt's traceback is the kernel's plumbing, not the step's
			// result; the step row already says 已中断 and the full view keeps it.
		} else if (details.error) {
			startOutput();
			this.renderTraceback(
				lines,
				width,
				details.error.traceback.join("\n") || formatIpythonErrorSummary(details.error),
			);
		} else if (traceback) {
			startOutput();
			this.renderTraceback(lines, width, traceback.traceback);
		}

		if (backgroundOutput) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "后台输出（来源未知）"), width);
			this.renderOutputText(lines, width, normalizeErrorDetails(backgroundOutput), "err");
		}

		if (imageCount > 0) {
			startOutput();
			const canRenderImages = this.state.showImages && !!getCapabilities().images;
			const text = canRenderImages ? `${imageCount} 张图片，见下方` : `${imageCount} 张图片（这个终端无法显示）`;
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", text), width);
		}
	}

	// Summary line per message; expanding shows the message text in a `╰─` gutter
	// instead of the collapsed preview, matching received agent-message UI.
	private renderSentAgentMessages(lines: string[], width: number, messages: readonly SentAgentMessageDisplay[]): void {
		for (const message of messages) {
			// Queued only means something while the cell runs; a settled cell's message went out.
			const label = message.deliveryStatus === "queued" && this.state.isPartial ? "消息排队中" : "已发消息";
			const recipient = formatAgentMessageParticipant("sent", message.receiverRole, message.target);
			// U6: no per-line expand hint — the global tail line states the keys.
			if (this.state.agentMessagesExpanded) {
				this.addBlank(lines, width);
				this.addPlain(
					lines,
					truncateToWidth(agentMessageSummaryLine(label, recipient), Math.max(1, width - 1), "…"),
				);
				for (const bodyLine of agentMessageBodyLines(message.message, width)) {
					lines.push(bodyLine);
				}
				continue;
			}
			const prefixWidth = visibleWidth(`◆ ${label} · ${recipient} · `);
			const preview = agentMessagePreview(prefixWidth, message.message);
			this.addPlain(
				lines,
				truncateToWidth(agentMessageSummaryLine(label, recipient, preview), Math.max(1, width - 1), "…"),
			);
		}
	}

	// The `╰─ <path> +N -M` summary line renders in both states; ctrl+j only
	// attaches or removes the indented diff rows underneath it.
	private renderDiffs(lines: string[], width: number, diffs: readonly DiffDisplay[], hasCode: boolean): void {
		const diffsByPath = new Map<string, DiffDisplay[]>();
		for (const diff of diffs) {
			const existing = diffsByPath.get(diff.path);
			if (existing) existing.push(diff);
			else diffsByPath.set(diff.path, [diff]);
		}
		if (hasCode) {
			this.addPlain(lines, "");
		}
		let index = 0;
		for (const [path, edits] of diffsByPath) {
			index += 1;
			this.renderFileDiff(lines, width, path, edits, index === diffsByPath.size);
		}
	}

	private renderFileDiff(
		lines: string[],
		width: number,
		path: string,
		edits: readonly DiffDisplay[],
		showHint: boolean,
	): void {
		const language = getLanguageFromPath(path);
		// Diff rows align with the summary line's text column (after the `╰─ ` gutter).
		const indent = FILE_CHANGE_DIFF_INDENT.slice(0, Math.max(0, width - 1));
		const contentWidth = Math.max(1, width - indent.length);
		let added = 0;
		let removed = 0;
		const rows: string[] = [];
		edits.forEach((edit, index) => {
			const { diff: diffText } = generateDiffString(edit.oldStr, edit.newStr, 4, edit.startLine ?? 1);
			const counts = countChangedLines(diffText);
			added += counts.added;
			removed += counts.removed;
			if (!this.state.editDiffsExpanded) {
				return;
			}
			if (index > 0) {
				rows.push(`${indent}${renderDiffSeparator(contentWidth)}`);
			}
			// Append, not spread: a huge edit's diff can exceed the JS arg-count limit.
			for (const row of renderRichDiff(diffText, contentWidth, { language })) {
				rows.push(`${indent}${row}`);
			}
		});

		// U6: no per-row expand hint - the global tail line owns the keys.
		void showHint;
		lines.push(formatFileChangeSummaryLine(path, this.state.cwd, { added, removed }, width));

		for (const row of rows) {
			lines.push(row);
		}
	}

	private renderOutputText(lines: string[], width: number, text: string, label: "out" | "err"): void {
		const color = label === "err" ? "muted" : "toolOutput";
		const all = text.split("\n");
		// TUI v4 T7: quiet 模式 pins a per-step window (same dozen-line budget as
		// the bash blocks); alt+shift+O lifts it. Without this the ipython lane
		// floods the quiet face with full output.
		let shown = all;
		let heldBack = 0;
		if (quietConversationBudget() && !toolOutputFull() && all.length > QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES) {
			shown = all.slice(0, QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES);
			heldBack = all.length - QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES;
		}
		// The quiet window shows each output line on one row; the full view wraps.
		const clip = quietConversationBudget() && !toolOutputFull();
		for (const line of shown) {
			if (clip) {
				lines.push(truncateToWidth(` ${OUTPUT_INDENT}${theme.fg(color, line || " ")}`, width, "…"));
			} else {
				this.addWrapped(lines, OUTPUT_INDENT, theme.fg(color, line || " "), width);
			}
		}
		if (heldBack > 0) {
			this.addWrapped(
				lines,
				OUTPUT_INDENT,
				theme.fg("dim", `… 还有 ${heldBack} 行  ${keyText("app.tools.expandFull") || "Alt+Shift+O"} 看全文`),
				width,
			);
		}
	}

	private renderTraceback(lines: string[], width: number, traceback: string): void {
		for (const line of traceback.split("\n")) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", line || " "), width);
		}
	}

	// Backgroundless line, indented one space to align under the fixed top line.
	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			// Truncate the composed line so a narrow pane can't exceed width (fatal in the renderer).
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addBlank(lines: string[], _width: number): void {
		lines.push("");
	}

	// No-background line, indented one space to align with the summary line above.
	private addPlain(lines: string[], text: string): void {
		lines.push(` ${text}`);
	}
}
