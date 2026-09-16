import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// OSC 8 probe: with hyperlinks the renderer wraps the link text in
// "\x1b]8;;url\x1b\...\x1b]8;;\x1b\"; without them it falls back to
// "text (url)". Both forms are in the same line, so a plain includes() check
// separates capability-blind stale caches from a re-render.
const OSC8 = "\x1b]8;;";

const DOC = "see [x](http://example.com/page) here\n\ntrailing text that keeps growing while the stream continues";

function freshRender(text: string, width: number): string {
	return new Markdown(text, 1, 0, defaultMarkdownTheme).render(width).join("\n");
}

describe("markdown capability flip", () => {
	it("re-renders cached blocks after hyperlinks turn on mid-stream", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
			// Stream in chunks so prefix blocks are cached under the fallback form.
			for (let pos = 1; pos <= DOC.length; pos += 9) {
				streamed.setText(DOC.slice(0, pos));
				streamed.render(80);
			}
			assert.ok(!streamed.render(80).join("\n").includes(OSC8));
			setCapabilities({ ...getCapabilities(), hyperlinks: true });
			// The link block's raw text is unchanged by this append; a
			// capability-blind block cache would keep serving the fallback lines.
			streamed.setText(`${DOC} tail`);
			const got = streamed.render(80).join("\n");
			assert.ok(got.includes(OSC8), "frame after the flip must emit OSC 8 hyperlinks");
			assert.strictEqual(got, freshRender(`${DOC} tail`, 80));
			// Positive control: a fresh component under the flipped capabilities
			// emits OSC 8, proving the probe detects the hyperlink form at all.
			assert.ok(freshRender(`${DOC} tail`, 80).includes(OSC8));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("re-renders the whole-result cache after a capability flip (same text, same width)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const md = new Markdown(DOC, 1, 0, defaultMarkdownTheme);
			const before = md.render(80).join("\n");
			assert.ok(!before.includes(OSC8));
			setCapabilities({ ...getCapabilities(), hyperlinks: true });
			// No setText: the whole-result fast path (cachedText === text &&
			// cachedWidth === width) is the only thing that can serve the stale
			// pre-flip lines here.
			const after = md.render(80).join("\n");
			assert.ok(after.includes(OSC8), "second render at the same width must not replay the cached pre-flip form");
			assert.strictEqual(after, freshRender(DOC, 80));
			// Positive control: the probe can detect the hyperlink form.
			assert.ok(freshRender(DOC, 80).includes(OSC8));
		} finally {
			resetCapabilitiesCache();
		}
	});
});
