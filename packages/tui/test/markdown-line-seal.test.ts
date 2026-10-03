import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Line-level sealing of the growing final block: while a single-block document
// (one paragraph, one fence) streams in, completed lines must render exactly as
// a fresh full render would render them, and per-frame render work must stay
// bounded by the unsealed tail instead of the accumulated block.

const chalk = new Chalk({ level: 3 });
const coloredDefaultStyle = { color: (text: string) => chalk.cyan(text) };

function full(text: string, width: number, withDefaultStyle = false): string {
	// A fresh component always lexes and renders in full; this is the oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme, withDefaultStyle ? coloredDefaultStyle : undefined)
		.render(width)
		.join("\n");
}

function assertStreamedIdentity(doc: string, width: number, step: number, withDefaultStyle = false): void {
	const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, withDefaultStyle ? coloredDefaultStyle : undefined);
	for (let pos = 0; pos <= doc.length; pos += step) {
		const text = doc.slice(0, pos);
		streamed.setText(text);
		assert.strictEqual(streamed.render(width).join("\n"), full(text, width, withDefaultStyle), `frame at ${pos}`);
	}
	streamed.setText(doc);
	assert.strictEqual(streamed.render(width).join("\n"), full(doc, width, withDefaultStyle), "final frame");
}

const PROSE_LINE = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

describe("markdown final-block line sealing identity", () => {
	it("single growing paragraph, plain prose", () => {
		const doc = Array.from({ length: 12 }, (_, i) => `${PROSE_LINE} ${i}`).join("\n");
		assertStreamedIdentity(doc, 100, 7);
	});

	it("paragraph with inline constructs on every line", () => {
		const doc = Array.from({ length: 8 }, (_, i) => `**bold ${i}** and \`code ${i}\` and *em ${i}* done`).join("\n");
		assertStreamedIdentity(doc, 90, 5);
	});

	it("cross-line bold and codespan", () => {
		assertStreamedIdentity(
			"start **bold line one\nbold line two\nbold line three** end\nnext `code\nspan` tail\nafter",
			80,
			1,
		);
	});

	it("retroactive emphasis pairing invalidates sealed lines", () => {
		// The `*` on line 1 is unmatched while lines stream in (plain text), then a
		// closing `*` arrives at the very end and re-types the whole paragraph.
		assertStreamedIdentity("*foo plain\nbar plain\nbaz plain\nqux*", 80, 1);
	});

	it("setext underline arrival re-types the paragraph", () => {
		assertStreamedIdentity("foo bar\nbaz qux\n===", 80, 1);
		assertStreamedIdentity("foo bar\nbaz qux\n---", 80, 1);
	});

	it("table delimiter arrival re-types the header line", () => {
		assertStreamedIdentity("intro words here\n| a | b |\n|---|---|\n| 1 | 2 |", 80, 1);
	});

	it("late reference-link definition re-lexes everything", () => {
		assertStreamedIdentity("uses [alpha] before\nand more text\n\n[alpha]: /defined-later", 80, 1);
	});

	it("lazy continuation and indented lines", () => {
		assertStreamedIdentity("para line one\n    indented continuation\nline three", 80, 1);
	});

	it("html lines inside and after a paragraph", () => {
		assertStreamedIdentity("para text\n<div>block</div>\nmore text", 80, 1);
	});

	it("hard breaks (trailing spaces) inside a paragraph", () => {
		assertStreamedIdentity("foo  \nbar baz\nqux  \nlast", 80, 1);
	});

	it("hazard characters in prose lines", () => {
		assertStreamedIdentity("price is $5 and foo_bar_baz\n2 * 3 = 6 and a < b > c\nplain tail line", 80, 1);
	});

	it("cross-line display math inside a paragraph", () => {
		assertStreamedIdentity("before math\n$$x +\ny$$\nafter math", 80, 1);
	});

	it("growing fence, then closed, then trailing prose", () => {
		const body = Array.from({ length: 10 }, (_, i) => `const v${i} = f(${i}); // code line`).join("\n");
		assertStreamedIdentity(`\`\`\`ts\n${body}\n\`\`\`\nafter fence prose`, 100, 3);
	});

	it("fence containing blank lines and fence-like content", () => {
		assertStreamedIdentity("```\nline a\n\nline b\n``x\nstill code\n```", 80, 1);
	});

	it("construct directly before the newline with a default text style", () => {
		// The boundary after a construct is where a naive split render drops the
		// style-restore prefix; exercise it with a real default style.
		assertStreamedIdentity("**b**\nrest of line\ntail **bold**\nmore", 80, 1, true);
		assertStreamedIdentity("plain `code`\nnext line\nend", 80, 1, true);
	});

	it("crlf normalized document", () => {
		assertStreamedIdentity("line one\r\nline two\r\nline three", 80, 1);
	});

	it("width changes while the seal is active", () => {
		const doc = Array.from({ length: 8 }, (_, i) => `${PROSE_LINE} ${i}`).join("\n");
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (const width of [80, 40, 100, 60]) {
			for (let pos = 20; pos <= doc.length; pos += 53) {
				streamed.setText(doc.slice(0, pos));
				assert.strictEqual(
					streamed.render(width).join("\n"),
					full(doc.slice(0, pos), width),
					`width ${width} len ${pos}`,
				);
			}
		}
	});

	it("invalidate() drops sealed lines and re-renders identically", () => {
		const doc = Array.from({ length: 6 }, (_, i) => `${PROSE_LINE} ${i}`).join("\n");
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
		streamed.setText(doc);
		streamed.render(80);
		streamed.invalidate();
		assert.strictEqual(streamed.render(80).join("\n"), full(doc, 80));
	});

	it("no-newline growing line (wrap seal): plain prose at several widths", () => {
		const doc = PROSE_LINE.repeat(24);
		for (const width of [100, 40, 26]) {
			assertStreamedIdentity(doc, width, 7);
		}
	});

	it("no-newline growing line: long unbroken words and multi-space runs", () => {
		const doc = `start ${"x".repeat(180)} mid   double    spaces ${"y".repeat(55)} end ${"z".repeat(300)}`;
		assertStreamedIdentity(doc, 60, 5);
	});

	it("no-newline growing line: wide chars and emoji", () => {
		const doc = `汉字漢字かなカナ mixed with ascii words and emoji 🎉🚀 repeated 汉字漢字かなカナ `.repeat(6);
		assertStreamedIdentity(doc, 51, 3);
	});

	it("no-newline growing line: construct arrives mid-line and completes", () => {
		// The rendered prefix rewrites when the construct closes; the wrap seal
		// must drop and recover without diverging from a full render.
		assertStreamedIdentity(`plain start then **bold words here** and ${PROSE_LINE.repeat(6)}`, 70, 3);
	});

	it("growing fence: single very long code line, then more lines", () => {
		const doc = `\`\`\`ts\n${"const x = computeSomething(withArgs, andMoreArgs); ".repeat(12)}\nsecond line\nthird`;
		assertStreamedIdentity(doc, 72, 4);
	});

	it("code text ending in newlines keeps the trailing blank lines of a full render", () => {
		// Indented code keeps its trailing newline in token.text and a fence keeps
		// trailing blank lines; the sealed render must render every tail line, not
		// only the growing one, or the streaming block is one blank line short.
		const cases = [
			"    indented one\n    indented two\n    indented three",
			"```\ncode line\n\n\ntail",
			"```\nline one\nline two\n```",
		];
		for (const doc of cases) {
			assert.ok(doc.length > 0, "cases must not be empty");
			assertStreamedIdentity(doc, 60, 1);
		}
	});

	it("sealed code render matches the unsealed render for trailing newlines", () => {
		const cases = ["    indented one\n    indented two\n", "```\ncode line\n\n\n", "```\nline one\nline two\n"];
		for (const doc of cases) {
			assert.ok(doc.length > 0, "cases must not be empty");
			const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
			for (let pos = 0; pos <= doc.length; pos++) {
				const text = doc.slice(0, pos);
				streamed.setText(text);
				process.env.PI_MARKDOWN_LINE_SEAL = "0";
				let expected: string;
				try {
					expected = new Markdown(text, 1, 0, defaultMarkdownTheme).render(60).join("\n");
				} finally {
					delete process.env.PI_MARKDOWN_LINE_SEAL;
				}
				assert.strictEqual(streamed.render(60).join("\n"), expected, `frame at ${pos} of ${JSON.stringify(doc)}`);
			}
		}
	});

	it("an unmatched backtick re-typing sealed emphasis falls back to a full render", () => {
		// marked evaluates emphasis flanking on a codespan-masked copy of the whole
		// paragraph, so a dangling tail backtick can un-type a `*...*` pair already
		// sealed as italic without any token crossing the seal boundary.
		assertStreamedIdentity("`zx``*e`*e* ghgh\nx`ghb x`x`*ghx``*e", 82, 1);
		assertStreamedIdentity("`z``*ex`f*`b x`*y*cd *y*\nb x`x`*y*\na \n ", 70, 1);
		assertStreamedIdentity("`*ef*``gh`z*y*\nx`b *y*`*e*y* b `\n \ncd cd ", 50, 1);
		assertStreamedIdentity("b `*ex``f*`*y*gh\n x`*y** ``` gh", 86, 1);
	});

	it("narrow width stress on a mixed document", () => {
		const doc = `${PROSE_LINE}\n\n- list item one\n- list item two\n\n${PROSE_LINE.slice(0, 90)}`;
		assertStreamedIdentity(doc, 24, 3);
	});
});

describe("markdown final-block line sealing work bound", () => {
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

	it("a streaming append frame re-renders only the unsealed tail of a single paragraph", () => {
		const line = (i: number) => `line ${i} of a long answer with plain prose text that keeps going on`;
		// Plain prose hits no theme function, so count rendered text segments
		// through the default text style instead (one call per rendered segment).
		let count = 0;
		const countingStyle = {
			color: (text: string): string => {
				count++;
				return chalk.cyan(text);
			},
		};
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, countingStyle);
		let text = "";
		for (let i = 0; i < 40; i++) {
			text += `${line(i)}\n`;
			streamed.setText(text);
			streamed.render(100);
		}
		const singleStyle = {
			color: (text: string): string => {
				perLine++;
				return chalk.cyan(text);
			},
		};
		let perLine = 0;
		new Markdown(line(0), 1, 0, defaultMarkdownTheme, singleStyle).render(100);
		assert.ok(perLine > 0, "probe must observe style calls for one line");
		const before = count;
		text += `${line(40)}\npartial tail`;
		streamed.setText(text);
		streamed.render(100);
		const frameCalls = count - before;
		// The frame renders the newly completed line (seal extension) plus the
		// growing partial line; the 41 sealed lines must not be re-rendered.
		assert.ok(
			frameCalls <= 3 * perLine,
			`append frame spent ${frameCalls} style calls; the sealed prefix (41 lines) must not re-render`,
		);
	});

	it("a streaming append frame re-renders only the unsealed tail of a growing fence", () => {
		const line = (i: number) => `const value${i} = computeSomething(${i});`;
		const { theme, calls } = countingMarkdownTheme();
		const streamed = new Markdown("", 1, 0, theme);
		let text = "```ts\n";
		for (let i = 0; i < 40; i++) {
			text += `${line(i)}\n`;
			streamed.setText(text);
			streamed.render(100);
		}
		const single = countingMarkdownTheme();
		new Markdown(`\`\`\`ts\n${line(0)}`, 1, 0, single.theme).render(100);
		const perLine = single.calls();
		assert.ok(perLine > 0, "probe must observe theme calls for one code line");
		const before = calls();
		text += `${line(40)}\nconst partial =`;
		streamed.setText(text);
		streamed.render(100);
		const frameCalls = calls() - before;
		assert.ok(
			frameCalls <= 3 * perLine,
			`append frame spent ${frameCalls} theme calls; the sealed fence prefix must not re-render`,
		);
	});

	it("PI_MARKDOWN_LINE_SEAL=0 restores the pre-seal full re-render per frame", () => {
		const previous = process.env.PI_MARKDOWN_LINE_SEAL;
		process.env.PI_MARKDOWN_LINE_SEAL = "0";
		try {
			const line = (i: number) => `line ${i} of a long answer with plain prose text that keeps going on`;
			let count = 0;
			const countingStyle = {
				color: (text: string): string => {
					count++;
					return chalk.cyan(text);
				},
			};
			const streamed = new Markdown("", 1, 0, defaultMarkdownTheme, countingStyle);
			let text = "";
			for (let i = 0; i < 40; i++) {
				text += `${line(i)}\n`;
				streamed.setText(text);
				streamed.render(100);
			}
			const before = count;
			text += `${line(40)}\npartial tail`;
			streamed.setText(text);
			streamed.render(100);
			const frameCalls = count - before;
			// Sealed rendering would spend a couple of lines; the kill switch must
			// re-render the whole accumulated paragraph like the pre-seal code did.
			assert.ok(frameCalls >= 40, `kill-switch frame spent only ${frameCalls} style calls`);
			const want = new Markdown(text, 1, 0, defaultMarkdownTheme, coloredDefaultStyle).render(100).join("\n");
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
