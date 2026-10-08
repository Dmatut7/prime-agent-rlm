import assert from "node:assert";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.js";
import {
	drainKittyImageTransmits,
	invalidateKittyImageTransmits,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.js";

const theme = { fallbackColor: (text: string) => text };

function restoreCapabilities(): void {
	resetCapabilitiesCache();
	invalidateKittyImageTransmits();
}

describe("Image component", () => {
	it("clamps the image width at narrow render widths instead of emitting degenerate geometry", () => {
		try {
			// width=1 -> width-2 = -1 column budget: the kitty sequence must still
			// carry a sane column count.
			setCapabilities({ images: "kitty", imagePlaceholders: false, trueColor: true, hyperlinks: true });
			const kitty = new Image("AAAA", "image/png", theme, {}, { widthPx: 100, heightPx: 100 });
			const kittyOut = kitty.render(1).join("\n");
			assert.ok(!/c=-/.test(kittyOut), `negative kitty columns in ${JSON.stringify(kittyOut)}`);
			assert.ok(!/c=0[,\x1b]/.test(kittyOut), `zero kitty columns in ${JSON.stringify(kittyOut)}`);

			setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
			const iterm = new Image("AAAA", "image/png", theme, {}, { widthPx: 100, heightPx: 100 });
			const itermOut = iterm.render(1).join("\n");
			assert.ok(!itermOut.includes("width=-"), `negative iterm2 width in ${JSON.stringify(itermOut)}`);
			assert.ok(!itermOut.includes("width=0;"), `zero iterm2 width in ${JSON.stringify(itermOut)}`);
		} finally {
			restoreCapabilities();
		}
	});

	it("re-renders when the terminal capabilities change", () => {
		try {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const image = new Image("AAAA", "image/png", theme, {}, { widthPx: 100, heightPx: 100 });
			const fallback = image.render(40).join("\n");
			assert.ok(fallback.includes("[Image:"), `expected fallback text, got ${JSON.stringify(fallback)}`);

			// A runtime capability flip (probe answered late) must invalidate the
			// cached lines: the same render call now goes through placeholders.
			setCapabilities({ images: "kitty", imagePlaceholders: true, trueColor: true, hyperlinks: true });
			const placeholder = image.render(40).join("\n");
			assert.ok(
				placeholder.includes("\u{10EEEE}"),
				`expected placeholder cells, got ${JSON.stringify(placeholder)}`,
			);
			drainKittyImageTransmits();
		} finally {
			restoreCapabilities();
		}
	});
});
