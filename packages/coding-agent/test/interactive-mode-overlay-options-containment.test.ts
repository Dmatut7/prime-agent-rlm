import { Container, type OverlayOptions } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type ShowExtensionCustom = (
	this: ModeFake,
	factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
	options?: {
		overlay?: boolean;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
	},
) => Promise<unknown>;

const showExtensionCustom = (InteractiveMode.prototype as unknown as { showExtensionCustom: ShowExtensionCustom })
	.showExtensionCustom;

/**
 * W9-A lane, audit item 8.5: an extension's overlayOptions factory must not be
 * able to take down the render chain.
 *
 * The resolver handed to ui.showOverlay is re-evaluated by the TUI on every
 * render, key routing, and mouse check. The factory inside it is extension
 * code: before it was only evaluated once at open time inside a promise chain
 * whose catch routed the error to the extension error surface. Now it runs
 * detached, so a throw here lands in doRender's process.nextTick and kills the
 * client process. The resolver must contain the throw, degrade to the last
 * good snapshot, and report once per open.
 */

function overlayFake(): { mode: ModeFake; showOverlay: ReturnType<typeof vi.fn> } {
	const showOverlay = vi.fn(() => ({ hide: vi.fn() }));
	const mode: ModeFake = {
		editor: { getText: vi.fn(() => ""), setText: vi.fn(), clearHistory: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		ui: { showOverlay, requestRender: vi.fn(), setFocus: vi.fn() },
		extensionCustomOverlays: new Set(),
		chatContainer: new Container(),
		activeExtensionDialog: undefined,
		cancelActiveExtensionDialog: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, showOverlay };
}

/** Open an overlay whose factory returns a trivial component; capture the resolver the TUI got. */
async function openOverlay(
	{ mode, showOverlay }: { mode: ModeFake; showOverlay: ReturnType<typeof vi.fn> },
	overlayOptions: OverlayOptions | (() => OverlayOptions),
): Promise<() => OverlayOptions | undefined> {
	const component = { render: () => [], invalidate: () => {} };
	void showExtensionCustom.call(mode, () => component, { overlay: true, overlayOptions });
	await vi.waitFor(() => expect(showOverlay).toHaveBeenCalled());
	const resolver = showOverlay.mock.calls[0]?.[1] as () => OverlayOptions | undefined;
	expect(typeof resolver).toBe("function");
	return resolver;
}

function chatText(mode: ModeFake): string {
	return stripAnsi((mode.chatContainer as Container).render(120).join("\n"));
}

beforeAll(() => {
	initTheme("dark");
});

describe("an extension overlayOptions factory that throws is contained", () => {
	it("degrades to the last good snapshot and never rethrows into the render chain", async () => {
		const fake = overlayFake();
		let calls = 0;
		const resolver = await openOverlay(fake, () => {
			calls += 1;
			if (calls === 1) return { width: 40 };
			throw new Error("boom");
		});

		// First evaluation succeeds and is remembered.
		expect(resolver()).toEqual({ width: 40 });

		// The TUI re-evaluates per render and per keypress: a throwing factory
		// must not escape the resolver, and the overlay keeps its last geometry.
		for (let i = 0; i < 5; i += 1) {
			expect(() => resolver()).not.toThrow();
			expect(resolver()).toEqual({ width: 40 });
		}

		// The failure is reported once through the extension error surface, not
		// once per frame.
		expect(chatText(fake.mode)).toContain('Extension "ui.custom overlayOptions" error: boom');
		const rowsWithBoom = chatText(fake.mode)
			.split("\n")
			.filter((line) => line.includes("boom")).length;
		expect(rowsWithBoom).toBe(1);
	});

	it("resolves to undefined when the factory never succeeded", async () => {
		const fake = overlayFake();
		const resolver = await openOverlay(fake, () => {
			throw new Error("always broken");
		});
		expect(() => resolver()).not.toThrow();
		expect(resolver()).toBeUndefined();
		expect(chatText(fake.mode)).toContain("always broken");
	});

	it("still evaluates a healthy factory live and passes static options through", async () => {
		const fake = overlayFake();
		let width = 40;
		const resolver = await openOverlay(fake, () => ({ width }));
		expect(resolver()).toEqual({ width: 40 });
		width = 60;
		expect(resolver()).toEqual({ width: 60 });
		expect(chatText(fake.mode)).toBe("");

		const staticMode = overlayFake();
		const staticResolver = await openOverlay(staticMode, { width: 12 });
		expect(staticResolver()).toEqual({ width: 12 });
	});
});
