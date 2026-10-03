import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// List-growth sealing: while a single list streams in as the final block,
// completed items must seal (render) and the lexer must resume from the last
// verified item boundary (split-lex), leaving only the growing tail item live.
// Lists absorb later lines into earlier structure (lazy continuations, partial
// bullets collapsing into the previous item, blank-line/indented absorption,
// loose flips), so every hazard below is pinned character by character against
// a fresh full render.

const chalk = new Chalk({ level: 3 });
const coloredDefaultStyle = { color: (text: string) => chalk.cyan(text) };

function full(text: string, width: number, styled = false): string {
	// A fresh component always lexes and renders in full; this is the oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined)
		.render(width)
		.join("\n");
}

function assertStreamedIdentity(doc: string, width: number, step: number, styled = false): void {
	const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined);
	for (let pos = 0; pos <= doc.length; pos += step) {
		const text = doc.slice(0, pos);
		streamed.setText(text);
		assert.strictEqual(streamed.render(width).join("\n"), full(text, width, styled), `frame at ${pos}`);
	}
	streamed.setText(doc);
	assert.strictEqual(streamed.render(width).join("\n"), full(doc, width, styled), "final frame");
}

// Coarse steps while the pad streams in, single characters once the tail
// approaches so every partial-marker/absorption state is crossed mid-flight.
function assertStreamedIdentityCoarseFine(doc: string, width: number, styled = false): void {
	const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined);
	const fineFrom = Math.max(0, doc.length - 200);
	let pos = 0;
	while (pos < doc.length) {
		pos = Math.min(doc.length, pos + (pos < fineFrom ? 97 : 1));
		const text = doc.slice(0, pos);
		streamed.setText(text);
		assert.strictEqual(streamed.render(width).join("\n"), full(text, width, styled), `frame at ${pos}`);
	}
}

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
const PAD_ITEM = (i: number) => `- pad item number ${i} with enough plain prose words to fill out the line`;
// ~5k chars of list: over the 4096 split bootstrap threshold.
const PAD = Array.from({ length: 60 }, (_, i) => PAD_ITEM(i)).join("\n");

describe("markdown list growth sealing identity", () => {
	it("plain unordered list, char by char", () => {
		const doc = Array.from({ length: 6 }, (_, i) => `- item ${i} text`).join("\n");
		assertStreamedIdentity(doc, 80, 1);
	});

	it("ordered list across the two-digit rollover", () => {
		const doc = Array.from({ length: 12 }, (_, i) => `${i + 1}. ordered item ${i}`).join("\n");
		assertStreamedIdentity(doc, 80, 1);
	});

	it("ordered list starting at 3", () => {
		assertStreamedIdentity("3. third\n4. fourth\n5. fifth\n6. sixth\n", 80, 1);
	});

	it("partial bullet gains a non-space and absorbs into the previous item", () => {
		// "- beta\n-" is a trailing empty item; appending "g" turns "-g" into a lazy
		// continuation of beta, collapsing the item count. The seal must drop.
		assertStreamedIdentity("- alpha\n- beta\n-gamma tail\n- delta\n", 80, 1);
	});

	it("partial ordered marker becomes a decimal", () => {
		assertStreamedIdentity("1. alpha\n2. beta\n1.5 tail\n3. delta\n", 80, 1);
	});

	it("lazy continuation lines between items", () => {
		assertStreamedIdentity("- alpha\ncontinued here\n- beta\nmore continuation\n- gamma\n", 80, 1);
	});

	it("blank line then indented block absorbs into the growing item", () => {
		assertStreamedIdentity("- alpha\n- beta\n\n    absorbed block\n- gamma\n- delta\n", 80, 1);
	});

	it("loose flip between items mid-stream", () => {
		// The blank line re-types every item (text -> paragraph tokens) and extends
		// the previous item's raw; both seals must re-verify against that.
		assertStreamedIdentity("- alpha\n- beta\n- gamma\n\n- delta\n- epsilon\n", 80, 1);
	});

	it("multi-paragraph item interior", () => {
		assertStreamedIdentity("- alpha\n\n  second paragraph\n- beta\n- gamma\n", 80, 1);
	});

	it("nested list grows, then sibling items follow", () => {
		assertStreamedIdentity("- alpha\n  - n1\n  - n2\n- beta\n  - n3\n- gamma\n", 80, 1);
	});

	it("task list items", () => {
		assertStreamedIdentity("- [ ] todo one\n- [x] done two\n- [ ] todo three\n- plain four\n", 80, 1);
	});

	it("fence inside an item, then more items", () => {
		assertStreamedIdentity("- ```\n  code line\n  ```\n- beta\n- gamma\n", 80, 1);
	});

	it("unterminated fence in an earlier item does not swallow later bullets", () => {
		assertStreamedIdentity("- ```\n- beta\n- gamma\n- delta\n", 80, 1);
	});

	it("marker change splits the list mid-stream", () => {
		assertStreamedIdentity("- alpha\n- beta\n+ plus item\n- back to dash\n", 80, 1);
		assertStreamedIdentity("1. one\n2. two\n3) paren\n4. dot again\n", 80, 1);
	});

	it("hr-like lines after items", () => {
		assertStreamedIdentity("- alpha\n- beta\n---\n- gamma\n", 80, 1);
		assertStreamedIdentity("- alpha\n- beta\n- - -\n- delta\n", 80, 1);
	});

	it("list ends with a blank line, then a paragraph grows", () => {
		assertStreamedIdentity("- alpha\n- beta\n\ntrailing paragraph here\n", 80, 1);
	});

	it("inline constructs and hazard chars inside items", () => {
		assertStreamedIdentity(
			"- **bold** and `code` and $x+y$\n- price $5 and a_b_c\n- [link](https://example.com) tail\n- ~~struck~~ end\n",
			80,
			1,
		);
	});

	it("reference definition arrives after the list", () => {
		assertStreamedIdentity("- uses [alpha] here\n- beta\n- gamma\n\n[alpha]: /defined-later\n", 80, 1);
	});

	it("wide chars and emoji in items", () => {
		assertStreamedIdentity("- 汉字漢字かな item 🎉\n- mixed ascii tail 🚀🚀\n- 漢字 tail\n", 60, 1);
	});

	it("long wrapping items at narrow width", () => {
		const doc = Array.from({ length: 5 }, (_, i) => `- item ${i} ${WORDS.repeat(2)}`).join("\n");
		assertStreamedIdentity(doc, 36, 1);
	});

	it("items with indented continuation lines", () => {
		assertStreamedIdentity("- alpha\n  continued second line\n  third line\n- beta\n- gamma\n", 80, 1);
	});

	it("styled default text over a growing list", () => {
		const doc = Array.from({ length: 6 }, (_, i) => `- item ${i} with **bold ${i}** tail`).join("\n");
		assertStreamedIdentity(doc, 80, 1, true);
	});

	it("long list past the split threshold, char-by-char tail", () => {
		const doc = `${PAD}\n- tail one grows\n- tail two grows\n- tail three final`;
		assertStreamedIdentityCoarseFine(doc, 80);
		assertStreamedIdentityCoarseFine(doc, 90, true);
	});

	it("split-engaged: partial bullet and decimal marker at the tail", () => {
		assertStreamedIdentityCoarseFine(`${PAD}\n- tail\n-gobbled\n- back\n`, 80);
		assertStreamedIdentityCoarseFine(`${PAD}\n1.5 decimal tail\n- after\n`, 80);
	});

	it("split-engaged: loose flip and blank-plus-indent absorption at the tail", () => {
		assertStreamedIdentityCoarseFine(`${PAD}\n- tail one\n\n- after blank\n- more\n`, 80);
		assertStreamedIdentityCoarseFine(`${PAD}\n- tail one\n\n    absorbed indented\n- after\n`, 80);
	});

	it("split-engaged: list completes, then a paragraph grows", () => {
		assertStreamedIdentityCoarseFine(`${PAD}\n\nparagraph after the list grows here\n`, 80);
	});

	it("split-engaged: reference definition at the tail", () => {
		assertStreamedIdentityCoarseFine(`- uses [alpha] here\n${PAD}\n\n[alpha]: /defined-later\n`, 80);
	});

	it("split-engaged: trailing whitespace at end of text", () => {
		// A stream tail landing right after a space makes marked rewrite the list
		// raw's last char to "\n" (one trailing space/tab) or split a space token
		// off (two or more). Both shapes must stay identity-exact while engaged.
		assertStreamedIdentityCoarseFine(`${PAD}\n- tail item with several words `, 80);
		assertStreamedIdentityCoarseFine(`${PAD}\n- tail item with double space  `, 80);
		assertStreamedIdentityCoarseFine(`${PAD}\n- tabbed\ttail item `, 80);
	});

	it("split-engaged: marker change at the tail", () => {
		assertStreamedIdentityCoarseFine(`${PAD}\n+ plus marker\n- dash again\n`, 80);
		assertStreamedIdentityCoarseFine(`${PAD}\n1) paren marker\n- dash again\n`, 80);
	});

	it("head edit and truncation while the seal and split are engaged", () => {
		const doc = `${PAD}\n- tail item\n`;
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (let pos = 2000; pos <= doc.length; pos += 211) {
			streamed.setText(doc.slice(0, pos));
			streamed.render(80);
		}
		for (const mutation of [
			`# head edit\n\n${doc}`,
			doc.slice(500),
			doc.slice(0, 1500),
			`${doc.slice(0, 1200)}- replaced tail item\n`,
		]) {
			streamed.setText(mutation);
			assert.strictEqual(streamed.render(80).join("\n"), full(mutation, 80));
		}
	});

	it("width changes and invalidate while the seal and split are engaged", () => {
		const doc = `${PAD}\n- tail item\n`;
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (const width of [80, 40, 100, 60]) {
			for (let pos = 2000; pos <= doc.length; pos += 251) {
				streamed.setText(doc.slice(0, pos));
				assert.strictEqual(
					streamed.render(width).join("\n"),
					full(doc.slice(0, pos), width),
					`width ${width} len ${pos}`,
				);
			}
		}
		streamed.setText(doc);
		streamed.render(80);
		streamed.invalidate();
		assert.strictEqual(streamed.render(80).join("\n"), full(doc, 80));
	});

	it("PI_MARKDOWN_SPLIT_LEX=0 disables the list split without changing output", () => {
		const previous = process.env.PI_MARKDOWN_SPLIT_LEX;
		process.env.PI_MARKDOWN_SPLIT_LEX = "0";
		try {
			assertStreamedIdentityCoarseFine(`${PAD}\n- tail one\n- tail two\n`, 80);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_MARKDOWN_SPLIT_LEX;
			} else {
				process.env.PI_MARKDOWN_SPLIT_LEX = previous;
			}
		}
	});
});

describe("markdown list growth sealing work bound", () => {
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

	it("a streaming append frame re-renders only the growing tail item of a long list", () => {
		// Plain items hit exactly one theme function: listBullet (one call per
		// rendered item). The frame below completes item 40 and grows a new
		// partial tail item; the seal always keeps the last item live, so the
		// frame renders the previously live item, the newly completed item, and
		// the growing tail - never the sealed prefix.
		const line = (i: number) => `- item ${i} with plain prose text that keeps the item realistic`;
		const { theme, calls } = countingMarkdownTheme();
		const streamed = new Markdown("", 1, 0, theme);
		let text = "";
		for (let i = 0; i < 40; i++) {
			text += `${line(i)}\n`;
			streamed.setText(text);
			streamed.render(100);
		}
		const single = countingMarkdownTheme();
		new Markdown(`${line(0)}\n`, 1, 0, single.theme).render(100);
		const perItem = single.calls();
		assert.ok(perItem > 0, "probe must observe theme calls for one item");
		const before = calls();
		text += `${line(40)}\n- partial tail`;
		streamed.setText(text);
		streamed.render(100);
		const frameCalls = calls() - before;
		assert.ok(
			frameCalls <= 3 * perItem,
			`append frame spent ${frameCalls} theme calls; the sealed items must not re-render (at most ${3 * perItem})`,
		);
	});

	it("PI_MARKDOWN_LINE_SEAL=0 restores the pre-seal full re-render per frame", () => {
		const previous = process.env.PI_MARKDOWN_LINE_SEAL;
		process.env.PI_MARKDOWN_LINE_SEAL = "0";
		try {
			const line = (i: number) => `- item ${i} with plain prose text that keeps the item realistic`;
			const { theme, calls } = countingMarkdownTheme();
			const streamed = new Markdown("", 1, 0, theme);
			let text = "";
			for (let i = 0; i < 40; i++) {
				text += `${line(i)}\n`;
				streamed.setText(text);
				streamed.render(100);
			}
			const before = calls();
			text += `${line(40)}\n- partial tail`;
			streamed.setText(text);
			streamed.render(100);
			const frameCalls = calls() - before;
			assert.ok(frameCalls >= 40, `kill-switch frame spent only ${frameCalls} theme calls`);
			const want = new Markdown(text, 1, 0, defaultMarkdownTheme).render(100).join("\n");
			assert.strictEqual(streamed.render(100).join("\n"), want);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_MARKDOWN_LINE_SEAL;
			} else {
				process.env.PI_MARKDOWN_LINE_SEAL = previous;
			}
		}
	});
});

describe("markdown list growth fuzz identity", () => {
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
		"- plain item words keep going\n",
		"- **bold item** and `code span`\n",
		"- [ ] task item\n",
		"- [x] done item\n",
		"1. ordered item\n",
		"2. second ordered\n",
		"  - nested item\n",
		"  indented continuation\n",
		"\n",
		"    indented block line\n",
		"- ",
		"x",
		"-",
		"1.",
		"5",
		"- item with $5 and a_b hazards\n",
		"- 漢字 emoji 🎉 item\n",
	];

	it("random list-shaped documents render identically at every frame", () => {
		const rnd = prng(0x1157ea1);
		assert.ok(FRAGMENTS.length > 0, "fuzz corpus must not be empty");
		for (let docIdx = 0; docIdx < 8; docIdx++) {
			// Two docs past the split threshold, the rest in the small render-seal
			// regime so both code paths are fuzzed.
			const target = docIdx < 2 ? 4300 + Math.floor(rnd() * 400) : 200 + Math.floor(rnd() * 700);
			let doc = "";
			while (doc.length < target) {
				doc += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)];
			}
			const width = [80, 60, 100, 44][docIdx % 4]!;
			const styled = docIdx % 2 === 0;
			const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined);
			let pos = 0;
			while (pos < doc.length) {
				pos = Math.min(doc.length, pos + 1 + Math.floor(rnd() * 53));
				const text = doc.slice(0, pos);
				streamed.setText(text);
				assert.strictEqual(
					streamed.render(width).join("\n"),
					full(text, width, styled),
					`doc ${docIdx} frame at ${pos}`,
				);
			}
		}
	});
});
