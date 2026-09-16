import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Incremental lexing guardrails: while a document streams in, Markdown must
// render exactly what a fresh full re-lex would render (token-level reuse is
// invisible), and per-frame lex cost must stay bounded by the reused prefix
// rather than the whole document.

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FRAGMENTS = [
	"plain paragraph text that wraps at narrow widths",
	"# Heading level one\n\nsecond heading paragraph",
	"## Sub heading with **bold** and *italic* and `code`",
	"- list item one\n- list item two\n  - nested item\n- third item",
	"- list a\n\n    indented continuation after a blank line\n- list b",
	"1. ordered item\n2. another ordered item",
	"> blockquote line one\n> blockquote line two",
	"```typescript\nfunction f(x: number): string {\n\treturn String(x);\n}\n```",
	"```js\nunterminated fence still growing",
	"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
	"Title line\n===",
	"math paragraph $x^2$ inline and $$block$$ math\n\n$$\n\\frac{a}{b}\n$$",
	"bracket math [ y = mx + b ] and paren ( z )",
	"reference usage [alpha] before definition",
	"[alpha]: /defined-later\n\nuses [alpha] after definition",
	"\r\ncrlf paragraph with windows endings\r\nsecond line\r\n",
	"tabbed\tcontent\tline",
	"    indented code block\n    second line",
	"para before lazy\n    lazy continuation arriving later",
	"<div>\nhtml block\n</div>\n",
	"***\n",
	"str ~~strike~~ and ~~broken strike text",
];

function buildDoc(rnd: () => number, blocks: number): string {
	let doc = "";
	for (let i = 0; i < blocks; i++) {
		doc += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)];
		doc += rnd() < 0.8 ? "\n\n" : "\n";
	}
	return doc;
}

function renderLines(text: string, width: number): string[] {
	// A fresh component always lexes in full; this is the full re-lex oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme).render(width);
}

describe("markdown incremental lex equivalence", () => {
	it("streamed frames render identically to a fresh full re-lex", () => {
		const rnd = prng(0x5eed1e);
		for (let docIdx = 0; docIdx < 12; docIdx++) {
			const doc = buildDoc(rnd, 10 + Math.floor(rnd() * 15));
			const widths = [80, 60, 100];
			const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
			const width = widths[docIdx % widths.length];
			for (
				let pos = 0, step = 1 + Math.floor(rnd() * 40);
				pos <= doc.length;
				pos += step, step = 1 + Math.floor(rnd() * 40)
			) {
				const text = doc.slice(0, pos);
				streamed.setText(text);
				const got = streamed.render(width).join("\n");
				const want = renderLines(text, width).join("\n");
				assert.strictEqual(got, want, `doc ${docIdx} frame at length ${pos}`);
			}
			streamed.setText(doc);
			assert.strictEqual(
				streamed.render(width).join("\n"),
				renderLines(doc, width).join("\n"),
				`doc ${docIdx} final frame`,
			);
		}
	});

	it("head and middle edits fall back and still match a full re-lex", () => {
		const doc = buildDoc(prng(0xf11ed), 20);
		const streamed = new Markdown(doc, 1, 0, defaultMarkdownTheme);
		streamed.render(80);
		for (const mutation of [
			`# head edit\n\n${doc}`,
			`${doc.slice(0, Math.floor(doc.length / 2))}**middle insertion**\n\n${doc.slice(Math.floor(doc.length / 2))}`,
			doc.slice(0, Math.floor(doc.length / 3)),
		]) {
			streamed.setText(mutation);
			assert.strictEqual(streamed.render(80).join("\n"), renderLines(mutation, 80).join("\n"));
		}
	});

	it("width changes invalidate cleanly against a full re-lex", () => {
		const doc = buildDoc(prng(0x51d7), 14);
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (const width of [80, 40, 100, 60]) {
			for (let pos = 30; pos <= doc.length; pos += 37) {
				streamed.setText(doc.slice(0, pos));
				assert.strictEqual(
					streamed.render(width).join("\n"),
					renderLines(doc.slice(0, pos), width).join("\n"),
					`width ${width} len ${pos}`,
				);
			}
		}
	});
});

describe("markdown incremental lex cost", () => {
	const SECTION = `## Section heading

Some explanatory paragraph text that wraps across multiple lines when rendered at
typical terminal widths, including **bold**, *italic*, and \`inline code\` spans.

- First list item with enough text to wrap when rendered
- Second list item
  - Nested item one
  - Nested item two
- Third list item

\`\`\`typescript
function example(value: number): string {
	const doubled = value * 2;
	return \`result: \${doubled}\`;
}
\`\`\`

> A blockquote with some content that also wraps when the line is long enough to
> exceed the available width.
`;

	function medianFrameMs(text: string, frames: number, chunk: number): number {
		const streamed = new Markdown(
			text.slice(0, Math.max(1, text.length - frames * chunk)),
			1,
			0,
			defaultMarkdownTheme,
		);
		streamed.render(80);
		const times: number[] = [];
		for (let f = 0; f < frames; f++) {
			streamed.setText(text.slice(0, Math.max(1, text.length - (frames - 1 - f) * chunk)));
			const start = performance.now();
			streamed.render(80);
			times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		return times[Math.floor(times.length / 2)];
	}

	it("streaming append frame cost is bounded by the lex cache, not the document", () => {
		const target = 800_000;
		const sections = Math.ceil(target / SECTION.length);
		let sectioned = "";
		for (let i = 0; i < sections; i++) sectioned += SECTION;
		// Single-paragraph document: no stable block boundary exists, so every
		// frame re-lexes in full regardless of the cache (the linear control).
		const single = `one giant paragraph ${"lorem ipsum dolor sit amet ".repeat(32_000)}`;
		const sectionedMs = medianFrameMs(sectioned, 30, 250);
		const singleMs = medianFrameMs(single, 30, 250);
		// Before incremental lexing both shapes pay the same full re-lex and this
		// ratio is ~1 (red). With reuse the sectioned shape stays bounded.
		assert.ok(
			sectionedMs * 3 < singleMs,
			`sectioned median ${sectionedMs.toFixed(2)}ms should be well under the no-boundary control ${singleMs.toFixed(2)}ms`,
		);
		assert.ok(sectionedMs < 20, `sectioned median ${sectionedMs.toFixed(2)}ms exceeds the absolute bound`);
	});
});
