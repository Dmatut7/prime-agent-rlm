import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.js";
import { Spacer } from "../src/components/spacer.js";

// The line aggregator memoizes on render-output identity: a fresh array per
// frame rebuilds the whole transcript's line list every render.
describe("Spacer/Box render identity", () => {
	it("Spacer returns the same array while its line count is unchanged", () => {
		const spacer = new Spacer(2);
		const first = spacer.render(80);
		assert.deepStrictEqual(first, ["", ""]);
		assert.strictEqual(spacer.render(40), first);
		spacer.setLines(1);
		const shrunk = spacer.render(80);
		assert.deepStrictEqual(shrunk, [""]);
		assert.notStrictEqual(shrunk, first);
		assert.strictEqual(spacer.render(80), shrunk);
	});

	it("an empty Box returns a stable empty array", () => {
		const box = new Box();
		assert.deepStrictEqual(box.render(80), []);
		assert.strictEqual(box.render(80), box.render(40));
	});
});
