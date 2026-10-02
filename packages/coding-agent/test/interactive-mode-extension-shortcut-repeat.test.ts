import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * Extension shortcuts are press-only, matching the KeybindingsManager default for
 * non-repeatable bindings. matchesKey() ignores the Kitty event-type field, and the
 * extension-shortcut path in setupExtensionShortcuts matched with bare matchesKey,
 * so a held shortcut key re-fired its handler at the terminal's auto-repeat rate
 * while every manager-routed binding fired once.
 *
 * Declining (returning false) instead of consuming is the contract: an unbound
 * key's repeat must still fall through to the editor so held text keys keep
 * inserting characters.
 */

// Kitty CSI-u for "x": press is the plain byte, repeat is codepoint 120 with
// modifier 1 (none) and event type 2 (repeat).
const X_REPEAT = "\x1b[120;1:2u";
const Y_REPEAT = "\x1b[121;1:2u";

function setup() {
	const handler = vi.fn();
	const runner = {
		getShortcuts: () => new Map([["x", { handler }]]),
		hasUI: () => false,
		getUIContext: () => ({}),
	};
	const fakeThis = {
		keybindings: { getEffectiveConfig: () => ({}) },
		getLocalSessionHost: () => ({
			getSessionManager: () => ({}),
			getAbortSignal: () => new AbortController().signal,
			getSystemPrompt: () => "",
		}),
		createExtensionUIContext: () => ({}),
		getCurrentCwd: () => "/tmp",
		modelRegistry: {},
		getCurrentModel: () => undefined,
		isAgentStreaming: () => false,
		agentConnection: { abort: vi.fn(), compact: vi.fn() },
		getQueuedActionCount: () => 0,
		getConnectionContextUsage: () => undefined,
		defaultEditor: {} as { onExtensionShortcut?: (data: string) => boolean },
		showError: vi.fn(),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype extraction, in-repo
	// precedent: interactive-mode-extension-shortcut-ui.test.ts extracts the same method.
	const proto = InteractiveMode as unknown as {
		prototype: { setupExtensionShortcuts(runner: unknown): void };
	};
	proto.prototype.setupExtensionShortcuts.call(fakeThis, runner);
	const onKey = fakeThis.defaultEditor.onExtensionShortcut;
	expect(onKey).toBeDefined();
	return { handler, onKey: onKey! };
}

describe("InteractiveMode.setupExtensionShortcuts key repeat", () => {
	test("a press fires the shortcut handler once and consumes the key", () => {
		const { handler, onKey } = setup();

		expect(onKey("x")).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("a Kitty repeat event does not re-fire the handler and is declined", () => {
		const { handler, onKey } = setup();

		expect(onKey(X_REPEAT)).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	test("a held key fires once: press fires, the following repeats do not", () => {
		const { handler, onKey } = setup();

		onKey("x");
		onKey(X_REPEAT);
		onKey(X_REPEAT);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("a repeat of an unbound key is still declined so text insertion can take it", () => {
		const { onKey } = setup();

		expect(onKey(Y_REPEAT)).toBe(false);
	});
});
