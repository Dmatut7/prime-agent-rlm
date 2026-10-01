/**
 * Width-aware word wrapping for the CLI's plain stdout/stderr print paths.
 *
 * The TUI renders through the pi-tui wrapper already; console.log/console.error
 * did not, so long help rows and startup errors hit the terminal's hard fold:
 * mid-word breaks, and flush-left continuations that read as a fresh command.
 * These helpers wrap by words with an optional hanging indent, and only when
 * the target stream reports a width — a pipe or redirect cannot say how wide
 * it is, so it keeps the legacy unwrapped text and scripts see no added breaks.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isStdoutTakenOver } from "../core/output-guard.js";

/** Never wrap below this budget, however narrow the terminal claims to be. */
const MIN_WRAP_BUDGET = 8;

/** An aligned summary column narrower than this wraps worse than stacking. */
const MIN_ALIGNED_SUMMARY_COLUMNS = 20;

export interface CliWrapOptions {
	/** Spaces prepended to continuation lines (hanging indent). */
	continuationIndent?: number;
	/** Columns kept free for a suffix the caller appends after wrapping (readline's " [y/N] "). */
	reserveColumns?: number;
}

/** Columns of a stream, or undefined when it cannot say (pipe, redirect, closed). */
export function getStreamWidth(stream: { columns?: number | undefined }): number | undefined {
	const columns = stream.columns;
	return typeof columns === "number" && Number.isInteger(columns) && columns > 0 ? columns : undefined;
}

/**
 * Width of the stream stdout text actually lands on. While stdout is taken over
 * (non-interactive modes reroute stdout to stderr), that stream is stderr.
 */
export function getStdoutWidth(): number | undefined {
	return getStreamWidth(isStdoutTakenOver() ? process.stderr : process.stdout);
}

/** Width of the stream stderr text lands on. */
export function getStderrWidth(): number | undefined {
	return getStreamWidth(process.stderr);
}

/**
 * Word-wrap every line of `text` to `width` visible columns. Returns `text`
 * unchanged when `width` is undefined. ANSI styling measures at zero width and
 * carries across the break; CJK graphemes measure as two columns.
 */
export function wrapCliText(text: string, width: number | undefined, options: CliWrapOptions = {}): string {
	if (width === undefined) {
		return text;
	}
	const indent = options.continuationIndent ?? 0;
	const budget = Math.max(MIN_WRAP_BUDGET, width - (options.reserveColumns ?? 0));
	// Wrapping at budget - indent keeps padded continuations inside the budget too.
	const wrapBudget = Math.max(MIN_WRAP_BUDGET, budget - indent);
	const padding = " ".repeat(indent);
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(line, wrapBudget);
		out.push(...wrapped.map((segment, index) => (index === 0 ? segment : padding + segment)));
	}
	return out.join("\n");
}

/** Wrap for the stream stdout text lands on; no-op when its width is unknown. */
export function wrapForStdout(text: string, options?: CliWrapOptions): string {
	return wrapCliText(text, getStdoutWidth(), options);
}

/** Wrap for the stream stderr text lands on; no-op when its width is unknown. */
export function wrapForStderr(text: string, options?: CliWrapOptions): string {
	return wrapCliText(text, getStderrWidth(), options);
}

/**
 * `  left  summary` rows with the summary word-wrapped under its own column.
 * Without a width the rows keep their flat legacy form. When the aligned
 * summary column would be narrower than MIN_ALIGNED_SUMMARY_COLUMNS, each row
 * stacks: the left side on its own line, the summary wrapped at a 4-space
 * indent below it.
 */
export function formatAlignedRows(rows: readonly (readonly [string, string])[], width: number | undefined): string[] {
	const leftWidth = Math.max(...rows.map(([left]) => left.length));
	if (width === undefined) {
		return rows.map(([left, summary]) => `  ${left.padEnd(leftWidth)}  ${summary}`);
	}
	const summaryColumn = 2 + leftWidth + 2;
	if (width - summaryColumn < MIN_ALIGNED_SUMMARY_COLUMNS) {
		return rows.flatMap(([left, summary]) => {
			if (!summary) {
				return [`  ${left}`];
			}
			return [
				`  ${left}`,
				...wrapTextWithAnsi(summary, Math.max(MIN_WRAP_BUDGET, width - 4)).map((segment) => `    ${segment}`),
			];
		});
	}
	return rows.flatMap(([left, summary]) => {
		if (!summary) {
			return [`  ${left}`];
		}
		const segments = wrapTextWithAnsi(summary, width - summaryColumn);
		return segments.map((segment, index) =>
			index === 0 ? `  ${left.padEnd(leftWidth)}  ${segment}` : `${" ".repeat(summaryColumn)}${segment}`,
		);
	});
}
