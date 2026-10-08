import { sanitizeRowText } from "../../../utils/display-text.js";
import { isErrorRecap } from "../../daemon/daemon-session-summarizer.js";

/**
 * The recap line under the chat, or undefined when there is none to show. In
 * the quiet conversation a failed turn's box already says why in its red row,
 * so the recap that only repeats that error is left out.
 */
export function recapLineText(recap: string | undefined, quiet: boolean): string | undefined {
	// The recap can come from a journal a pre-wash build wrote (the snapshot's
	// baseline) or from the daemon's live summary, and the line renders through
	// TruncatedText - a component the Text gate never sees - so the wash is here,
	// where every source converges. It runs before the error verdict is matched,
	// the way the summarizer's own clean path does.
	const text = sanitizeRowText(recap ?? "");
	if (!text) return undefined;
	if (quiet && isErrorRecap(text)) return undefined;
	return `回顾：${text}`;
}
