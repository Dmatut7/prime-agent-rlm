import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { stripAnsi } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// R4-H2: model text reaches the terminal through Markdown with every escape
// byte intact (audit probe: OSC 52 / CSI 2J / BEL / NUL pass render() raw).
// The wash lives at the token render layer (same contract as Text.render), so
// these tests drive the public Markdown.render entry and assert on the bytes
// that would go to the terminal.

const WIDTH = 80;

function render(text: string, width = WIDTH, theme: MarkdownTheme = defaultMarkdownTheme): string {
	return new Markdown(text, 0, 0, theme).render(width).join("\n");
}

// Escapes the component produces itself: theme SGR, the OSC 8 pair from link
// rendering, and the APC table-selection markers. Anything else in the output
// is model-smuggled.
const COMPONENT_ESCAPE_PATTERNS = [
	/\x1b\[[0-9;:]*m/g, // SGR (chalk themes)
	/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC 8 hyperlink open/close
	/\x1b_pi:table:[^\x07\x1b]*\x07/g, // table cell selection markers
];

function stripComponentEscapes(out: string): string {
	let rest = out;
	for (const pattern of COMPONENT_ESCAPE_PATTERNS) {
		rest = rest.replace(pattern, "");
	}
	return rest;
}

function assertOnlyComponentEscapes(out: string): void {
	const rest = stripComponentEscapes(out);
	const escIndex = rest.indexOf("\x1b");
	assert.strictEqual(
		escIndex,
		-1,
		`non-component escape sequence in render output near: ${JSON.stringify(rest.slice(Math.max(0, escIndex - 10), escIndex + 30))}`,
	);
	const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/.exec(rest);
	assert.strictEqual(
		control,
		null,
		`bare control character U+${control?.[0]?.codePointAt(0)?.toString(16)} in render output: ${JSON.stringify(rest.slice(0, 120))}`,
	);
}

const VECTORS: Array<{ name: string; poison: string; eatsTail?: boolean }> = [
	{ name: "OSC52-clipboard", poison: "\x1b]52;c;cGFzdGU=\x07" },
	{ name: "CSI-2J-clear", poison: "\x1b[2J" },
	{ name: "BEL", poison: "\x07" },
	{ name: "NUL", poison: "\x00" },
	// An unterminated sequence loses everything after its introducer (the wash
	// contract, same as Text.render): the trailing anchor is expected to go with
	// it wherever marked does not re-tokenize the payload into an autolink.
	{ name: "unterminated-OSC8", poison: "\x1b]8;;https://evil.example", eatsTail: true },
	{ name: "keyboard-mode-CSI", poison: "\x1b[>4;1m" },
];

interface Surface {
	name: string;
	wrap: (poison: string) => string;
	anchors: [string, string];
	width?: number;
}

const SURFACES: Surface[] = [
	{ name: "paragraph", wrap: (p) => `before${p}after`, anchors: ["before", "after"] },
	{ name: "fenced-code", wrap: (p) => `\`\`\`\nlet${p}go\n\`\`\``, anchors: ["let", "go"] },
	{ name: "inline-code", wrap: (p) => `pre \`${p}\` post`, anchors: ["pre", "post"] },
	{ name: "link-label", wrap: (p) => `[lab${p}el](https://example.com)`, anchors: ["lab", "el"] },
];

assert.ok(VECTORS.length > 0 && SURFACES.length > 0, "poison matrix must not be empty");

afterEach(() => {
	resetCapabilitiesCache();
});

describe("Markdown model-text wash (R4-H2)", () => {
	describe("poison matrix: every vector through every primary surface", () => {
		for (const surface of SURFACES) {
			for (const vector of VECTORS) {
				it(`${surface.name} washes ${vector.name}`, () => {
					setCapabilities({ images: null, trueColor: true, hyperlinks: true });
					const out = render(surface.wrap(vector.poison), surface.width ?? WIDTH);
					assertOnlyComponentEscapes(out);
					const visible = stripAnsi(out);
					assert.ok(visible.includes(surface.anchors[0]), `lost leading anchor: ${JSON.stringify(visible)}`);
					if (!vector.eatsTail) {
						assert.ok(visible.includes(surface.anchors[1]), `lost trailing anchor: ${JSON.stringify(visible)}`);
					}
				});
			}
		}
	});

	describe("secondary surfaces", () => {
		const SECONDARY: Surface[] = [
			{ name: "heading", wrap: (p) => `# head${p}ing`, anchors: ["head", "ing"] },
			{ name: "blockquote", wrap: (p) => `> quo${p}te`, anchors: ["quo", "te"] },
			{
				name: "table-cell",
				wrap: (p) => `| a${p}b | c |\n| --- | --- |\n| d | e |`,
				anchors: ["a", "b"],
			},
			{ name: "list-item", wrap: (p) => `- it${p}em`, anchors: ["it", "em"] },
			{ name: "block-math", wrap: (p) => `$$\nx${p}y\n$$`, anchors: ["x", "y"] },
			{ name: "inline-math", wrap: (p) => `$x${p}y$`, anchors: ["x", "y"] },
			{ name: "html-block", wrap: (p) => `<div>be${p}ta</div>`, anchors: ["be", "ta"] },
			{ name: "inline-html", wrap: (p) => `al<span>be${p}ta</span>ha`, anchors: ["be", "ta"] },
		];
		assert.ok(SECONDARY.length > 0, "secondary surface matrix must not be empty");
		for (const surface of SECONDARY) {
			for (const vector of VECTORS) {
				it(`${surface.name} washes ${vector.name}`, () => {
					const out = render(surface.wrap(vector.poison), surface.width ?? WIDTH);
					assertOnlyComponentEscapes(out);
					const visible = stripAnsi(out);
					assert.ok(visible.includes(surface.anchors[0]), `lost leading anchor: ${JSON.stringify(visible)}`);
					if (!vector.eatsTail) {
						assert.ok(visible.includes(surface.anchors[1]), `lost trailing anchor: ${JSON.stringify(visible)}`);
					}
				});
			}
		}

		// The narrow-table fallback renders token.raw through wrapTextWithAnsi; the
		// unterminated-OSC8 vector is excluded: the wrapper's own ANSI handling
		// already absorbs that one at this width, so only vectors that reach the
		// output raw are meaningful here.
		const NARROW_VECTORS = VECTORS.filter((v) => v.name !== "unterminated-OSC8");
		assert.ok(NARROW_VECTORS.length > 0, "narrow-table matrix must not be empty");
		for (const vector of NARROW_VECTORS) {
			it(`narrow-table-fallback washes ${vector.name}`, () => {
				const out = render(`| a${vector.poison}b | c |\n| --- | --- |\n| d | e |`, 8);
				assertOnlyComponentEscapes(out);
			});
		}
	});

	describe("link destinations", () => {
		it("washes a BEL/OSC52 breakout out of an autolinked destination", () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const out = render("[x](https://evil.example/\x07\x1b]52;c;AAAA\x07)");
			assertOnlyComponentEscapes(out);
			assert.ok(!out.includes("]52"), `OSC 52 survived: ${JSON.stringify(out)}`);
			assert.ok(
				stripAnsi(out).includes("https://evil.example/"),
				`washed destination should stay visible: ${JSON.stringify(out)}`,
			);
		});

		it("washes a CSI out of an autolinked destination", () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const out = render("[label](https://example.com/a\x1b[2Jb)");
			assertOnlyComponentEscapes(out);
			assert.ok(stripAnsi(out).includes("https://example.com/ab"), `destination mangled: ${JSON.stringify(out)}`);
		});

		it("washes destination poison when the terminal has no hyperlink capability", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const out = render("[label](https://example.com/\x07\x1b]52;c;AAAA\x07)");
			assertOnlyComponentEscapes(out);
			assert.ok(!out.includes("]52"), `OSC 52 survived: ${JSON.stringify(out)}`);
		});
	});

	describe("streaming seals", () => {
		it("washes a paragraph line that completed into the line seal", () => {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.render(WIDTH);
			md.setText("first line\n");
			md.render(WIDTH);
			md.setText("first line\nmid\x1b]52;c;AAAA\x07dle\n");
			md.render(WIDTH);
			md.setText("first line\nmid\x1b]52;c;AAAA\x07dle\ntail");
			const out = md.render(WIDTH).join("\n");
			assertOnlyComponentEscapes(out);
			const visible = stripAnsi(out);
			assert.ok(visible.includes("mid") && visible.includes("dle"), `visible text lost: ${JSON.stringify(visible)}`);
		});

		it("washes poison arriving in the unsealed growing tail", () => {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.render(WIDTH);
			md.setText("first line\n");
			md.render(WIDTH);
			md.setText("first line\ngrow\x1b[2Jing");
			const out = md.render(WIDTH).join("\n");
			assertOnlyComponentEscapes(out);
			assert.ok(stripAnsi(out).includes("growing"), `visible text lost: ${JSON.stringify(stripAnsi(out))}`);
		});

		it("washes a code line that completed into the fence seal", () => {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.render(WIDTH);
			md.setText("```\nok();\n");
			md.render(WIDTH);
			md.setText("```\nok();\nbad\x1b[2Jline();\n");
			md.render(WIDTH);
			md.setText("```\nok();\nbad\x1b[2Jline();\nend();");
			const out = md.render(WIDTH).join("\n");
			assertOnlyComponentEscapes(out);
			const visible = stripAnsi(out);
			assert.ok(
				visible.includes("bad") && visible.includes("line();"),
				`visible text lost: ${JSON.stringify(visible)}`,
			);
		});

		it("washes a list item that completed into the list seal", () => {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.render(WIDTH);
			md.setText("- alpha\n");
			md.render(WIDTH);
			md.setText("- alpha\n- be\x07ta\n");
			md.render(WIDTH);
			md.setText("- alpha\n- be\x07ta\n- gamma");
			const out = md.render(WIDTH).join("\n");
			assertOnlyComponentEscapes(out);
			assert.ok(stripAnsi(out).includes("beta"), `visible text lost: ${JSON.stringify(stripAnsi(out))}`);
		});
	});

	describe("highlighter hand-off", () => {
		const hlInputs: string[] = [];
		const hlTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				hlInputs.push(code);
				return code.split("\n").map((line) => `\x1b[35m${line}\x1b[39m`);
			},
		};

		it("the theme highlighter only ever receives washed code text", () => {
			render("```js\nlet\x1b[2Ja = \x07`\x1b]52;c;AAAA\x07`;\n```", WIDTH, hlTheme);
			assert.ok(hlInputs.length > 0, "highlighter should have run");
			for (const input of hlInputs) {
				assert.ok(!input.includes("\x1b"), `highlighter received raw escape: ${JSON.stringify(input)}`);
				assert.ok(
					!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/.test(input),
					`highlighter received control char: ${JSON.stringify(input)}`,
				);
			}
		});
	});

	describe("wash contract (parity with Text.render)", () => {
		it("keeps a plain SGR sequence from the model text", () => {
			const out = render("a\x1b[31mb");
			assert.ok(out.includes("\x1b[31m"), `SGR should pass the gate: ${JSON.stringify(out)}`);
		});

		it("keeps a terminated OSC 8 hyperlink from the model text", () => {
			// A fragment-only target: a bare https URL would be re-tokenized into a
			// marked autolink before the gate ever sees the OSC 8 bytes.
			const osc8 = "\x1b]8;;#anchor\x1b\\link\x1b]8;;\x1b\\";
			const out = render(`see ${osc8} end`);
			assert.ok(out.includes(osc8), `terminated OSC 8 should pass the gate: ${JSON.stringify(out)}`);
			assert.ok(stripAnsi(out).includes("link"), `link text lost: ${JSON.stringify(out)}`);
		});

		it("keeps theme styling on washed content", () => {
			const out = render("pre `code` post");
			assert.ok(out.includes("\x1b[33m"), `codespan theme color missing: ${JSON.stringify(out)}`);
			assert.ok(stripAnsi(out).includes("pre code post"), `visible text mangled: ${JSON.stringify(out)}`);
		});
	});
});
