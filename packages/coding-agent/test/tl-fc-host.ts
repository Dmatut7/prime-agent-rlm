import stripAnsi from "strip-ansi";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import type { ReplayHost } from "./tl-fix-host.js";

/**
 * The interactive mode's replay on a host that has only what the replay reads (see tl-fix-host.ts),
 * and the small readers the replay tests share.
 */

export const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
export const plain = (lines: readonly string[]) =>
	lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

export { createReplayHost, type ReplayHost, type ReplayOptions, replayInto } from "./tl-fix-host.js";

export function summariesOf(host: ReplayHost): TurnSummaryComponent[] {
	return host.chatContainer.children.filter(
		(child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent,
	);
}

export function screenOf(host: ReplayHost, width = 160): string[] {
	return plain(host.chatContainer.children.flatMap((child) => child.render(width)));
}
