import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";

describe("app keybinding overrides", () => {
	it("uses ctrl+c for configuration exit and model search-clear by default", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.configuration.exit")).toEqual(["ctrl+c"]);
		expect(keybindings.getKeys("app.models.clearSearch")).toEqual(["ctrl+c"]);
		expect(keybindings.matches("\u0003", "app.configuration.exit")).toBe(true);
		expect(keybindings.matches("\u0003", "app.models.clearSearch")).toBe(true);
	});

	it("lets user config replace configuration exit and model search-clear", () => {
		const keybindings = new KeybindingsManager({
			"app.configuration.exit": "ctrl+q",
			"app.models.clearSearch": "ctrl+u",
		});
		expect(keybindings.getKeys("app.configuration.exit")).toEqual(["ctrl+q"]);
		expect(keybindings.getKeys("app.models.clearSearch")).toEqual(["ctrl+u"]);
		expect(keybindings.matches("\u0003", "app.configuration.exit")).toBe(false);
		expect(keybindings.matches("\u0011", "app.configuration.exit")).toBe(true);
		expect(keybindings.matches("\u0015", "app.models.clearSearch")).toBe(true);
	});
});
