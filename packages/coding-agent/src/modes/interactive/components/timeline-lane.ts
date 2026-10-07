import type { TimelineLane } from "./timeline-gutter.js";

/** What dispatched a subagent, told when it comes back (the timeline that draws its dispatch row). */
export interface LaneOwner {
	subagentReturned(name: string, at: number): void;
	/** When the subagent it dispatched under `name` went out, when it knows (a lane it is asked to draw without a time). */
	spawnedAt?(name: string): number | undefined;
}

/** An out-of-band close's best guess at how the subagent left, for the round count. */
export type LaneSettleKind = "failed" | "silent" | "cancelled";

interface LaneSettle {
	at: number;
	kind: LaneSettleKind;
}

/** One subagent's time away: out from `from`, back at `to` (still out while `to` is absent). */
export interface LaneSpan {
	name: string;
	from: number;
	to?: number;
}

/**
 * Who was out when, for one question. A row is on the lane when a subagent went out before it and
 * had not come back by its time, so what a row shows never depends on when it is drawn. The
 * conversation keeps one record per question: the turns of that question read it, and the next
 * question starts a fresh one, so a finished question keeps the lanes it was drawn with.
 */
export class LaneSpans {
	private readonly list: LaneSpan[] = [];
	private readonly back = new Map<string, number>();

	/**
	 * `name` went out at `from`. Already out: the later of the two starts stands (a span seeded from
	 * the start of a window is not later than the real dispatch), and a start that is only a guess
	 * (`known` false) changes nothing.
	 */
	open(name: string, from: number, known = true): void {
		const out = this.list.find((span) => span.name === name && span.to === undefined);
		if (out) {
			if (known) out.from = Math.max(out.from, from);
			return;
		}
		this.list.push({ name, from });
	}

	/** A return learned from somewhere else; a return this record already has stands. */
	noteBack(name: string, at: number): void {
		if (!this.back.has(name)) this.back.set(name, at);
	}

	/** `name` came back at `at`; true when it was out. Its return is remembered either way. */
	close(name: string, at: number): boolean {
		let closed = false;
		for (const span of this.list) {
			if (span.name !== name || span.to !== undefined) continue;
			span.to = Math.max(at, span.from);
			closed = true;
		}
		this.back.set(name, at);
		return closed;
	}

	/** When `name` last came back, if it did. */
	returnedAt(name: string): number | undefined {
		return this.back.get(name);
	}

	knows(name: string): boolean {
		return this.list.some((span) => span.name === name);
	}

	/** Names still out, in the order they went out. */
	get out(): string[] {
		return [...new Set(this.list.filter((span) => span.to === undefined).map((span) => span.name))];
	}

	/**
	 * Whether some subagent is out at `at`: gone before it (`from < at`, or `from <= at` when `atStart`
	 * asks about the moment one goes out) and not back by then.
	 */
	outAt(at: number, atStart = false): boolean {
		return this.list.some(
			(span) => (atStart ? span.from <= at : span.from < at) && (span.to === undefined || at < span.to),
		);
	}

	/** A span learned from somewhere else (a rebuild's record of what the live view knew). */
	add(span: LaneSpan): void {
		this.list.push({ ...span });
	}

	snapshot(): LaneSnapshot {
		return { spans: this.list.map((span) => ({ ...span })), returns: [...this.back] };
	}
}

/** What the lane knew at some moment, for the rebuild that replays the conversation from the start. */
export interface LaneSnapshot {
	spans: LaneSpan[];
	returns: Array<[string, number]>;
}

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
	private store = new LaneSpans();
	private readonly owners = new Map<string, LaneOwner>();
	/** Spans a terminal snapshot closed without a report row yet; the next return consumes them into the round count. */
	private settled = new Map<string, LaneSettle>();

	/** The record of this question's dispatches and returns; a timeline keeps the one it was given. */
	get spans(): LaneSpans {
		return this.store;
	}

	/** Subagents dispatched; returns the lane for the dispatching row (`split`). `owner` is told when one comes back. */
	spawned(names: readonly string[], owner?: LaneOwner, at?: number): TimelineLane {
		for (const name of names) {
			const from = at ?? owner?.spawnedAt?.(name);
			this.store.open(name, from ?? Date.now(), from !== undefined);
			if (owner) this.owners.set(name, owner);
		}
		return "split";
	}

	/**
	 * A subagent reported: `join` when it was out and the last one, `sub` while others are still
	 * out. A name that was never out (or a late report after the lane emptied) joins nothing.
	 */
	reported(name: string, at: number = Date.now()): TimelineLane {
		const wasOut = this.store.close(name, at);
		if (wasOut) this.owners.get(name)?.subagentReturned(name, at);
		this.owners.delete(name);
		if (this.active) return "sub";
		return wasOut ? "join" : "off";
	}

	/** A subagent that was not known to be out came back: its return is kept, the lane is untouched. */
	noteReturned(name: string, at: number = Date.now()): void {
		this.store.close(name, at);
	}

	/**
	 * A terminal snapshot closed `name`'s span out of band: the report row that
	 * follows (minutes later, after the parent's turn boundary) must still count
	 * as the round's return — record it for the next `comeBack`-style return to
	 * consume. Closes the span and notifies the owner exactly like `reported`.
	 */
	settle(name: string, at: number, kind: LaneSettleKind): void {
		const wasOut = this.store.close(name, at);
		if (wasOut) {
			this.owners.get(name)?.subagentReturned(name, at);
			this.settled.set(name, { at, kind });
		}
		this.owners.delete(name);
	}

	/** Outstanding out-of-band settles, emptied by the call. */
	takeSettles(): Array<{ name: string; at: number; kind: LaneSettleKind }> {
		if (this.settled.size === 0) return [];
		const out = [...this.settled.entries()].map(([name, settle]) => ({ name, ...settle }));
		this.settled.clear();
		return out;
	}

	/** The lane for a row stamped `at` (as now when it has no stamp): on when some subagent was out then. */
	laneAt(at: number | undefined): TimelineLane {
		if (at === undefined) return this.lane;
		return this.store.outAt(at) ? "on" : "off";
	}

	/** The lane for an ordinary row appended now. */
	get lane(): TimelineLane {
		return this.active ? "on" : "off";
	}

	get active(): boolean {
		return this.store.out.length > 0;
	}

	/** Names still out, in dispatch order (for "A、C、D 还在干活"). */
	get pending(): string[] {
		return this.store.out;
	}

	/** What the lane knows now, taken before a rebuild forgets it. */
	snapshot(): LaneSnapshot {
		return this.store.snapshot();
	}

	/**
	 * Take back what a rebuild's replay could not see (the dispatch was compacted away or is
	 * outside the window): a subagent the replay knows nothing of is out from when it went out,
	 * or was out until the return the replay did see. Whatever the replay learned itself stands.
	 * `since` is when the question the replay ends in began: an earlier dispatch is another question's.
	 */
	restore(previous: LaneSnapshot, since?: number): void {
		// A child that came back without ever being on the lane leaves only its return: without it a rebuild sees it out again.
		for (const [name, at] of previous.returns) {
			if (since === undefined || at >= since) this.store.noteBack(name, at);
		}
		for (const span of previous.spans) {
			if (this.store.knows(span.name) || (since !== undefined && span.from < since)) continue;
			const back = span.to ?? this.store.returnedAt(span.name);
			this.store.add({
				name: span.name,
				from: span.from,
				...(back !== undefined && back > span.from ? { to: back } : {}),
			});
		}
	}

	reset(): void {
		this.store = new LaneSpans();
		this.owners.clear();
		this.settled.clear();
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
