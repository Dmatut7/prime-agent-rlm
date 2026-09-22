import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Flip probe: the renderer now always emits OSC 8 wrappers (unsupported
// terminals consume unknown OSC silently, so labeled links stay clickable in
// the fallback form - ENG-6126). The visible difference between the two
// capability forms is the URL fallback: hyperlinks off renders
// "text (url)" beside the wrapper, hyperlinks on renders the wrapper alone.
// Probing both the wrapper and the visible URL separates capability-blind
// stale caches from a re-render.
const OSC8 = "\x1b]8;;";
const URL_FALLBACK = "(http://example.com/page)";

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
			assert.ok(
				streamed.render(80).join("\n").includes(URL_FALLBACK),
				"pre-flip render must show the URL fallback form",
			);
			setCapabilities({ ...getCapabilities(), hyperlinks: true });
			// The link block's raw text is unchanged by this append; a
			// capability-blind block cache would keep serving the fallback lines.
			streamed.setText(`${DOC} tail`);
			const got = streamed.render(80).join("\n");
			assert.ok(got.includes(OSC8), "frame after the flip must emit OSC 8 hyperlinks");
			assert.ok(!got.includes(URL_FALLBACK), "frame after the flip must drop the visible URL fallback");
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
			assert.ok(before.includes(URL_FALLBACK), "pre-flip render must show the URL fallback form");
			setCapabilities({ ...getCapabilities(), hyperlinks: true });
			// No setText: the whole-result fast path (cachedText === text &&
			// cachedWidth === width) is the only thing that can serve the stale
			// pre-flip lines here.
			const after = md.render(80).join("\n");
			assert.ok(after.includes(OSC8), "second render at the same width must not replay the cached pre-flip form");
			assert.ok(!after.includes(URL_FALLBACK), "post-flip render must drop the visible URL fallback");
			assert.strictEqual(after, freshRender(DOC, 80));
			// Positive control: the probe can detect the hyperlink form.
			assert.ok(freshRender(DOC, 80).includes(OSC8));
		} finally {
			resetCapabilitiesCache();
		}
	});
});
