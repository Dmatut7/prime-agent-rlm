import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";

// Kitty flag-2 key events: CSI 1;<modifiers+1>:<event><letter> for arrows, with
// alt=2 and ctrl=4; event 1=press, 2=repeat. On a kitty-protocol terminal a held
// navigation key only reaches actions whose binding opted into repeat events.
describe("navigation keybindings repeat when held", () => {
	const cases: { binding: Parameters<KeybindingsManager["matches"]>[1]; press: string; repeat: string }[] = [
		{ binding: "app.message.navigateOlder", press: "\x1b[1;3A", repeat: "\x1b[1;3:2A" },
		{ binding: "app.message.navigateNewer", press: "\x1b[1;3B", repeat: "\x1b[1;3:2B" },
		{ binding: "app.message.moveEarlier", press: "\x1b[1;7A", repeat: "\x1b[1;7:2A" },
		{ binding: "app.message.moveLater", press: "\x1b[1;7B", repeat: "\x1b[1;7:2B" },
		{ binding: "app.blocks.prev", press: "\x1b[1;3A", repeat: "\x1b[1;3:2A" },
		{ binding: "app.blocks.next", press: "\x1b[1;3B", repeat: "\x1b[1;3:2B" },
		{ binding: "app.models.reorderUp", press: "\x1b[1;3A", repeat: "\x1b[1;3:2A" },
		{ binding: "app.models.reorderDown", press: "\x1b[1;3B", repeat: "\x1b[1;3:2B" },
		// The subagent strip walks on plain arrows; kitty repeats arrive as event 2.
		{ binding: "app.subagents.prev", press: "\x1b[D", repeat: "\x1b[1;1:2D" },
		{ binding: "app.subagents.next", press: "\x1b[C", repeat: "\x1b[1;1:2C" },
	];

	it("covers the alt/ctrl-alt arrow navigation bindings and the subagent strip arrows", () => {
		expect(cases.length).toBe(10);
	});

	for (const { binding, press, repeat } of cases) {
		it(`${binding} matches press and repeat`, () => {
			const keybindings = new KeybindingsManager();
			expect(keybindings.matches(press, binding)).toBe(true);
			expect(keybindings.matches(repeat, binding)).toBe(true);
		});
	}

	it("keeps one-shot actions press-only (alt+enter repeat stays filtered)", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.matches("\x1b[13;3u", "app.message.followUp")).toBe(true);
		expect(keybindings.matches("\x1b[13;3:2u", "app.message.followUp")).toBe(false);
	});
});
