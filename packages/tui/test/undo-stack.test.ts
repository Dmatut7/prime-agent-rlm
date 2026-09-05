import assert from "node:assert";
import { describe, it } from "node:test";
import { UNDO_STACK_LIMIT, UndoStack } from "../src/undo-stack.js";

describe("UndoStack", () => {
	it("drops the oldest snapshot once it exceeds UNDO_STACK_LIMIT", () => {
		const stack = new UndoStack<number>((value) => value);
		for (let i = 0; i < UNDO_STACK_LIMIT + 3; i++) {
			stack.push(i);
		}
		assert.strictEqual(stack.length, UNDO_STACK_LIMIT);
		assert.strictEqual(stack.pop(), UNDO_STACK_LIMIT + 2);
		assert.strictEqual(stack.pop(), UNDO_STACK_LIMIT + 1);
		assert.strictEqual(stack.pop(), UNDO_STACK_LIMIT);
		for (let i = 0; i < UNDO_STACK_LIMIT - 4; i++) {
			stack.pop();
		}
		assert.strictEqual(stack.pop(), 3);
		assert.strictEqual(stack.pop(), undefined);
	});

	it("honors a custom max length", () => {
		const stack = new UndoStack<string>((value) => value, 2);
		stack.push("a");
		stack.push("b");
		stack.push("c");
		assert.strictEqual(stack.length, 2);
		assert.strictEqual(stack.pop(), "c");
		assert.strictEqual(stack.pop(), "b");
		assert.strictEqual(stack.pop(), undefined);
	});
});
