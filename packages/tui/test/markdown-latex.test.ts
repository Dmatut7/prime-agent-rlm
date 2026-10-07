import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { latexToUnicode } from "../src/latex.js";
import { defaultMarkdownTheme } from "./test-themes.js";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderPlain(text: string, width = 80): string[] {
	const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
	return markdown.render(width).map(stripAnsi);
}

describe("latexToUnicode", () => {
	it("converts symbols, big operators, and scripts", () => {
		assert.strictEqual(latexToUnicode("y_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}"), "yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ");
	});

	it("converts greek letters and relations", () => {
		assert.strictEqual(latexToUnicode("\\alpha \\leq \\beta \\implies \\gamma \\to \\infty"), "α ≤ β ⇒ γ → ∞");
	});

	it("renders operator names as plain words", () => {
		assert.strictEqual(latexToUnicode("O(n \\log n)"), "O(n log n)");
		assert.strictEqual(latexToUnicode("\\max_i f(x_i)"), "maxᵢ f(xᵢ)");
	});

	it("renders fractions linearly with parentheses only when needed", () => {
		assert.strictEqual(latexToUnicode("\\frac{a}{b}"), "a/b");
		assert.strictEqual(latexToUnicode("\\frac{x+1}{2}"), "(x+1)/2");
		assert.strictEqual(latexToUnicode("\\frac{1}{2} m v^2"), "½ m v²");
	});

	it("renders square roots", () => {
		assert.strictEqual(latexToUnicode("\\sqrt{x}"), "√x");
		assert.strictEqual(latexToUnicode("\\sqrt{x^2+1}"), "√(x²+1)");
		assert.strictEqual(latexToUnicode("\\sqrt[3]{8}"), "∛8");
	});

	it("unwraps text commands and styles alphabets", () => {
		assert.strictEqual(latexToUnicode("\\text{softmax}(QK^T / \\sqrt{d_k})"), "softmax(QKᵀ / √dₖ)");
		assert.strictEqual(latexToUnicode("\\mathbb{R}^d"), "ℝᵈ");
		assert.strictEqual(latexToUnicode("\\mathcal{L}"), "ℒ");
		assert.strictEqual(latexToUnicode("\\mathbf{W} x"), "𝐖 x");
	});

	it("applies accents as combining characters", () => {
		assert.strictEqual(latexToUnicode("\\hat{y}"), "ŷ");
		assert.strictEqual(latexToUnicode("\\vec{x}"), "x⃗");
	});

	it("keeps TeX notation for scripts without Unicode forms", () => {
		assert.strictEqual(latexToUnicode("\\nabla_\\theta J(\\theta)"), "∇_θ J(θ)");
		assert.strictEqual(latexToUnicode("x_{best}"), "x_{best}");
	});

	it("drops sizing commands and keeps delimiters", () => {
		assert.strictEqual(latexToUnicode("\\left( \\frac{1}{N} \\sum_{i=1}^N x_i \\right)"), "( 1/N ∑ᵢ₌₁ᴺ xᵢ )");
	});

	it("turns aligned environments into multiple lines", () => {
		assert.strictEqual(
			latexToUnicode("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}").trim(),
			"a = b + c \n d = e",
		);
	});

	it("degrades unknown commands to their name", () => {
		assert.strictEqual(latexToUnicode("\\foobar x"), "foobar x");
	});

	it("handles escaped braces", () => {
		assert.strictEqual(latexToUnicode("x \\in \\{1, \\dots, K\\}"), "x ∈ {1, …, K}");
	});

	it("collapses insignificant whitespace from spacing commands", () => {
		assert.strictEqual(latexToUnicode("\\int_0^1 x^2 \\, dx = \\frac{1}{3}"), "∫₀¹ x² dx = ⅓");
	});

	it("preserves the deliberate gap of \\quad and \\qquad", () => {
		// The source-whitespace collapse used to eat these too, making
		// \quad and \qquad indistinguishable from \,.
		assert.strictEqual(latexToUnicode("a \\quad b"), "a    b");
		assert.strictEqual(latexToUnicode("a \\qquad b"), "a      b");
		assert.strictEqual(latexToUnicode("a \\, b"), "a b");
	});

	it("swallows environment column specs instead of rendering them", () => {
		// {cc}/{l|r}/{2} are layout arguments; they used to leak as literal
		// text in front of the first row.
		assert.strictEqual(latexToUnicode("\\begin{array}{cc} a & b \\\\ c & d \\end{array}").trim(), "a b \n c d");
		assert.strictEqual(latexToUnicode("\\begin{tabular}{l|r} a & b \\end{tabular}").trim(), "a b");
		assert.strictEqual(latexToUnicode("\\begin{alignedat}{2} x &= 1 \\end{alignedat}").trim(), "x = 1");
	});

	it("swallows the optional position of aligned and the row-spacing argument of \\\\", () => {
		assert.strictEqual(latexToUnicode("\\begin{aligned}[t] x &= 1 \\end{aligned}").trim(), "x = 1");
		assert.strictEqual(latexToUnicode("a = b \\\\[5pt] c = d").trim(), "a = b \n c = d");
	});

	it("keeps a bracket after \\begin as content for environments without a [pos] argument", () => {
		// [0,1] is an interval, the matrix's first cell — consuming it as a
		// layout parameter silently deleted the content.
		assert.strictEqual(latexToUnicode("\\begin{pmatrix}[0,1] & x \\\\ y & z\\end{pmatrix}"), "[0,1] x \n y z");
		assert.strictEqual(latexToUnicode("\\begin{gather}[a,b] = c\\end{gather}"), "[a,b] = c");
	});

	it("handles starred environments like their base form", () => {
		assert.strictEqual(latexToUnicode("\\begin{alignat*}{2} x &= 1 \\end{alignat*}").trim(), "x = 1");
	});

	it("consumes the [pos] of array-family environments in TeX's order", () => {
		// \\begin{array}[t]{cc} is a legal layout form; the bracket used to leak
		// as "t]cc" next to the cells.
		assert.strictEqual(latexToUnicode("\\begin{array}[t]{cc} a & b \\end{array}").trim(), "a b");
		assert.strictEqual(latexToUnicode("\\begin{tabular}[b]{l|r} a & b \\end{tabular}").trim(), "a b");
		// tabularx takes {width}[pos]{cols} in that order.
		assert.strictEqual(latexToUnicode("\\begin{tabularx}{\\textwidth}[t]{cc} a & b \\end{tabularx}").trim(), "a b");
	});

	it("renders matrix environments as rows", () => {
		assert.strictEqual(latexToUnicode("\\begin{pmatrix}\n1 & 2 \\\\\n3 & 4\n\\end{pmatrix}").trim(), "1 2 \n3 4");
	});

	it("treats accented characters as simple fraction operands", () => {
		assert.strictEqual(latexToUnicode("\\frac{\\hat{x}}{2}"), "x̂/2");
	});

	it("keeps underscores literal inside text-mode commands", () => {
		assert.strictEqual(latexToUnicode("\\text{x_i}"), "x_i");
		assert.strictEqual(latexToUnicode("\\text{learning_rate} = 0.1"), "learning_rate = 0.1");
		assert.strictEqual(latexToUnicode("\\mathrm{x_i}"), "xᵢ");
	});
});

describe("Markdown math rendering", () => {
	it("renders \\[ ... \\] display math as a Unicode block", () => {
		const lines = renderPlain("Intro:\n\n\\[\ny_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}\n\\]\n\nAfter.");
		assert.ok(lines.some((line) => line.includes("yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ")));
		assert.ok(!lines.some((line) => line.includes("\\sum")));
		assert.ok(lines.some((line) => line.includes("After.")));
	});

	it("renders $$ ... $$ display math as a Unicode block", () => {
		const lines = renderPlain("$$\nE = mc^2\n$$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders display math with CRLF line endings", () => {
		const lines = renderPlain("\\[\r\nE = mc^2\r\n\\]\r\n");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders inline \\( ... \\) math", () => {
		const lines = renderPlain("where the weights \\(w_k\\) are shared");
		assert.ok(lines.some((line) => line.includes("where the weights wₖ are shared")));
	});

	it("renders inline $ ... $ math", () => {
		const lines = renderPlain("the value $x_i \\cdot y$ grows");
		assert.ok(lines.some((line) => line.includes("the value xᵢ · y grows")));
	});

	it("keeps underscores inside math out of emphasis", () => {
		const lines = renderPlain("\\[ a_k = b_k + x_k \\]");
		assert.ok(lines.some((line) => line.includes("aₖ = bₖ + xₖ")));
	});

	it("does not treat dollar amounts as math", () => {
		const lines = renderPlain("between $5 and $10 total");
		assert.ok(lines.some((line) => line.includes("between $5 and $10 total")));
	});

	it("does not match a closing dollar followed by a digit", () => {
		const lines = renderPlain("prices $5,$10 listed");
		assert.ok(lines.some((line) => line.includes("prices $5,$10 listed")));
	});

	it("leaves unterminated display math as plain text while streaming", () => {
		const lines = renderPlain("$$\ny_t = \\sum");
		assert.ok(lines.some((line) => line.includes("$$")));
	});

	it("renders math inside list items", () => {
		const lines = renderPlain("- gradient \\(\\nabla_\\theta J\\) step");
		assert.ok(lines.some((line) => line.includes("- gradient ∇_θ J step")));
	});

	it("renders display math blocks inside list items", () => {
		const lines = renderPlain(
			"1. The sum:\n\n   \\[\n   \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n   \\]\n\n2. Next item",
		);
		assert.ok(lines.some((line) => line.includes("∑ₖ₌₁ⁿ k = (n(n+1))/2")));
		assert.ok(!lines.some((line) => line.includes("\\sum")));
		assert.ok(lines.some((line) => line.includes("2. Next item")));
	});

	it("renders $$ display math inside list items", () => {
		const lines = renderPlain("- item:\n\n  $$\n  E = mc^2\n  $$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders display math indented four spaces instead of treating it as code", () => {
		const lines = renderPlain("Math:\n\n    \\[\n    E = mc^2\n    \\]\n\n    $$\n    a^2 + b^2 = c^2\n    $$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
		assert.ok(lines.some((line) => line.includes("a² + b² = c²")));
		assert.ok(!lines.some((line) => line.includes("\\[")));
	});

	it("still lexes indented code that is not math as a code block", () => {
		const lines = renderPlain("Code:\n\n    const x = 1;\n    return x;");
		assert.ok(lines.some((line) => line.includes("const x = 1;")));
	});

	it("leaves LaTeX inside fenced code blocks untouched", () => {
		const lines = renderPlain("```latex\n\\[\nE = mc^2\n\\]\n```");
		assert.ok(lines.some((line) => line.includes("\\[")));
		assert.ok(lines.some((line) => line.includes("E = mc^2")));
		assert.ok(!lines.some((line) => line.includes("E = mc²")));
	});

	it("leaves math delimiters inside inline code spans untouched", () => {
		const lines = renderPlain("run `echo $PATH$HOME` and `$x_i$` now");
		assert.ok(lines.some((line) => line.includes("echo $PATH$HOME")));
		assert.ok(lines.some((line) => line.includes("$x_i$")));
	});

	it("joins multi-line inline math with spaces", () => {
		const lines = renderPlain("a \\(x +\ny\\) b");
		assert.ok(lines.some((line) => line.includes("a x + y b")));
	});

	it("falls back to code/codeBlock theme styles", () => {
		const markdown = new Markdown("$$x + y$$", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const mathLine = lines.find((line) => stripAnsi(line).includes("x + y"));
		assert.ok(mathLine);
		assert.ok(mathLine.includes("\x1b[32m"));
	});

	it("produces identical output for streamed and fresh renders", () => {
		const part1 = "Some intro text.\n\n$$\ny_t = \\sum_{k=0}^{W-1} w_k\n$$\n\n";
		const part2 = "And inline \\(x_i\\) afterwards.";
		const streamed = new Markdown(part1, 0, 0, defaultMarkdownTheme);
		streamed.render(80);
		streamed.setText(part1 + part2);
		const streamedLines = streamed.render(80);
		const freshLines = new Markdown(part1 + part2, 0, 0, defaultMarkdownTheme).render(80);
		assert.deepStrictEqual(streamedLines, freshLines);
	});
});
