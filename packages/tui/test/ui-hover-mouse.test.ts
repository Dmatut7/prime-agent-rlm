import assert from "node:assert";
import { describe, it } from "node:test";
import { isMouseHover, isMouseSequence, parseSgrMouseEvent } from "../src/mouse.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

describe("hover mouse reports", () => {
	it("parses a button-less move (code 35) as button 3 with the motion bit", () => {
		const move = parseSgrMouseEvent("\x1b[<35;12;7M");
		assert.deepStrictEqual(move, {
			button: 3,
			x: 12,
			y: 7,
			press: true,
			motion: true,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(isMouseHover(move!), true);
		assert.strictEqual(isMouseSequence("\x1b[<35;12;7M"), true);
	});

	it("keeps the modifier flags on a hover move", () => {
		const move = parseSgrMouseEvent("\x1b[<39;1;1M");
		assert.strictEqual(move?.button, 3);
		assert.strictEqual(move?.shift, true);
		assert.strictEqual(isMouseHover(move!), true);
	});

	it("never mistakes a drag, click, wheel or release for a hover move", () => {
		const others = [
			"\x1b[<32;5;5M", // left drag
			"\x1b[<33;5;5M", // middle drag
			"\x1b[<34;5;5M", // right drag
			"\x1b[<0;5;5M", // left press
			"\x1b[<0;5;5m", // left release
			"\x1b[<64;5;5M", // wheel up
			"\x1b[<65;5;5M", // wheel down
			"\x1b[<3;5;5M", // button 3 without the motion bit
			"\x1b[<35;5;5m", // a release report
		];
		assert.ok(others.length > 0);
		for (const sequence of others) {
			const event = parseSgrMouseEvent(sequence);
			assert.ok(event, sequence);
			assert.strictEqual(isMouseHover(event), false, JSON.stringify(sequence));
		}
	});

	it("assembles a dense burst of moves into one report each", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const received: string[] = [];
		buffer.on("data", (sequence) => received.push(sequence));
		buffer.process("\x1b[<35;1;1M\x1b[<35;2;1M\x1b[<35;3;");
		buffer.process("1M");
		assert.deepStrictEqual(received, ["\x1b[<35;1;1M", "\x1b[<35;2;1M", "\x1b[<35;3;1M"]);
		buffer.destroy();
	});
});
