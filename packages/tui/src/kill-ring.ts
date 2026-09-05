/**
 * Ring buffer for Emacs-style kill/yank operations.
 *
 * Tracks killed (deleted) text entries. Consecutive kills can accumulate
 * into a single entry. Supports yank (paste most recent) and yank-pop
 * (cycle through older entries). Capped at {@link KILL_RING_LIMIT} entries;
 * a new unique kill overwrites the oldest.
 */
export const KILL_RING_LIMIT = 60;

export class KillRing {
	private readonly slots: string[] = [];
	private head = 0;
	private count = 0;

	constructor(private readonly maxEntries: number = KILL_RING_LIMIT) {}

	/**
	 * Add text to the kill ring.
	 *
	 * @param text - The killed text to add
	 * @param opts - Push options
	 * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
	 * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.count > 0) {
			const lastIndex = this.indexOfMostRecent();
			const last = this.slots[lastIndex];
			this.slots[lastIndex] = opts.prepend ? text + last : last + text;
			return;
		}

		if (this.count === this.maxEntries) {
			this.slots[this.head] = text;
			this.head = (this.head + 1) % this.maxEntries;
			return;
		}

		this.slots[(this.head + this.count) % this.maxEntries] = text;
		this.count++;
	}

	peek(): string | undefined {
		if (this.count === 0) return undefined;
		return this.slots[this.indexOfMostRecent()];
	}

	rotate(): void {
		if (this.count <= 1) return;
		// Move the most recent entry to the oldest slot, matching the previous
		// pop+unshift array rotation so yank-pop still walks older kills.
		const lastIndex = this.indexOfMostRecent();
		const last = this.slots[lastIndex];
		this.head = (this.head - 1 + this.maxEntries) % this.maxEntries;
		this.slots[this.head] = last;
	}

	get length(): number {
		return this.count;
	}

	private indexOfMostRecent(): number {
		return (this.head + this.count - 1) % this.maxEntries;
	}
}
