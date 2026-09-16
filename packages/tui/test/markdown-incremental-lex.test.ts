import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
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

	it("re-renders a lazy continuation whose raw text is unchanged (K3 blockCache identity)", () => {
		// marked gives the paragraph the same raw before and after the bare "-"
		// line gains content, but a different text (the lazy line's indentation
		// is stripped while the trailing "-" line truncates it). A raw-keyed
		// block cache serves the stale stripped rendering forever; the cache
		// must key on the token object itself, which the re-lexed tail replaces.
		const doc = "***\n\n\npara before lazy\n    lazy continuation arriving later\n- ";
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (let pos = 1; pos <= doc.length; pos++) {
			streamed.setText(doc.slice(0, pos));
			assert.strictEqual(
				streamed.render(80).join("\n"),
				renderLines(doc.slice(0, pos), 80).join("\n"),
				`frame at length ${pos}`,
			);
		}
		streamed.setText(`${doc}l`);
		const got = streamed.render(80).join("\n");
		assert.strictEqual(got, renderLines(`${doc}l`, 80).join("\n"));
		// The stale rendering is not self-healing: one more append must still
		// match a full re-lex.
		streamed.setText(`${doc}l?`);
		assert.strictEqual(streamed.render(80).join("\n"), renderLines(`${doc}l?`, 80).join("\n"));
	});

	it("re-renders reused tokens when only the width changes (slot identity guard)", () => {
		// The lex cache reuses the same token objects across widths, so a slot
		// cache that keyed only on the token identity would replay 80-column
		// lines at 40 columns. Width must be part of the hit condition.
		const doc = buildDoc(prng(0x5107), 12);
		const streamed = new Markdown(doc, 1, 0, defaultMarkdownTheme);
		assert.strictEqual(streamed.render(80).join("\n"), renderLines(doc, 80).join("\n"));
		assert.strictEqual(streamed.render(40).join("\n"), renderLines(doc, 40).join("\n"));
		assert.strictEqual(streamed.render(80).join("\n"), renderLines(doc, 80).join("\n"));
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

describe("markdown incremental lex per-frame render work", () => {
	// Deterministic work counts replace millisecond thresholds: counts do not
	// drift with the runner, so a red failure always means real per-frame work
	// regressed, never that the machine is busy. (Pre-change medians, kept as
	// reference data only: an 800k-char document cost ~6.0ms per streaming frame,
	// ~2.4ms of it in cache-key construction over the whole document.)

	function countingMarkdownTheme(): { theme: MarkdownTheme; calls(): number } {
		let count = 0;
		const wrap =
			(fn: (text: string) => string) =>
			(text: string): string => {
				count++;
				return fn(text);
			};
		const theme: MarkdownTheme = {
			heading: wrap(defaultMarkdownTheme.heading),
			link: wrap(defaultMarkdownTheme.link),
			linkUrl: wrap(defaultMarkdownTheme.linkUrl),
			code: wrap(defaultMarkdownTheme.code),
			codeBlock: wrap(defaultMarkdownTheme.codeBlock),
			codeBlockBorder: wrap(defaultMarkdownTheme.codeBlockBorder),
			quote: wrap(defaultMarkdownTheme.quote),
			quoteBorder: wrap(defaultMarkdownTheme.quoteBorder),
			hr: wrap(defaultMarkdownTheme.hr),
			listBullet: wrap(defaultMarkdownTheme.listBullet),
			bold: wrap(defaultMarkdownTheme.bold),
			italic: wrap(defaultMarkdownTheme.italic),
			strikethrough: wrap(defaultMarkdownTheme.strikethrough),
			underline: wrap(defaultMarkdownTheme.underline),
		};
		return { theme, calls: () => count };
	}

	it("a streaming append frame re-renders only the changing tail blocks, not the prefix", () => {
		// Every block is a blank-line-separated heading, so each boundary is a
		// stable lex cut and the prefix blocks are reused verbatim.
		const blocks = 40;
		const heading = (i: number) => `## heading ${i}`;
		const docAt = (count: number) => Array.from({ length: count }, (_, i) => heading(i)).join("\n\n");
		const { theme, calls } = countingMarkdownTheme();
		const streamed = new Markdown("", 1, 0, theme);
		for (let i = 1; i <= blocks; i++) {
			streamed.setText(docAt(i));
			streamed.render(80);
		}
		// One block's render cost, measured through the same probe on a
		// single-block component: an append frame may re-render only the block
		// that stopped being final plus the newly appended block, never the
		// accumulated prefix (a cache miss there re-renders all `blocks`).
		const single = countingMarkdownTheme();
		new Markdown(heading(0), 1, 0, single.theme).render(80);
		const perBlock = single.calls();
		assert.ok(perBlock > 0, "probe must observe theme calls for one block");
		const before = calls();
		streamed.setText(`${docAt(blocks)}\n\n${heading(blocks)}`);
		streamed.render(80);
		const frameCalls = calls() - before;
		assert.ok(
			frameCalls <= 2 * perBlock,
			`append frame spent ${frameCalls} theme calls; at most the last block plus the new block (${2 * perBlock}) may re-render`,
		);
	});
});

describe("markdown incremental lex with a transform", () => {
	// A stand-in with the production mermaid transform's cost shape: it reads
	// the whole document on every call, depends on availableWidth, and records
	// its invocations. (The production transform itself is not incremental; the
	// tests below pin that current cost, they do not bound it.)
	const DOC = [
		"intro paragraph explaining the diagram below",
		"a DIAGRAM marker line",
		"outro paragraph after the diagram, also mentioning DIAGRAM once",
	].join("\n\n");

	function recordingTransform(): {
		calls: { text: string; width: number }[];
		transform: (markdown: string, availableWidth: number) => string;
	} {
		const calls: { text: string; width: number }[] = [];
		const transform = (markdown: string, availableWidth: number): string => {
			calls.push({ text: markdown, width: availableWidth });
			return markdown.replaceAll("DIAGRAM", `w${availableWidth}`);
		};
		return { calls, transform };
	}

	function freshRender(
		text: string,
		width: number,
		transform: (markdown: string, availableWidth: number) => string,
	): string {
		return new Markdown(text, 1, 0, defaultMarkdownTheme, undefined, { transform }).render(width).join("\n");
	}

	it("streamed frames with a transform render identically to a fresh full render", () => {
		const { transform } = recordingTransform();
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { transform });
		for (const width of [80, 40, 60]) {
			for (let pos = 1; pos <= DOC.length; pos += 7) {
				const text = DOC.slice(0, pos);
				streamed.setText(text);
				assert.strictEqual(
					streamed.render(width).join("\n"),
					freshRender(text, width, transform),
					`width ${width} frame at length ${pos}`,
				);
			}
		}
	});

	it("runs the transform once per streaming frame, over the full text (current cost)", () => {
		const { calls, transform } = recordingTransform();
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { transform });
		for (let pos = 1; pos <= DOC.length; pos += 7) {
			const text = DOC.slice(0, pos);
			streamed.setText(text);
			const before = calls.length;
			streamed.render(80);
			assert.strictEqual(calls.length - before, 1, `one call for the frame at length ${pos}`);
			assert.strictEqual(calls.at(-1)?.text, text, `frame at length ${pos} must transform the full text`);
			assert.strictEqual(calls.at(-1)?.width, 78);
		}
		// An unchanged re-render is served from the whole-result cache without
		// re-running the transform.
		const before = calls.length;
		streamed.render(80);
		assert.strictEqual(calls.length, before);
	});
});
