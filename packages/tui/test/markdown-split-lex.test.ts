import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Split-lex guardrails: a growing final paragraph past the bootstrap threshold
// is lexed only from a verified inline cut, splicing the fresh tail onto the
// cached prefix tokens. Every frame must render exactly what a fresh full
// re-lex renders - including while the traps below re-type the tail (setext
// absorption, table delimiter promotion, html/indented interruption, inline
// constructs spanning the cut). The traps live at the end of a >4k clean pad
// so the split is engaged when they arrive.

const chalk = new Chalk({ level: 3 });
const coloredDefaultStyle = { color: (text: string) => chalk.cyan(text) };

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
// 4300 chars of delimiter-free prose: over the 4096 bootstrap threshold.
const PAD = WORDS.repeat(Math.ceil(4300 / WORDS.length)).slice(0, 4300);

function full(text: string, width: number, styled: boolean): string {
	// A fresh component always lexes and renders in full; this is the oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined)
		.render(width)
		.join("\n");
}

function assertStreamedIdentity(doc: string, width: number, styled = false): void {
	const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, styled ? coloredDefaultStyle : undefined);
	// Coarse steps while the pad streams in, single characters once the
	// interesting tail approaches so every trap shape is crossed mid-flight.
	const fineFrom = Math.max(0, doc.length - 160);
	let pos = 0;
	while (pos < doc.length) {
		pos = Math.min(doc.length, pos + (pos < fineFrom ? 97 : 1));
		const text = doc.slice(0, pos);
		streamed.setText(text);
		assert.strictEqual(streamed.render(width).join("\n"), full(text, width, styled), `frame at ${pos}`);
	}
}

describe("markdown split-lex streaming identity", () => {
	it("plain growing paragraph past the threshold", () => {
		assertStreamedIdentity(PAD, 100);
		assertStreamedIdentity(PAD, 100, true);
	});

	it("growing single line (no newlines) with late constructs", () => {
		const doc = `${PAD.replaceAll("\n", " ")} then **bold words** and \`code span\` and www.example.com plus a@b.com tail`;
		assertStreamedIdentity(doc, 90);
		assertStreamedIdentity(doc, 60, true);
	});

	it("setext underline arrival re-types the engaged split", () => {
		assertStreamedIdentity(`${PAD}\n===`, 80);
		assertStreamedIdentity(`${PAD}\n---`, 80, true);
		assertStreamedIdentity(`${PAD}\n-`, 80);
	});

	it("table delimiter arrival promotes the header line", () => {
		assertStreamedIdentity(`${PAD}\n| a | b |\n|---|---|\n| 1 | 2 |`, 80);
		assertStreamedIdentity(`${PAD}\nintro | header\n:---|---:\n| 1 | 2 |`, 80, true);
	});

	it("html and indented lines interrupt from the tail", () => {
		assertStreamedIdentity(`${PAD}\n<div>block</div>\nmore text`, 80);
		assertStreamedIdentity(`${PAD}\n    indented continuation\nline three`, 80);
	});

	it("list, heading, fence, hr, blockquote, math block interrupts", () => {
		assertStreamedIdentity(`${PAD}\n- item one\n- item two`, 80);
		assertStreamedIdentity(`${PAD}\n# heading`, 80);
		assertStreamedIdentity(`${PAD}\n\`\`\`ts\nconst x = 1;\n\`\`\`\nafter`, 80);
		assertStreamedIdentity(`${PAD}\n***\nafter`, 80);
		assertStreamedIdentity(`${PAD}\n> quoted line\n> second`, 80);
		assertStreamedIdentity(`${PAD}\n$$x + y$$\nafter math`, 80, true);
	});

	it("reference definition at a line start falls back", () => {
		assertStreamedIdentity(`${PAD}\n[x]: /defined-later and more`, 80);
		assertStreamedIdentity(`uses [alpha] ${PAD}\n\n[alpha]: /later`, 80);
	});

	it("inline constructs spanning the cut boundary", () => {
		assertStreamedIdentity(`${PAD} **bold grows\nacross lines** tail`, 80);
		assertStreamedIdentity(`${PAD} \`code\ngoes\nwide\` tail`, 80, true);
		assertStreamedIdentity(`${PAD} [link text\nspanning](https://example.com) tail`, 80);
		assertStreamedIdentity(`${PAD} ~~struck\nacross~~ tail`, 80);
		assertStreamedIdentity(`${PAD} $x +\ny = z$ tail`, 80);
	});

	it("math delimiters spanning the cut boundary", () => {
		// An unterminated \( or \[ lexes as an escape token, not a text token, so
		// the delimiter scan alone cannot keep the cut ahead of it; a cut inside
		// the formula would leave the closer unmatched in the tail for good.
		assertStreamedIdentity(`${PAD} \\(x^2 + y^2 = z^2\\) tail words`, 80);
		assertStreamedIdentity(`${PAD} \\(x^2 +\ny^2 = z^2\\) tail words`, 80, true);
		assertStreamedIdentity(`${PAD} \\[x^2 + y^2\\] tail words`, 80);
		assertStreamedIdentity(`${PAD} price $5 and \\(a\\) and \\[b\\] mixed`, 80, true);
	});

	it("odd backtick in the tail re-typing prefix emphasis falls back", () => {
		// marked's codespan masking covers the whole paragraph text, so a dangling
		// backtick after the cut can un-type an emphasis pair inside the verified
		// prefix; those frames must fall back to a full lex.
		assertStreamedIdentity(`${PAD} \`zx\`\`*e\`*e* ghgh\nx\` tail \`end\` done`, 80);
		assertStreamedIdentity(`${PAD} \`zx\`\`*e\`*e* ghgh\nx\` tail \`end\` done`, 80, true);
	});

	it("late closer for an early unmatched opener", () => {
		// The early `*` poisons split advancement past it; identity must hold
		// through the frame where the closer re-types the whole prefix.
		assertStreamedIdentity(`*unmatched early ${PAD}\nmore plain\nfinally* closed`, 80);
		assertStreamedIdentity(`price $5 and _under_score ${PAD} and a_late_closer here`, 80, true);
	});

	it("autolink, email and entity growth at the cut", () => {
		assertStreamedIdentity(`${PAD} see www.example.com and more words after`, 80);
		assertStreamedIdentity(`${PAD} mail someone@example.com then text`, 80);
		assertStreamedIdentity(`${PAD} a &amp; b and &copy; entities`, 80, true);
	});

	it("hard breaks and backslash breaks in the tail", () => {
		assertStreamedIdentity(`${PAD} word  \nnext line\nthird  \nfourth`, 80);
		assertStreamedIdentity(`${PAD} word\\\nnext`, 80, true);
	});

	it("split after a stable block boundary in a multi-block document", () => {
		assertStreamedIdentity(`## title\n\n${PAD}`, 90);
		assertStreamedIdentity(`para one\n\npara two\n\n${PAD}`, 90, true);
	});

	it("unstable middle block before the paragraph never splits", () => {
		// The list keeps the block-cache cut before it, so paraFrom !== baseCut
		// and the split must stay disengaged; identity still holds.
		assertStreamedIdentity(`- item a\n- item b\n\n${PAD}`, 80);
		assertStreamedIdentity(`<div>html</div>\n\n${PAD}`, 80, true);
	});

	it("paragraph completes into a blank line, then a new one grows", () => {
		assertStreamedIdentity(`${PAD}\n\nsecond paragraph grows ${PAD.slice(0, 2000)}`, 90);
	});

	it("crlf and tab normalized growth", () => {
		assertStreamedIdentity(PAD.replaceAll(" tempor ", " tempor\r\n").slice(0, 4350), 80);
		assertStreamedIdentity(`${PAD}\tand tabbed tail`, 80);
	});

	it("head edit and truncation while the split is engaged", () => {
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (let pos = 2000; pos <= PAD.length; pos += 211) {
			streamed.setText(PAD.slice(0, pos));
			streamed.render(80);
		}
		for (const mutation of [`different ${PAD}`, PAD.slice(500), PAD.slice(0, 1500), `${PAD} and a clean tail`]) {
			streamed.setText(mutation);
			assert.strictEqual(streamed.render(80).join("\n"), full(mutation, 80, false));
		}
	});

	it("width changes and invalidate while the split is engaged", () => {
		const doc = PAD;
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (const width of [80, 40, 100, 60]) {
			for (let pos = 2000; pos <= doc.length; pos += 251) {
				streamed.setText(doc.slice(0, pos));
				assert.strictEqual(
					streamed.render(width).join("\n"),
					full(doc.slice(0, pos), width, false),
					`width ${width} len ${pos}`,
				);
			}
		}
		streamed.setText(doc);
		streamed.render(80);
		streamed.invalidate();
		assert.strictEqual(streamed.render(80).join("\n"), full(doc, 80, false));
	});

	it("PI_MARKDOWN_SPLIT_LEX=0 disables splitting without changing output", () => {
		const previous = process.env.PI_MARKDOWN_SPLIT_LEX;
		process.env.PI_MARKDOWN_SPLIT_LEX = "0";
		try {
			assertStreamedIdentity(`${PAD} **bold tail** and \`code\``, 80);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_MARKDOWN_SPLIT_LEX;
			} else {
				process.env.PI_MARKDOWN_SPLIT_LEX = previous;
			}
		}
	});
});

describe("markdown split-lex fuzz identity", () => {
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
		"plain words keep going and going ",
		"**bold phrase** ",
		"*italic one* ",
		"`code span` ",
		"[a link](https://example.com/path) ",
		"www.autolink.example ",
		"someone@example.com ",
		"$math x+y$ ",
		"~~struck~~ ",
		"&amp; entity ",
		"2 * 3 = 6 literal stars ",
		"under_score_words ",
		"\n",
		"a much longer prose fragment that wraps across whatever width the renderer happens to use today ",
	];

	it("random delimiter-heavy paragraphs render identically at every frame", () => {
		const rnd = prng(0x5911e7);
		assert.ok(FRAGMENTS.length > 0, "fuzz corpus must not be empty");
		for (let docIdx = 0; docIdx < 5; docIdx++) {
			const target = 4400 + Math.floor(rnd() * 800);
			let doc = "";
			while (doc.length < target) {
				doc += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)];
			}
			const width = [80, 60, 100][docIdx % 3]!;
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
