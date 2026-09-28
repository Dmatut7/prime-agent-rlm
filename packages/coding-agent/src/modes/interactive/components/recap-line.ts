import { isErrorRecap } from "../../daemon/daemon-session-summarizer.js";

/**
 * The recap line under the chat, or undefined when there is none to show. In
 * the quiet conversation a failed turn's box already says why in its red row,
 * so the recap that only repeats that error is left out.
 */
export function recapLineText(recap: string | undefined, quiet: boolean): string | undefined {
	const text = recap?.trim();
	if (!text) return undefined;
	if (quiet && isErrorRecap(text)) return undefined;
	return `回顾：${text}`;
}
