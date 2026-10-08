import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("ExtensionInputComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the placeholder while the input is empty", () => {
		// The constructor's placeholder parameter used to be accepted and dropped.
		const component = new ExtensionInputComponent("Name the session", "e.g. deploy-fix", vi.fn(), vi.fn());

		const output = stripAnsi(component.render(60).join("\n"));

		expect(output).toContain("e.g. deploy-fix");
	});

	it("hides the placeholder once the input has a value", () => {
		const component = new ExtensionInputComponent("Name the session", "e.g. deploy-fix", vi.fn(), vi.fn());

		component.handleInput("x");
		const output = stripAnsi(component.render(60).join("\n"));

		expect(output).not.toContain("e.g. deploy-fix");
	});
});
