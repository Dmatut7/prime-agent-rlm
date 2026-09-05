import assert from "node:assert";
import { describe, it } from "node:test";
import { KILL_RING_LIMIT, KillRing } from "../src/kill-ring.js";

describe("KillRing", () => {
	it("caps unique kills at KILL_RING_LIMIT and evicts the oldest", () => {
		const ring = new KillRing();
		for (let i = 0; i < KILL_RING_LIMIT + 2; i++) {
			ring.push(`k${i}`, { prepend: false });
		}
		assert.strictEqual(ring.length, KILL_RING_LIMIT);
		assert.strictEqual(ring.peek(), `k${KILL_RING_LIMIT + 1}`);

		const seen: string[] = [];
		for (let i = 0; i < KILL_RING_LIMIT; i++) {
			seen.push(ring.peek()!);
			ring.rotate();
		}
		assert.ok(!seen.includes("k0"));
		assert.ok(!seen.includes("k1"));
		assert.ok(seen.includes("k2"));
		assert.ok(seen.includes(`k${KILL_RING_LIMIT + 1}`));
		assert.strictEqual(new Set(seen).size, KILL_RING_LIMIT);
	});

	it("overwrites the oldest slot in a small ring", () => {
		const ring = new KillRing(3);
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false });
		ring.push("d", { prepend: false });
		assert.strictEqual(ring.length, 3);
		assert.strictEqual(ring.peek(), "d");
		ring.rotate();
		assert.strictEqual(ring.peek(), "c");
		ring.rotate();
		assert.strictEqual(ring.peek(), "b");
		ring.rotate();
		assert.strictEqual(ring.peek(), "d");
	});

	it("accumulates into the most recent entry without growing", () => {
		const ring = new KillRing(2);
		ring.push("world", { prepend: false });
		ring.push("hello ", { prepend: true, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "hello world");
		ring.push("!", { prepend: false, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "hello world!");
	});

	it("rotate is a no-op for 0 or 1 entries", () => {
		const ring = new KillRing();
		ring.rotate();
		assert.strictEqual(ring.peek(), undefined);
		ring.push("only", { prepend: false });
		ring.rotate();
		assert.strictEqual(ring.peek(), "only");
	});
});
