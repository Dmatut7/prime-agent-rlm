import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * The shortcut path builds its own ExtensionContext instead of using the runner's, so its `ui`
 * has to come from the runner: bindExtensions installs the dialog-tracking wrapper there, and a
 * fresh context would leave shortcut-opened dialogs uncounted, so the stall watchdog would not
 * pause for them.
 *
 * Scope limit, so the next reader does not assume one test covers the whole property. "A dialog
 * opened through a shortcut pauses the stall watchdog" is a three-link chain: this identity nail
 * (the shortcut context is the runner's), the wiring nail in
 * test/suite/agent-session-ui-dialog-pause.test.ts (a bound dialog open makes an armed watchdog
 * snooze), and the static fact that hasUI() and getUIContext() key off the same field, so a true
 * hasUI() always means the wrapped context. No single test covers the chain, and breaking one
 * link does not redden any one of them alone.
 */
function extract(runnerHasUI: boolean) {
	const tracked = { __which: "tracked", confirm: vi.fn() };
	const fresh = { __which: "fresh", confirm: vi.fn() };
	let received: { ui: unknown; hasUI: boolean } | undefined;
	const runner = {
		getShortcuts: () =>
			new Map([
				[
					"x",
					{
						handler: (ctx: { ui: unknown; hasUI: boolean }) => {
							received = ctx;
						},
					},
				],
			]),
		hasUI: () => runnerHasUI,
		getUIContext: () => tracked,
	};
	const fakeThis = {
		keybindings: { getEffectiveConfig: () => ({}) },
		getLocalSessionHost: () => ({
			getSessionManager: () => ({}),
			getAbortSignal: () => new AbortController().signal,
			getSystemPrompt: () => "",
		}),
		createExtensionUIContext: () => fresh,
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
	// precedent: interactive-mode-status.test.ts calls createExtensionUIContext the same way.
	const proto = InteractiveMode as unknown as {
		prototype: { setupExtensionShortcuts(runner: unknown): void };
	};
	proto.prototype.setupExtensionShortcuts.call(fakeThis, runner);
	const matched = fakeThis.defaultEditor.onExtensionShortcut?.("x");
	return { matched, received: received as { ui: { __which: string }; hasUI: boolean } | undefined, tracked, fresh };
}

describe("InteractiveMode.setupExtensionShortcuts UI context", () => {
	test("hands the shortcut handler the runner's dialog-tracked context", () => {
		const { matched, received, tracked } = extract(true);

		expect(matched).toBe(true);
		expect(received).toBeDefined();
		// Identity, not shape: a freshly built context would also have a confirm member.
		expect(received?.ui).toBe(tracked);
		expect(received?.hasUI).toBe(true);
	});

	test("falls back to a fresh context, and says so, when the runner has no bound UI", () => {
		const { matched, received, fresh } = extract(false);

		expect(matched).toBe(true);
		expect(received?.ui).toBe(fresh);
		expect(received?.hasUI).toBe(false);
	});
});
