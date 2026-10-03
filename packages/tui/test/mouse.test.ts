import assert from "node:assert";
import { describe, it } from "node:test";
import {
	isLegacyMouseRelease,
	isMouseHover,
	isMouseSequence,
	isWheelDown,
	isWheelUp,
	parseMouseEvent,
	parseSgrMouseEvent,
} from "../src/mouse.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

describe("parseSgrMouseEvent", () => {
	it("parses wheel up and wheel down", () => {
		const up = parseSgrMouseEvent("\x1b[<64;10;5M");
		assert.deepStrictEqual(up, {
			button: 64,
			x: 10,
			y: 5,
			press: true,
			motion: false,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(isWheelUp(up!), true);
		assert.strictEqual(isWheelDown(up!), false);

		const down = parseSgrMouseEvent("\x1b[<65;1;1M");
		assert.strictEqual(isWheelDown(down!), true);
		assert.strictEqual(isWheelUp(down!), false);
	});

	it("strips modifier bits into flags", () => {
		const event = parseSgrMouseEvent("\x1b[<84;3;7M");
		assert.strictEqual(event!.button, 64);
		assert.strictEqual(event!.shift, true);
		assert.strictEqual(event!.ctrl, true);
		assert.strictEqual(event!.alt, false);
		assert.strictEqual(isWheelUp(event!), true);
	});

	it("distinguishes press from release", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5M")?.press, true);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5m")?.press, false);
	});

	it("flags drag motion and strips the motion bit from the button", () => {
		const drag = parseSgrMouseEvent("\x1b[<32;5;5M");
		assert.strictEqual(drag?.motion, true);
		assert.strictEqual(drag?.button, 0);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5M")?.motion, false);
	});

	it("returns null for non-mouse input", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[A"), null);
		assert.strictEqual(parseSgrMouseEvent("a"), null);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<64;10M"), null);
	});
});

describe("isMouseSequence", () => {
	it("matches SGR and legacy mouse reports", () => {
		assert.strictEqual(isMouseSequence("\x1b[<64;10;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[M   "), true);
		assert.strictEqual(isMouseSequence("\x1b[A"), false);
	});
});

describe("parseMouseEvent", () => {
	const legacy = (button: number, x: number, y: number) =>
		`\x1b[M${String.fromCharCode(32 + button)}${String.fromCharCode(32 + x)}${String.fromCharCode(32 + y)}`;

	it("prefers the SGR encoding when both could match", () => {
		const event = parseMouseEvent("\x1b[<0;5;6m");
		assert.deepStrictEqual(event, {
			button: 0,
			x: 5,
			y: 6,
			press: false,
			motion: false,
			shift: false,
			alt: false,
			ctrl: false,
		});
	});

	it("parses a legacy X10 press, drag and release", () => {
		assert.deepStrictEqual(parseMouseEvent(legacy(0, 10, 5)), {
			button: 0,
			x: 10,
			y: 5,
			press: true,
			motion: false,
			shift: false,
			alt: false,
			ctrl: false,
		});

		const drag = parseMouseEvent(legacy(32, 10, 5));
		assert.strictEqual(drag?.button, 0);
		assert.strictEqual(drag?.motion, true);
		assert.strictEqual(drag?.press, true);

		// X10 has no release button: a release reports button code 3 with no motion.
		const release = parseMouseEvent(legacy(3, 10, 5));
		assert.strictEqual(release?.button, 3);
		assert.strictEqual(release?.press, false);
		assert.strictEqual(release?.motion, false);
	});

	it("keeps a legacy hover move pressed so it cannot read as a release", () => {
		const hover = parseMouseEvent(legacy(35, 10, 5));
		assert.strictEqual(hover?.button, 3);
		assert.strictEqual(hover?.motion, true);
		assert.strictEqual(hover?.press, true);
		assert.strictEqual(isMouseHover(hover!), true);
	});

	it("parses legacy wheel reports and modifier bits", () => {
		const wheel = parseMouseEvent(legacy(64, 10, 5));
		assert.strictEqual(wheel?.press, true);
		assert.strictEqual(isWheelUp(wheel!), true);

		const modified = parseMouseEvent(legacy(0 + 4 + 8 + 16, 1, 1));
		assert.strictEqual(modified?.button, 0);
		assert.strictEqual(modified?.shift, true);
		assert.strictEqual(modified?.alt, true);
		assert.strictEqual(modified?.ctrl, true);
	});

	it("returns null for non-mouse input and truncated reports", () => {
		assert.strictEqual(parseMouseEvent("\x1b[A"), null);
		assert.strictEqual(parseMouseEvent("a"), null);
		assert.strictEqual(parseMouseEvent("\x1b[M"), null);
	});
});

describe("isLegacyMouseRelease", () => {
	it("matches only a motionless X10 release (button code 3)", () => {
		const legacy = (button: number, x: number, y: number) =>
			`\x1b[M${String.fromCharCode(32 + button)}${String.fromCharCode(32 + x)}${String.fromCharCode(32 + y)}`;
		assert.strictEqual(isLegacyMouseRelease(parseMouseEvent(legacy(3, 10, 5))!), true);
		// SGR releases carry their own button and never report code 3.
		assert.strictEqual(isLegacyMouseRelease(parseMouseEvent("\x1b[<0;10;5m")!), false);
		// A legacy press and a legacy hover move are not releases.
		assert.strictEqual(isLegacyMouseRelease(parseMouseEvent(legacy(0, 10, 5))!), false);
		assert.strictEqual(isLegacyMouseRelease(parseMouseEvent(legacy(35, 10, 5))!), false);
	});
});

describe("SGR mouse through StdinBuffer", () => {
	it("assembles a sequence that arrives split across chunks", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const received: string[] = [];
		buffer.on("data", (seq) => received.push(seq));

		buffer.process("\x1b");
		buffer.process("[<64");
		buffer.process(";20;5M");

		assert.deepStrictEqual(received, ["\x1b[<64;20;5M"]);
		const event = parseSgrMouseEvent(received[0]!);
		assert.strictEqual(event!.button, 64);
		assert.strictEqual(event!.x, 20);
		assert.strictEqual(event!.y, 5);
		buffer.destroy();
	});

	it("assembles a DECRPM mouse-probe response", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const received: string[] = [];
		buffer.on("data", (seq) => received.push(seq));

		buffer.process("\x1b[?1006;");
		buffer.process("2$y");

		assert.deepStrictEqual(received, ["\x1b[?1006;2$y"]);
		buffer.destroy();
	});
});
