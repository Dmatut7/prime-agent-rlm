import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// The backtick guard (hasUnmaskedBacktick) walks marked's emphasis mask over
// the whole paragraph, so a streaming paragraph full of paired inline code
// would pay a full-paragraph regex scan every frame. The clean verdict is
// memoized append-only: a paragraph whose mask is clean stays clean across
// frames that append text containing no backtick (mask spans only ever grow
// over a fixed prefix; the one way a span dissolves needs a backtick in the
// appended region). These tests pin the memo's correctness against a fresh
// full-lex oracle and its perf effect against the memo disabled via
// PI_MARKDOWN_BACKTICK_GUARD_MEMO=0 (the pre-memo code path).

function renderLines(text: string, width: number): string[] {
	// A fresh component always lexes in full; this is the full re-lex oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme).render(width);
}

function buildParagraph(lines: number): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(`word${i} \`code ${i}\` tail${i}`);
	}
	return out.join("\n");
}

describe("Markdown backtick guard memo", () => {
	it("streams a code-heavy paragraph exactly as a fresh full lex renders it", () => {
		const md = new Markdown("", 1, 0, defaultMarkdownTheme);
		const width = 72;
		// One growing paragraph, >= 4096 chars so split-lex engages.
		const frames: string[] = [];
		frames.push(buildParagraph(200));
		// Backtick-free prose growth: the memo must keep the clean verdict.
		for (let i = 0; i < 6; i++) {
			frames.push(`${frames[frames.length - 1]}\nplain prose line ${i} without any backtick`);
		}
		// New paired code spans: the tail carries backticks, so the verdict is
		// recomputed (never reused stale).
		frames.push(`${frames[frames.length - 1]}\nmore \`paired code\` and \`another span\` text`);
		// An unpaired backtick window: guard must go dirty (split-lex falls back
		// to a full lex) and clean again once the run closes.
		frames.push(`${frames[frames.length - 1]}\nwindow with \`unpaired`);
		frames.push(`${frames[frames.length - 1]} still unpaired`);
		frames.push(`${frames[frames.length - 1]} closes now\``);
		// Dissolution shape: a backtick arriving right after a closed codespan
		// can unpair earlier spans; the memo must not survive it stale-clean.
		frames.push(`${frames[frames.length - 1]}\nedge \`a\``);
		frames.push(`${frames[frames.length - 1]}\``);
		frames.push(`${frames[frames.length - 1]}b\``);
		// A truncated head edit (not append-only) must drop every memo.
		frames.push(`head edit ${frames[frames.length - 1].slice(9)}`);
		// A link completing across the junction also re-shapes the mask.
		frames.push(`${frames[frames.length - 1]}\nsee [ref`);
		frames.push(`${frames[frames.length - 1]}erence](https://example.com) done`);

		for (const text of frames) {
			md.setText(text);
			assert.deepStrictEqual(md.render(width), renderLines(text, width));
		}
		// Re-render of unchanged text (equal-length memo) and at a new width.
		assert.deepStrictEqual(md.render(width), renderLines(frames[frames.length - 1], width));
		assert.deepStrictEqual(md.render(100), renderLines(frames[frames.length - 1], 100));
	});

	it("seals a small single-block paragraph exactly as a fresh full lex renders it", () => {
		// Below MIN_SPLIT_LEX_BLOCK_CHARS the seal guard (not the split guard)
		// owns the backtick check; same memo, same oracle.
		const md = new Markdown("", 1, 0, defaultMarkdownTheme);
		const width = 60;
		let text = "";
		const frames = [
			"start `code` then plain text\nsecond line without backticks",
			"start `code` then plain text\nsecond line without backticks\nthird",
			"start `code` then plain text\nsecond line without backticks\nthird `more code` grows",
			"start `code` then plain text\nsecond line without backticks\nthird `more code` grows\nfourth",
			"start `code` then plain text\nsecond line without backticks\nthird `more code` grows\nfourth `open",
			"start `code` then plain text\nsecond line without backticks\nthird `more code` grows\nfourth `open now closed`",
		];
		for (const frame of frames) {
			text = frame;
			md.setText(text);
			assert.deepStrictEqual(md.render(width), renderLines(text, width));
		}
		assert.deepStrictEqual(md.render(width), renderLines(text, width));
		assert.deepStrictEqual(md.render(90), renderLines(text, 90));
	});

	it("keeps streaming frames off the full-paragraph mask scan", () => {
		// A/B against PI_MARKDOWN_BACKTICK_GUARD_MEMO=0, which restores the
		// pre-memo code path (unconditional whole-paragraph mask per frame).
		// With the memo, backtick-free appends skip the scan, so the memo run
		// must finish well under the no-memo run; on the pre-memo code the env
		// var did not exist and both runs are the same code (ratio ~1).
		const lines = 8000;
		const paragraph = buildParagraph(lines);
		const appends: string[] = [];
		for (let i = 0; i < 40; i++) {
			appends.push(`\nplain prose append number ${i} without any backticks`);
		}
		const run = (memo: string | undefined): number => {
			const previous = process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO;
			if (memo === undefined) {
				delete process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO;
			} else {
				process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO = memo;
			}
			try {
				const md = new Markdown("", 1, 0, defaultMarkdownTheme);
				let text = paragraph;
				md.setText(text);
				md.render(120);
				text += "\nplain warm up line without backticks";
				md.setText(text);
				md.render(120);
				const start = performance.now();
				for (const chunk of appends) {
					text += chunk;
					md.setText(text);
					md.render(120);
				}
				return performance.now() - start;
			} finally {
				if (previous === undefined) {
					delete process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO;
				} else {
					process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO = previous;
				}
			}
		};

		run(undefined); // JIT warm-up
		const withoutMemo = run("0");
		const withMemo = run(undefined);
		assert.ok(
			withMemo < withoutMemo * 0.6,
			`memo run ${withMemo.toFixed(1)}ms must beat the no-memo run ${withoutMemo.toFixed(1)}ms by 40%+`,
		);
		// And the guard itself must actually run per frame on this corpus: with
		// the memo off, the 40 frames cost far more than wrapping 40 lines.
		assert.ok(withoutMemo > 50, `no-memo run too small to prove the guard runs: ${withoutMemo.toFixed(1)}ms`);
	});
});
