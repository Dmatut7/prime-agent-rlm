import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ShowImagesSelectorComponent } from "../src/modes/interactive/components/show-images-selector.js";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

describe("selector back key", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("thinking selector closes on the back key like esc", () => {
		const onCancel = vi.fn();
		const selector = new ThinkingSelectorComponent("medium", ["low", "medium", "high"], () => {}, onCancel);

		selector.handleInput(LEFT);

		expect(onCancel).toHaveBeenCalledOnce();

		selector.handleInput(ESC);

		expect(onCancel).toHaveBeenCalledTimes(2);
	});

	it("thinking selector still navigates and selects through the wrapper", () => {
		const onSelect = vi.fn();
		const selector = new ThinkingSelectorComponent("medium", ["low", "medium", "high"], onSelect, () => {});

		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		expect(onSelect).toHaveBeenCalledExactlyOnceWith("high");
	});

	it("show-images selector closes on the back key like esc", () => {
		const onCancel = vi.fn();
		const selector = new ShowImagesSelectorComponent(true, () => {}, onCancel);

		selector.handleInput(LEFT);

		expect(onCancel).toHaveBeenCalledOnce();

		selector.handleInput(ESC);

		expect(onCancel).toHaveBeenCalledTimes(2);
	});

	it("show-images selector still navigates and selects through the wrapper", () => {
		const onSelect = vi.fn();
		const selector = new ShowImagesSelectorComponent(true, onSelect, () => {});

		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		expect(onSelect).toHaveBeenCalledExactlyOnceWith(false);
	});
});
