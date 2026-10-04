import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { stripAnsi } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// P2 fence streaming highlight: with a whole-block highlighter the growing
// final fence seals its completed lines rendered PLAIN (codeBlock style) and
// highlights only the capped unsealed tail per frame; the whole fence is
// highlighted once when it closes (or when it stops being the final block).
//
// Oracle relaxation vs the other seal tests (design doc §4), because the
// streaming plain seal is designed behavior, not a bug:
// - closure frame and later: byte-identical to the unsealed full render;
// - earlier streaming frames: identical after stripAnsi;
// - rendered line count: monotonically non-decreasing.

const HL_OPEN = "\x1b[35m";
const PLAIN_OPEN = "\x1b[32m"; // chalk.green, the codeBlock style in defaultMarkdownTheme

// Text-preserving stub highlighter: every word is wrapped in magenta, so a
// highlighted region differs from a plain codeBlock region in raw bytes but is
// identical after stripAnsi. The regex is per-line, so highlighting the whole
// block at closure agrees line-by-line with highlighting a tail slice.
function stubHighlightLines(code: string): string[] {
	return code
		.split("\n")
		.map((line) => line.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => `${HL_OPEN}${word}\x1b[39m`));
}

const hlTheme: MarkdownTheme = {
	...defaultMarkdownTheme,
	highlightCode: (code: string): string[] => stubHighlightLines(code),
};

const WIDTH = 100;

/** A fresh component always lexes and renders in full; same seal code, no history. */
function fresh(text: string, width: number): string {
	return new Markdown(text, 1, 0, hlTheme).render(width).join("\n");
}

/** The pre-P2 render of every frame: no seals at all, one full renderBlock. */
function fullUnsealed(text: string, width: number): string {
	const previous = process.env.PI_MARKDOWN_LINE_SEAL;
	process.env.PI_MARKDOWN_LINE_SEAL = "0";
	try {
		return new Markdown(text, 1, 0, hlTheme).render(width).join("\n");
	} finally {
		if (previous === undefined) {
			delete process.env.PI_MARKDOWN_LINE_SEAL;
		} else {
			process.env.PI_MARKDOWN_LINE_SEAL = previous;
		}
	}
}

const DEFAULT_STEPS = [1, 3, 7, 16];

/** Streamed component vs a fresh component per prefix: byte-identical on every frame. */
function assertStreamedIdentity(name: string, doc: string, steps: number[] = DEFAULT_STEPS): void {
	assert.ok(doc.length > 0, `${name}: doc must not be empty`);
	for (const step of steps) {
		const streamed = new Markdown("", 1, 0, hlTheme);
		for (let pos = step; ; pos += step) {
			const end = Math.min(pos, doc.length);
			const text = doc.slice(0, end);
			streamed.setText(text);
			let got: string;
			try {
				got = streamed.render(WIDTH).join("\n");
			} catch (err) {
				throw new assert.AssertionError({
					message: `${name} step=${step} frame at ${end} threw: ${(err as Error).message}`,
				});
			}
			assert.strictEqual(got, fresh(text, WIDTH), `${name} step=${step} frame at ${end}`);
			if (end >= doc.length) break;
		}
	}
}

/**
 * The P2 drift oracle against the unsealed full render: stripAnsi-identical on
 * every frame, byte-identical from the closure frame on, monotonic line count.
 * `closedFrom` is the smallest prefix length at which the fence stays closed.
 */
function assertDriftOracle(name: string, doc: string, step: number, closedFrom: number | undefined): void {
	assert.ok(doc.length > 0, `${name}: doc must not be empty`);
	const streamed = new Markdown("", 1, 0, hlTheme);
	let prevLines = -1;
	for (let pos = step; ; pos += step) {
		const end = Math.min(pos, doc.length);
		const text = doc.slice(0, end);
		streamed.setText(text);
		const got = streamed.render(WIDTH).join("\n");
		const want = fullUnsealed(text, WIDTH);
		const lineCount = got === "" ? 0 : got.split("\n").length;
		assert.ok(lineCount >= prevLines, `${name} line count dropped at ${end}: ${prevLines} -> ${lineCount}`);
		prevLines = lineCount;
		assert.strictEqual(stripAnsi(got), stripAnsi(want), `${name} stripAnsi drift at ${end}`);
		if (closedFrom !== undefined && end >= closedFrom) {
			assert.strictEqual(got, want, `${name} post-closure frame at ${end} must be byte-identical`);
		}
		if (end >= doc.length) break;
	}
}

/** Smallest prefix length at which the final fence (opened with `fence`) is closed. */
function closedFrom(doc: string, fence = "```"): number {
	const at = doc.lastIndexOf(`\n${fence}`);
	assert.ok(at !== -1, "doc must contain a closing fence");
	return at + 1 + fence.length;
}

describe("markdown fence streaming highlight identity", () => {
	it("simple fence closing mid-stream", () => {
		assertStreamedIdentity("simple", "```ts\nconst a = 1;\nlet b = 2;\n```\nafter prose here");
	});

	it("fence after a sealed paragraph", () => {
		assertStreamedIdentity("after-para", "intro paragraph text\n\n```ts\nconst a = 1;\nlet b = 2;\n```\noutro");
	});

	it("no-language fence", () => {
		assertStreamedIdentity("no-lang", "```\nplain code line\nsecond line\n```\ntail");
	});

	it("tilde fence", () => {
		assertStreamedIdentity("tilde", "~~~py\nx = 1\ny = 2\n~~~\nend");
	});

	it("four-backtick opener with an inner three-backtick line", () => {
		assertStreamedIdentity("four-backtick", "````ts\na\n```\nb\n````\nrest");
	});

	it("blank lines inside and before the closer", () => {
		assertStreamedIdentity("blank-lines", "```\nline one\n\n\nline two\n\n```\nafter");
	});

	it("closing fence retracted by more text, then re-closed", () => {
		// "```" gains a "p" and stops being a closer: the fence re-opens and the
		// seal re-engages until the real closer arrives.
		assertStreamedIdentity("retract", "```\nabc\n```p\nq\n```\ndone");
	});

	it("empty fence", () => {
		assertStreamedIdentity("empty", "```\n```\nafter");
	});

	it("fence closing exactly at stream end", () => {
		assertStreamedIdentity("close-at-end", "```ts\nconst a = 1;\n```");
	});

	it("never-closing fence", () => {
		assertStreamedIdentity("never-closed", "```ts\nconst a = 1;\nlet b = 2;\npartial tail");
	});

	it("indented code block has no fence to close", () => {
		assertStreamedIdentity("indented", "    indented one\n    indented two\n    indented three");
	});

	it("crlf inside a fence", () => {
		assertStreamedIdentity("crlf", "```ts\r\na = 1\r\nb = 2\r\n```\r\nafter");
	});

	it("giant single growing code line crossing the highlight cap", { timeout: 60_000 }, () => {
		const doc = `\`\`\`ts\n${"const x = computeSomething(withArgs, andMoreArgs); ".repeat(90)}\nsecond line\nthird\n\`\`\`\nepilogue`;
		assert.ok(doc.length > 4096, "doc must cross the streaming highlight cap");
		assertStreamedIdentity("giant-line", doc, [1, 7]);
	});

	it("width changes while the highlighted fence seal is active", () => {
		const doc =
			"```ts\nconst a = computeSomething(1, withArgs);\nlet b = anotherCall(a);\nconst c = b * 3;\n```\nafter prose";
		const streamed = new Markdown("", 1, 0, hlTheme);
		for (const width of [80, 40, 100, 60]) {
			for (let pos = 20; pos <= doc.length; pos += 53) {
				const text = doc.slice(0, pos);
				streamed.setText(text);
				assert.strictEqual(
					streamed.render(width).join("\n"),
					new Markdown(text, 1, 0, hlTheme).render(width).join("\n"),
					`width ${width} len ${pos}`,
				);
			}
		}
	});
});

describe("markdown fence streaming highlight drift oracle", () => {
	it("closing fence: stripAnsi every frame, byte-identical from closure on", () => {
		const doc = "```ts\nconst a = 1;\nlet b = 2;\nconst c = 3;\n```\nafter prose";
		assertDriftOracle("closing", doc, 7, closedFrom(doc));
	});

	it("fence closing exactly at stream end: the final frame is byte-identical", () => {
		const doc = "```ts\nconst a = 1;\nlet b = 2;\n```";
		assertDriftOracle("close-at-end", doc, 3, closedFrom(doc));
	});

	it("blank lines around the closer keep the line count monotonic", () => {
		const doc = "```\nline one\n\n\nline two\n\n```\nafter";
		assertDriftOracle("blank-lines", doc, 7, closedFrom(doc));
	});

	it("retracted closure re-enters streaming drift, re-closure heals", () => {
		const doc = "```\nabc\n```p\nq\n```\ndone";
		assertDriftOracle("retract", doc, 7, closedFrom(doc));
	});

	it("giant single growing code line", () => {
		const doc = `\`\`\`ts\n${"const x = computeSomething(withArgs, andMoreArgs); ".repeat(90)}\nsecond line\nthird\n\`\`\`\nepilogue`;
		assertDriftOracle("giant-line", doc, 50, closedFrom(doc));
	});

	it("never-closing fence: plain sealed prefix and highlighted tail persist to the final frame", () => {
		// A truncated stream never triggers the closure reflow: the fence keeps
		// the plain seal + highlighted tail even in its final render. This pins
		// the designed residual drift (the §4 oracle only requires stripAnsi
		// identity without a closure frame).
		const doc = "```ts\nconst alpha = 1;\nconst beta = 2;\nconst gamma = 3;\npartial tail";
		assertDriftOracle("never-closed", doc, 7, undefined);
		const streamed = new Markdown("", 1, 0, hlTheme);
		streamed.setText(doc);
		const finalFrame = streamed.render(WIDTH).join("\n");
		const alphaLine = finalFrame.split("\n").find((line) => line.includes("alpha"));
		assert.ok(alphaLine?.includes(PLAIN_OPEN) && !alphaLine.includes(HL_OPEN), "sealed prefix must stay plain");
		const tailLine = finalFrame.split("\n").find((line) => stripAnsi(line).includes("partial tail"));
		assert.ok(tailLine?.includes(HL_OPEN), "the unsealed tail must be highlighted");
	});

	it("indented code: plain sealed prefix and highlighted tail persist", () => {
		const doc = "    indented one\n    indented two\n    indented three";
		assertDriftOracle("indented", doc, 7, undefined);
		const streamed = new Markdown("", 1, 0, hlTheme);
		streamed.setText(doc);
		const finalFrame = streamed.render(WIDTH).join("\n");
		const firstLine = finalFrame.split("\n").find((line) => line.includes("indented one"));
		assert.ok(firstLine?.includes(PLAIN_OPEN) && !firstLine.includes(HL_OPEN), "sealed prefix must stay plain");
		const tailLine = finalFrame.split("\n").find((line) => stripAnsi(line).includes("indented three"));
		assert.ok(tailLine?.includes(HL_OPEN), "the unsealed tail must be highlighted");
	});

	it("a streaming frame shows a plain sealed prefix and a highlighted tail", () => {
		const doc = "```ts\nconst alpha = 1;\nconst beta = 2;\nconst gamma = 3;\ngrowing tail";
		const streamed = new Markdown("", 1, 0, hlTheme);
		streamed.setText(doc);
		const frame = streamed.render(WIDTH).join("\n");
		const sealedLine = frame.split("\n").find((line) => line.includes("alpha"));
		assert.ok(sealedLine?.includes(PLAIN_OPEN) && !sealedLine.includes(HL_OPEN));
		const tail = frame.split("\n").find((line) => stripAnsi(line).includes("growing tail"));
		assert.ok(tail?.includes(HL_OPEN));
		// The unsealed render highlights every line: byte drift, stripAnsi equal.
		assert.notStrictEqual(frame, fullUnsealed(doc, WIDTH));
		assert.strictEqual(stripAnsi(frame), stripAnsi(fullUnsealed(doc, WIDTH)));
	});
});

describe("markdown fence streaming highlight kill switch and work bound", () => {
	function streamAll(doc: string, step: number, width: number): string[][] {
		const streamed = new Markdown("", 1, 0, hlTheme);
		const frames: string[][] = [];
		for (let pos = step; ; pos += step) {
			const end = Math.min(pos, doc.length);
			streamed.setText(doc.slice(0, end));
			frames.push(streamed.render(width));
			if (end >= doc.length) break;
		}
		return frames;
	}

	it("PI_MARKDOWN_FENCE_STREAM_HL=0 restores the pre-seal full highlighted re-render every frame", () => {
		const step = 7;
		const doc = "```ts\nconst a = compute(1);\nlet b = a + 2;\nconst c = b * 3;\n```\nafter prose";
		const closeAt = closedFrom(doc);
		const on = streamAll(doc, step, WIDTH);
		const previous = process.env.PI_MARKDOWN_FENCE_STREAM_HL;
		process.env.PI_MARKDOWN_FENCE_STREAM_HL = "0";
		let off: string[][];
		try {
			off = streamAll(doc, step, WIDTH);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_MARKDOWN_FENCE_STREAM_HL;
			} else {
				process.env.PI_MARKDOWN_FENCE_STREAM_HL = previous;
			}
		}
		assert.strictEqual(off.length, on.length);
		// The on/off comparison uses the relaxed P2 oracle (streaming plain seal
		// is designed behavior): byte identity from the closure frame on,
		// stripAnsi identity before it, monotonic line counts on both sides.
		let prevOn = -1;
		let prevOff = -1;
		for (let i = 0; i < on.length; i++) {
			const end = Math.min((i + 1) * step, doc.length);
			const onFrame = on[i].join("\n");
			const offFrame = off[i].join("\n");
			assert.ok(on[i].length >= prevOn && off[i].length >= prevOff, `line count dropped at ${end}`);
			prevOn = on[i].length;
			prevOff = off[i].length;
			assert.strictEqual(stripAnsi(offFrame), stripAnsi(onFrame), `on/off stripAnsi at ${end}`);
			if (end >= closeAt) {
				assert.strictEqual(offFrame, onFrame, `on/off post-closure at ${end}`);
			}
			// The kill switch is the pre-P2 behavior exactly: a full highlighted
			// re-render of the growing fence on every frame.
			assert.strictEqual(offFrame, fullUnsealed(doc.slice(0, end), WIDTH), `off frame at ${end}`);
		}
	});

	it("per-frame highlight input is capped while streaming; closure highlights the whole fence once", () => {
		const inputs: number[] = [];
		const countingTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				inputs.push(code.length);
				return stubHighlightLines(code);
			},
		};
		const codeText = Array.from(
			{ length: 200 },
			(_, i) => `const value${i} = computeSomething(${i}, withArgument);`,
		).join("\n");
		assert.ok(codeText.length > 4096, "fence must exceed the streaming highlight cap");
		const doc = `\`\`\`ts\n${codeText}\n\`\`\``;
		const closeStart = doc.length - 3;
		const streamed = new Markdown("", 1, 0, countingTheme);
		for (let pos = 50; pos < closeStart; pos += 50) {
			streamed.setText(doc.slice(0, pos));
			streamed.render(WIDTH);
		}
		assert.ok(inputs.length > 0, "streaming must highlight the tail");
		const maxStreamInput = Math.max(...inputs);
		assert.ok(maxStreamInput <= 4096, `streaming highlight input ${maxStreamInput} exceeds the cap`);
		// The closure frame highlights the whole fence in one pass.
		streamed.setText(doc);
		streamed.render(WIDTH);
		assert.strictEqual(inputs[inputs.length - 1], codeText.length);
	});

	it("a giant single growing code line crosses the cap and stays plain until closure", () => {
		const inputs: number[] = [];
		const countingTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				inputs.push(code.length);
				return stubHighlightLines(code);
			},
		};
		const bigLine = "const x = computeSomething(withArgs, andMoreArgs); ".repeat(150);
		const doc = `\`\`\`ts\n${bigLine}\n\`\`\``;
		const closeStart = doc.length - 3;
		const streamed = new Markdown("", 1, 0, countingTheme);
		let lastFrame = "";
		for (let pos = 50; pos < closeStart; pos += 50) {
			streamed.setText(doc.slice(0, pos));
			lastFrame = streamed.render(WIDTH).join("\n");
		}
		const maxStreamInput = Math.max(...inputs);
		assert.ok(maxStreamInput <= 4096, `streaming highlight input ${maxStreamInput} exceeds the cap`);
		// Past the cap the growing line renders plain (codeBlock), not highlighted.
		assert.ok(lastFrame.includes(PLAIN_OPEN) && !lastFrame.includes(HL_OPEN));
		streamed.setText(doc);
		const closedFrame = streamed.render(WIDTH).join("\n");
		assert.strictEqual(inputs[inputs.length - 1], bigLine.length);
		assert.ok(closedFrame.includes(HL_OPEN), "closure must highlight the whole fence");
	});

	it("the kill switch restores unbounded per-frame highlight input", () => {
		const inputs: number[] = [];
		const countingTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				inputs.push(code.length);
				return stubHighlightLines(code);
			},
		};
		const codeText = Array.from({ length: 120 }, (_, i) => `const value${i} = computeSomething(${i});`).join("\n");
		assert.ok(codeText.length > 4096, "fence must exceed the streaming highlight cap");
		const doc = `\`\`\`ts\n${codeText}`;
		const previous = process.env.PI_MARKDOWN_FENCE_STREAM_HL;
		process.env.PI_MARKDOWN_FENCE_STREAM_HL = "0";
		try {
			const streamed = new Markdown("", 1, 0, countingTheme);
			for (let pos = 200; pos <= doc.length; pos += 200) {
				streamed.setText(doc.slice(0, pos));
				streamed.render(WIDTH);
			}
		} finally {
			if (previous === undefined) {
				delete process.env.PI_MARKDOWN_FENCE_STREAM_HL;
			} else {
				process.env.PI_MARKDOWN_FENCE_STREAM_HL = previous;
			}
		}
		// Pre-P2 shape: the whole accumulated fence text is highlighted per frame.
		assert.ok(Math.max(...inputs) > 4096, "kill switch must restore the full per-frame highlight");
	});
});

describe("markdown fence streaming highlight highlighter arrival", () => {
	it("a highlighter arriving mid-session redraws neither closed fences nor sealed prefixes", () => {
		// theme.ts semantics: highlightCode starts as an unhighlighted fallback
		// and there is no broadcast when the real highlighter finishes loading.
		// Modeled here by installing highlightCode on the theme mid-stream.
		const theme: MarkdownTheme = { ...defaultMarkdownTheme };
		const fence = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
		const closed = new Markdown("", 1, 0, theme);
		closed.setText(`${fence}\nprose tail`);
		const before = closed.render(WIDTH).join("\n");
		assert.ok(!before.includes(HL_OPEN));
		theme.highlightCode = (code: string): string[] => stubHighlightLines(code);
		// An unchanged re-render serves the whole-result cache: no redraw.
		assert.strictEqual(closed.render(WIDTH).join("\n"), before);
		// Appending re-renders the document, but the closed fence sits behind a
		// stable lex boundary and keeps its cached plain lines.
		closed.setText(`${fence}\nprose tail grows on`);
		const after = closed.render(WIDTH).join("\n");
		const fenceLines = after.split("\n").filter((line) => line.includes("const"));
		assert.ok(fenceLines.length === 2, "both fence lines must render");
		assert.ok(
			fenceLines.every((line) => !line.includes(HL_OPEN)),
			"the closed fence must not be redrawn when the highlighter arrives",
		);

		// An open fence keeps its plain sealed prefix; only the tail highlights.
		const openTheme: MarkdownTheme = { ...defaultMarkdownTheme };
		const open = new Markdown("", 1, 0, openTheme);
		open.setText("```ts\nconst alpha = 1;\nconst beta = 2;\ngrowing");
		open.render(WIDTH);
		openTheme.highlightCode = (code: string): string[] => stubHighlightLines(code);
		open.setText("```ts\nconst alpha = 1;\nconst beta = 2;\ngrowing tail");
		const openFrame = open.render(WIDTH).join("\n");
		const sealedLine = openFrame.split("\n").find((line) => line.includes("alpha"));
		assert.ok(sealedLine?.includes(PLAIN_OPEN) && !sealedLine.includes(HL_OPEN), "sealed prefix must not be redrawn");
		const tailLine = openFrame.split("\n").find((line) => stripAnsi(line).includes("growing tail"));
		assert.ok(tailLine?.includes(HL_OPEN), "the live tail picks up the highlighter");
	});
});
