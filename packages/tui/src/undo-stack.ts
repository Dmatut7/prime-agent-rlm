/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores cloned state snapshots. Popped snapshots are returned directly
 * since they are already detached. Oldest entries are dropped once the
 * stack exceeds {@link UNDO_STACK_LIMIT}.
 */
export const UNDO_STACK_LIMIT = 500;

export class UndoStack<S> {
	private stack: S[] = [];

	constructor(
		private readonly clone: (state: S) => S = structuredClone,
		private readonly maxLength: number = UNDO_STACK_LIMIT,
	) {}

	push(state: S): void {
		this.stack.push(this.clone(state));
		if (this.stack.length > this.maxLength) {
			this.stack.shift();
		}
	}

	pop(): S | undefined {
		return this.stack.pop();
	}

	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
