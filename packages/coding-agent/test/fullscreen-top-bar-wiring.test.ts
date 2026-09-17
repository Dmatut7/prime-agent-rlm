import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The fullscreen top bar is only visible if the host actually pins it: a
 * `TopBar` that no call site hands to `enterFullscreen` renders nowhere. This
 * pins the wiring itself (the component's own rendering is covered by
 * top-bar.test.ts), so a merge that drops the `pin:` line fails here instead of
 * silently going back to an unreadable fullscreen chat.
 */
function callPrivate(mode: object, name: string, ...args: unknown[]): unknown {
	return Reflect.get(InteractiveMode.prototype, name).call(mode, ...args);
}

describe("fullscreen top bar wiring", () => {
	let previousIsTTY: PropertyDescriptor | undefined;

	beforeEach(() => {
		initTheme("dark");
		previousIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	});

	afterEach(() => {
		if (previousIsTTY) {
			Object.defineProperty(process.stdout, "isTTY", previousIsTTY);
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	it("pins the session's top bar into the fullscreen viewport", () => {
		const headerContainer = new Container();
		const mainViewContainer = new Container();
		const widgetContainerAbove = new Container();
		const recapContainer = new Container();
		const featureHintContainer = new Container();
		const queuedMessagesContainer = new Container();
		const sideQuestionContainer = new Container();
		const widgetContainerBelow = new Container();
		const promptDock = new Container();
		const topBar = new TopBar({ getChatName: () => "demo", getCostUsd: () => 1.42 });
		const enterFullscreen = vi.fn();
		const exitFullscreen = vi.fn();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			headerContainer,
			mainViewContainer,
			widgetContainerAbove,
			recapContainer,
			featureHintContainer,
			queuedMessagesContainer,
			sideQuestionContainer,
			widgetContainerBelow,
			promptDock,
			topBar,
			ui: { enterFullscreen, exitFullscreen },
			uiServices: { settingsManager: { getFullscreenMouse: () => true } },
		});

		callPrivate(mode, "applyFullscreen", true);

		expect(enterFullscreen).toHaveBeenCalledWith({
			scroll: [
				headerContainer,
				mainViewContainer,
				widgetContainerAbove,
				recapContainer,
				featureHintContainer,
				queuedMessagesContainer,
				sideQuestionContainer,
				widgetContainerBelow,
			],
			dock: promptDock,
			pin: topBar,
			mouse: true,
		});
		// The pinned component is the live bar (not a detached copy): it renders the
		// chat the session is bound to.
		const pinned = enterFullscreen.mock.calls[0]![0].pin as TopBar;
		expect(pinned.render(21).join("\n")).toContain("demo");

		callPrivate(mode, "applyFullscreen", false);
		expect(exitFullscreen).toHaveBeenCalledOnce();
	});
});
