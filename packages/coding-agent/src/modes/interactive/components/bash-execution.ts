import { Clickable, Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { BASH_UPDATE_THROTTLE_MS } from "../../../core/tools/bash.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyText } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

const PREVIEW_LINES = 20;
/** Completed collapsed blocks still show their body up to this many lines. */
const COMPLETED_BODY_MAX_LINES = 3;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private errorMessage: string | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	private lastUpdateAt = 0;
	private updateTimer: NodeJS.Timeout | undefined;
	private updateDirty = false;

	constructor(command: string, ui: TUI, excludeFromContext = false, options: { suppressLeadingSpace?: boolean } = {}) {
		super();
		this.command = command;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// Keep tool activity tight against a preceding agent-message notification.
		if (!options.suppressLeadingSpace) this.addChild(new Spacer(1));

		this.addChild(new DynamicBorder(borderColor));

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.contentContainer.addChild(
			new Clickable(new Text(theme.fg(colorKey, `$ ${command}`), 1, 0), () => this.setExpanded(!this.expanded)),
		);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);
		this.contentContainer.addChild(this.loader);

		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refreshNow();
	}

	override invalidate(): void {
		super.invalidate();
		this.refreshNow();
	}

	appendOutput(chunk: string): void {
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.scheduleUpdateDisplay();
	}

	/**
	 * Display refreshes throttled to the bash tool's streaming cadence: chunks
	 * accumulate immediately, the first one renders at once and later ones are
	 * coalesced into a trailing timer flush.
	 */
	private scheduleUpdateDisplay(): void {
		this.updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - this.lastUpdateAt);
		if (delay <= 0) {
			this.refreshNow();
			return;
		}
		if (!this.updateTimer) {
			this.updateTimer = setTimeout(() => {
				this.updateTimer = undefined;
				if (this.updateDirty) {
					this.refreshNow();
				}
			}, delay);
			this.updateTimer.unref?.();
		}
	}

	private refreshNow(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
			this.updateTimer = undefined;
		}
		this.updateDirty = false;
		this.lastUpdateAt = Date.now();
		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		this.loader.stop();

		this.refreshNow();
	}

	/** Mark the execution as failed before producing a result (e.g. spawn failure). */
	setFailed(message: string): void {
		this.errorMessage = message;
		this.status = "error";
		this.loader.stop();
		this.refreshNow();
	}

	private updateDisplay(): void {
		// A running collapsed preview only needs the visible output tail: joining
		// the full output and re-running the context truncation per streamed chunk
		// is quadratic over the stream. The exact truncated content (hidden-line
		// counts, truncation warnings, expanded view) is still derived on
		// completion or when expanded.
		const streamingPreview = this.status === "running" && !this.expanded;

		// Apply truncation for LLM context limits (same limits as bash tool)
		const contextTruncation = streamingPreview
			? undefined
			: truncateTail(this.outputLines.join("\n"), {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

		// Recompute wrapping from the render width so resizes and split panes cannot use stale columns.
		const availableLines = contextTruncation?.content ? contextTruncation.content.split("\n") : [];

		const previewLogicalLines = streamingPreview ? this.previewTailLines() : availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = streamingPreview ? 0 : availableLines.length - previewLogicalLines.length;

		this.contentContainer.clear();

		this.contentContainer.addChild(
			new Clickable(new Text(theme.fg("bashMode", `$ ${this.command}`), 1, 0), () =>
				this.setExpanded(!this.expanded),
			),
		);

		if (streamingPreview) {
			if (previewLogicalLines.length > 0) {
				this.addPreviewChild(previewLogicalLines);
			}
		} else if (availableLines.length > 0) {
			if (this.expanded) {
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else if (availableLines.length <= COMPLETED_BODY_MAX_LINES) {
				// Short output stays visible: for a 1-3 line result the tally line
				// would save nothing and hide the answer the command was run for.
				this.addPreviewChild(availableLines);
			}
			// U4 noise cut: a longer completed collapsed block shows only the
			// command line and a one-line output tally; the output body lives in
			// the expanded view. The running preview keeps its live tail above.
		}

		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			if (hiddenLineCount > 0 && !this.expanded) {
				// U6: no per-line expand hint — the global tail line states the keys.
				statusParts.push(theme.fg("muted", `… ${availableLines.length} 行输出`));
			} else if (availableLines.length > COMPLETED_BODY_MAX_LINES && !this.expanded) {
				statusParts.push(theme.fg("muted", `… ${availableLines.length} 行输出`));
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(
					theme.fg(
						"error",
						this.errorMessage !== undefined ? `(failed: ${this.errorMessage})` : `(exit ${this.exitCode})`,
					),
				);
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation?.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	// Shared visual truncation utility with width-aware caching.
	private addPreviewChild(previewLogicalLines: string[]): void {
		const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
		const styledInput = `\n${styledOutput}`;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		this.contentContainer.addChild({
			render: (width: number) => {
				if (cachedLines === undefined || cachedWidth !== width) {
					const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
					cachedLines = result.visualLines;
					cachedWidth = width;
				}
				return cachedLines ?? [];
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		});
	}

	/**
	 * Visible preview tail while running collapsed. Matches the last
	 * PREVIEW_LINES lines of the context-truncated full output; the full-output
	 * path is only needed when the tail window itself exceeds the byte budget
	 * (oversized output lines).
	 */
	private previewTailLines(): string[] {
		const tail = this.outputLines.slice(-PREVIEW_LINES);
		const joined = tail.join("\n");
		if (joined === "") {
			return [];
		}
		if (Buffer.byteLength(joined, "utf-8") <= DEFAULT_MAX_BYTES) {
			return tail;
		}
		return truncateTail(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content.split("\n");
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
