import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { TurnBoxNavigator } from "../src/modes/interactive/components/turn-box-navigator.js";

function walk() {
	const calls: string[] = [];
	const navigator = new TurnBoxNavigator({
		move: (direction) => calls.push(`move ${direction}`),
		page: (direction) => calls.push(`page ${direction}`),
		activate: () => calls.push("activate"),
		exit: (pass) => calls.push(`exit ${pass ?? ""}`),
		blur: () => calls.push("blur"),
	});
	return { calls, navigator };
}

beforeAll(() => {
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("the box walk's page keys", () => {
	it("scrolls the body a page up on PageUp and a page down on PageDown", () => {
		const { calls, navigator } = walk();
		navigator.handleInput("\x1b[5~");
		navigator.handleInput("\x1b[6~");
		expect(calls).toEqual(["page -1", "page 1"]);
	});

	it("asks the fullscreen view to hand it the page keys instead of paging the transcript", () => {
		expect(walk().navigator.wantsPageKeys).toBe(true);
	});

	it("follows the configured page keys, and lets the old ones through to the prompt", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "alt+u", "tui.select.pageDown": "alt+d" }));
		const { calls, navigator } = walk();
		navigator.handleInput("\x1bu");
		navigator.handleInput("\x1bd");
		navigator.handleInput("\x1b[5~");
		expect(calls).toEqual(["page -1", "page 1", "exit \x1b[5~"]);
	});
});
