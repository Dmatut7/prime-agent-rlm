import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

const identity = (text: string): string => text;

function makeLoader(): { loader: Loader; renders: () => number } {
	let renders = 0;
	const ui = {
		requestRender: () => {
			renders++;
		},
	} as unknown as TUI;
	return { loader: new Loader(ui, identity, identity, "Working"), renders: () => renders };
}

/** Capture the interval the Loader arms, then put the global back. */
function withCapturedInterval<T>(run: () => T): { result: T; timer: NodeJS.Timeout | undefined } {
	const original = globalThis.setInterval;
	let timer: NodeJS.Timeout | undefined;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
		timer = original(...args);
		return timer;
	}) as typeof setInterval;
	try {
		return { result: run(), timer };
	} finally {
		globalThis.setInterval = original;
	}
}

/** Deliberately ref'd: an unref'd wait would let the loop drain before it resolves. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * A Loader owns a repeating interval for as long as it is mounted, and several can be
 * alive at once (working, compaction, retry). Every other long-lived indicator interval
 * in this codebase is unref'd: an overlay nobody stopped must not be what keeps the
 * process alive after the UI is gone.
 */
describe("Loader animation timer", () => {
	it("does not hold the event loop open", () => {
		const { timer, result } = withCapturedInterval(() => makeLoader());
		try {
			assert.ok(timer, "expected the loader to arm an animation interval");
			assert.strictEqual(timer.hasRef(), false);
		} finally {
			result.loader.stop();
		}
	});

	it("keeps animating while mounted and stops on stop()", async () => {
		const { loader, renders } = makeLoader();
		try {
			const before = loader.render(20).join("");
			const rendersBefore = renders();
			await sleep(250);
			const animated = loader.render(20).join("");
			assert.notStrictEqual(animated, before);
			assert.ok(renders() > rendersBefore);

			loader.stop();
			const afterStop = loader.render(20).join("");
			const rendersAtStop = renders();
			await sleep(250);
			assert.strictEqual(loader.render(20).join(""), afterStop);
			assert.strictEqual(renders(), rendersAtStop);
		} finally {
			loader.stop();
		}
	});
});
