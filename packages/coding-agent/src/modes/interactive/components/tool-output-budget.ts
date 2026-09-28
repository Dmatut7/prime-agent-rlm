/**
 * Render budget for expanded tool output.
 *
 * Expanding tool output rebuilds every tool block in the transcript and re-wraps
 * whatever body it releases, so one keystroke cost O(total visible bytes): a window
 * holding many long outputs froze the UI for seconds on a single core. Expanded
 * blocks therefore render a bounded window - the first EXPANDED_TOOL_OUTPUT_MAX_LINES
 * logical lines and at most EXPANDED_TOOL_OUTPUT_MAX_CHARS characters of each body -
 * and say how much they hold back. Nothing is lost: `app.tools.expandFull` lifts the
 * budget for every block, so the full text stays one keystroke away, and the budget
 * only ever applies to the expanded view (the collapsed preview keeps its own tail
 * window).
 *
 * The mode is process-wide state read during render, the same shape as the working
 * pulse frame counter (../theme/working-icon.ts): blocks built before or after a
 * toggle all see the current mode without threading it through every construction
 * and replay path that sets expansion state.
 */

/** Logical lines an expanded block renders before it holds the rest back. */
export const EXPANDED_TOOL_OUTPUT_MAX_LINES = 40;
/** Characters an expanded block renders before it holds the rest back. */
export const EXPANDED_TOOL_OUTPUT_MAX_CHARS = 6000;
/**
 * TUI v4 T7 (R2.4): the quiet conversation pins the per-step window tighter -
 * at most six lines - so one expanded step cannot flood the quiet face.
 * `app.tools.expandFull` (alt+shift+O) still lifts the whole budget.
 */
export const QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES = 6;

let fullToolOutput = false;
let quietConversation = false;

/** Whether the quiet conversation's tighter per-step window is active. */
export function quietConversationBudget(): boolean {
	return quietConversation;
}

/**
 * Switch the quiet budget on or off. Returns true when the mode actually
 * changed, so callers only invalidate on a real flip.
 */
export function setQuietConversationBudget(quiet: boolean): boolean {
	if (quietConversation === quiet) {
		return false;
	}
	quietConversation = quiet;
	return true;
}

/** Whether expanded tool blocks ignore their render budget and show everything. */
export function toolOutputFull(): boolean {
	return fullToolOutput;
}

/** Blocks whose last render found more output than the budget allows (any mode). */
const truncatableBlocks = new Set<object>();

/**
 * Record whether a rendered block currently holds more output than the
 * (non-full) budget allows, computed independent of the current full-output
 * mode - so `app.tools.expandFull` can tell when flipping it would reveal or
 * hide nothing at all. A collapsed block never calls this; its last report
 * (if any) simply goes stale, which only biases the key toward acting rather
 * than staying silent.
 */
export function reportBudgetTruncatable(id: object, truncatable: boolean): void {
	if (truncatable) truncatableBlocks.add(id);
	else truncatableBlocks.delete(id);
}

/** Whether any rendered block last reported more output than the budget allows. */
export function anyBudgetTruncatable(): boolean {
	return truncatableBlocks.size > 0;
}

/**
 * Forgets every block's last truncation report. The set holds the reporting blocks
 * themselves, so the chat calls this whenever it discards them (cleared for a new
 * session, rebuilt from its messages, torn down): a block that left the chat would
 * otherwise stay reachable, output text and all, and keep answering yes to
 * `anyBudgetTruncatable`. Blocks built afterwards report on their first expanded render.
 */
export function resetBudgetTruncatableTracking(): void {
	truncatableBlocks.clear();
}

/**
 * Whether this body has more lines or characters than the non-full budget
 * allows, ignoring the current `toolOutputFull` mode - the same walk as
 * `expandedOutputWindow` but without its full-mode short-circuit, so it
 * answers "would the budget ever clip this" regardless of which way the key
 * is about to flip.
 */
export function wouldBudgetTruncate(lines: string[]): boolean {
	const maxLines = quietConversation ? QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES : EXPANDED_TOOL_OUTPUT_MAX_LINES;
	let chars = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const charRoom = EXPANDED_TOOL_OUTPUT_MAX_CHARS - chars;
		if (index < maxLines && line.length <= charRoom) {
			chars += line.length;
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Switch the budget off or on. Returns true when the mode actually changed, so
 * callers only pay the invalidate-and-rerender they owe on a real change.
 */
export function setToolOutputFull(full: boolean): boolean {
	if (fullToolOutput === full) {
		return false;
	}
	fullToolOutput = full;
	return true;
}

export interface ExpandedOutputWindow {
	/** Logical lines to render; the input array itself when nothing was held back. */
	lines: string[];
	/** Logical lines held back by the budget. */
	skippedLines: number;
	/** Characters held back from a single over-budget line (only when skippedLines is 0). */
	skippedChars: number;
	/** Whether the budget held anything back at all. */
	truncated: boolean;
}

/**
 * The leading window of a tool output body that the expanded view renders.
 *
 * Both bounds are checked while walking forward, so the cost is O(window) and never
 * O(body): a body that fits is handed back untouched (same array, no copy).
 */
export function expandedOutputWindow(lines: string[]): ExpandedOutputWindow {
	if (fullToolOutput) {
		return { lines, skippedLines: 0, skippedChars: 0, truncated: false };
	}
	const maxLines = quietConversation ? QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES : EXPANDED_TOOL_OUTPUT_MAX_LINES;
	let chars = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const charRoom = EXPANDED_TOOL_OUTPUT_MAX_CHARS - chars;
		if (index < maxLines && line.length <= charRoom) {
			chars += line.length;
			continue;
		}
		if (index === 0 && line.length > charRoom && charRoom > 0) {
			// One line longer than the whole character budget: show a bounded prefix of
			// it instead of showing nothing. The held-back tail of that line is only
			// reported when no whole line follows it.
			return {
				lines: [line.slice(0, charRoom)],
				skippedLines: lines.length - 1,
				skippedChars: line.length - charRoom,
				truncated: true,
			};
		}
		return { lines: lines.slice(0, index), skippedLines: lines.length - index, skippedChars: 0, truncated: true };
	}
	return { lines, skippedLines: 0, skippedChars: 0, truncated: false };
}

/** What a held-back window says about itself, e.g. "312 more lines". */
export function expandedOutputSkippedDetail(window: ExpandedOutputWindow): string {
	if (window.skippedLines > 0) {
		return `${window.skippedLines} more ${window.skippedLines === 1 ? "line" : "lines"}`;
	}
	return `${window.skippedChars} more ${window.skippedChars === 1 ? "character" : "characters"}`;
}
