import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Pathological-input streaming fixtures (same technique as the wave-49 keys
// byte fixtures: pin the shapes a sibling tool froze on, assert our pipeline
// neither crashes nor drifts). Corpus shapes from the Claude Code 2.1.289
// changelog:
//   https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
// - "Fixed the terminal freezing on short code blocks with many unclosed
//   `<script>` tags or deeply nested `${` substitutions"
// - "Fixed text with a tab, a stray escape and a C1 control, or a short text
//   with a tab and CRLF line endings, drawing over the rows below it"
//
// Every corpus is streamed at chunk sizes 1/3/7/16 (UTF-16 code units, the
// component's input granularity) and each streamed frame must render
// byte-identically to a fresh one-shot full render of the same prefix. The
// per-test timeout is the anti-exponential watchdog: a lexer/wrap blowup on
// these shapes shows up as a hang, not a wrong string.

// 1. Short code block carrying many unclosed <script> tags.
const SCRIPT_FENCE = `\`\`\`html\n${'<script src="https://example.com/x.js">\n'.repeat(40)}<script>\n`;
// Same tags without a fence: marked's html-block rule for <script> swallows
// everything to the next </script>, so the growing tail re-types the block.
const SCRIPT_RAW = `${Array.from({ length: 40 }, (_, i) => `<script data-id="${i}">`).join("\n")}\ntext after`;

// 2. Deeply nested ${ template substitutions, closed and unclosed.
const NESTED_TEMPLATE = `\`\`\`js\nconst a = \`${"${`".repeat(60)}x${"`}".repeat(60)}\`;\n\`\`\`\n`;
const NESTED_TEMPLATE_UNCLOSED = `\`\`\`js\nconst a = \`${"${`".repeat(80)}never closed\n`;
// Outside a fence the same flood hits the inline lexer: `$` is a math
// delimiter, so every arriving "$" re-pairs the whole run and the rendered
// text of the growing line changes non-monotonically (an opener sealed as
// plain text gains its closer).
const DOLLAR_RUN_INLINE = `text ${"${".repeat(200)} tail`;
const DOLLAR_RUN_INLINE_CLOSED = `text ${"${".repeat(100)}x${"}$".repeat(100)} tail`;

// 3. Tab + stray escape + C1 controls + CRLF, and the short tab+CRLF shape.
const TAB_C1_CRLF = `${Array.from({ length: 24 }, (_, i) => `row${i}\tcol\x1b\x85c\x9bmixed\x9c`).join("\r\n")}\r\n`;
const SHORT_TAB_CRLF = "a\tb\r\nc\td\r\n";

const WIDTH = 80;
const CHUNK_SIZES = [1, 3, 7, 16];

function full(text: string): string {
	// A fresh component always lexes and renders in full; this is the oracle.
	return new Markdown(text, 1, 0, defaultMarkdownTheme).render(WIDTH).join("\n");
}

function assertStreamedIdentity(name: string, doc: string): void {
	for (const step of CHUNK_SIZES) {
		const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
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
			assert.strictEqual(got, full(text), `${name} step=${step} frame at ${end}`);
			if (end >= doc.length) break;
		}
	}
}

describe("markdown pathological corpus streaming identity", () => {
	it("unclosed <script> tags inside a short fence", { timeout: 60_000 }, () => {
		assertStreamedIdentity("script-fence", SCRIPT_FENCE);
	});

	it("unclosed <script> tags as a raw html stream", { timeout: 60_000 }, () => {
		assertStreamedIdentity("script-raw", SCRIPT_RAW);
	});

	it("deeply nested template substitutions in a fence", { timeout: 60_000 }, () => {
		assertStreamedIdentity("nested-template", NESTED_TEMPLATE);
		assertStreamedIdentity("nested-template-unclosed", NESTED_TEMPLATE_UNCLOSED);
	});

	it("a run of ${ hitting inline math pairing", { timeout: 60_000 }, () => {
		assertStreamedIdentity("dollar-run-inline", DOLLAR_RUN_INLINE);
		assertStreamedIdentity("dollar-run-inline-closed", DOLLAR_RUN_INLINE_CLOSED);
	});

	it("tab + stray escape + C1 controls with CRLF endings", { timeout: 60_000 }, () => {
		assertStreamedIdentity("tab-c1-crlf", TAB_C1_CRLF);
		assertStreamedIdentity("short-tab-crlf", SHORT_TAB_CRLF);
	});
});
