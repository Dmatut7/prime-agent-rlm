import type { TimelineLane } from "./timeline-gutter.js";

/**
 * Which subagents of the current request are still out, so every timeline row
 * appended while they work draws the dotted lane (`┆`), the row that dispatches
 * them draws the split (`──╮`) and the report that brings the last one back
 * draws the join (`──╯`). The conversation builder and the live flow each own
 * one tracker and hand the lane to a component when they append it; a
 * component keeps the lane it was given, so a replayed conversation draws the
 * same lanes as the live one.
 */
export class TimelineLaneTracker {
	private readonly out = new Set<string>();

	/** Subagents dispatched; returns the lane for the dispatching row (`split`). */
	spawned(names: readonly string[]): TimelineLane {
		for (const name of names) this.out.add(name);
		return "split";
	}

	/**
	 * A subagent reported: `join` when it was out and the last one, `sub` while others are still
	 * out. A name that was never out (or a late report after the lane emptied) joins nothing.
	 */
	reported(name: string): TimelineLane {
		const wasOut = this.out.delete(name);
		if (this.out.size > 0) return "sub";
		return wasOut ? "join" : "off";
	}

	/** The lane for an ordinary row appended now. */
	get lane(): TimelineLane {
		return this.out.size > 0 ? "on" : "off";
	}

	get active(): boolean {
		return this.out.size > 0;
	}

	/** Names still out, in dispatch order (for "A、C、D 还在干活"). */
	get pending(): string[] {
		return [...this.out];
	}

	reset(): void {
		this.out.clear();
	}
}

/**
 * The closing line's "完整过程 ▸" toggle: while on, rows the timeline hides by
 * default (bookkeeping rounds, system notices, background memory tidying) show.
 */
export const timelineShowAll = {
	value: false,
	listeners: new Set<() => void>(),
	set(next: boolean): void {
		if (this.value === next) return;
		this.value = next;
		for (const listener of this.listeners) listener();
	},
};
