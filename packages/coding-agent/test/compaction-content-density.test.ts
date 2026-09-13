import { describe, expect, it } from "vitest";
import {
	ASCII_CHARS_PER_TOKEN,
	CJK_CHARS_PER_TOKEN,
	CODE_CHARS_PER_TOKEN,
	containsCjk,
	estimateTextTokensByContent,
	measureContentDensity,
} from "../src/core/compaction/index.js";

describe("measureContentDensity", () => {
	it("prices ASCII prose at the same chars/4 caliber as estimateTokens", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const density = measureContentDensity(text);

		expect(density.cjkChars).toBe(0);
		expect(density.codeChars).toBe(0);
		expect(density.otherChars).toBe(text.length);
		expect(density.tokens).toBe(Math.ceil(text.length / ASCII_CHARS_PER_TOKEN));
		expect(density.densityRatio).toBeCloseTo(1, 5);
	});

	it("prices CJK text as the multiple of chars/4 that a tokenizer actually spends", () => {
		// 30 CJK characters: 20 tokens at 1.5 chars/token instead of 8 at chars/4.
		const text = "老板令对客验证场禁固定脚本序列";
		const density = measureContentDensity(text);

		expect(density.cjkChars).toBe(text.length);
		expect(density.tokens).toBe(Math.ceil(text.length / CJK_CHARS_PER_TOKEN));
		expect(density.densityRatio).toBeCloseTo(ASCII_CHARS_PER_TOKEN / CJK_CHARS_PER_TOKEN, 5);
	});

	it("prices fenced code between prose and CJK", () => {
		const text = "```\nconst a = 1;\n```";
		const density = measureContentDensity(text);

		expect(density.codeChars).toBeGreaterThan(0);
		expect(density.cjkChars).toBe(0);
		expect(density.tokens).toBe(Math.ceil(text.length / CODE_CHARS_PER_TOKEN));
	});

	it("counts every character exactly once", () => {
		// Mixed content, including CJK inside a fence and an unterminated fence.
		const samples = [
			"",
			"plain ascii line",
			"中文 mixed with ascii 123",
			"```\ncode 中文 line\n```",
			"```\nunterminated 中文",
			"line one\nline two\n\nline four",
			"~~~\ntilde fence\n~~~",
		];
		expect(samples.length).toBeGreaterThan(0);
		for (const text of samples) {
			const density = measureContentDensity(text);
			expect(density.totalChars).toBe(text.length);
			expect(density.cjkChars + density.codeChars + density.otherChars).toBe(text.length);
			expect(density.tokens).toBeGreaterThan(0 === text.length ? -1 : 0);
			expect(density.tokens).toBe(estimateTextTokensByContent(text));
		}
	});

	it("reads a CJK-heavy transcript higher than chars/4, which is the direction that is safe", () => {
		const ascii = "keepRecentTokens caps the retained slice at twenty thousand tokens.";
		const cjk = "切割点不许落在 turn 中间，保留区必须从用户消息开始，附录按内容密度计费。";
		expect(containsCjk(ascii)).toBe(false);
		expect(containsCjk(cjk)).toBe(true);
		expect(measureContentDensity(cjk).densityRatio).toBeGreaterThan(measureContentDensity(ascii).densityRatio);
	});

	it("treats an empty string as one flat token estimate, not a division by zero", () => {
		expect(measureContentDensity("").densityRatio).toBe(1);
		expect(measureContentDensity("").tokens).toBe(0);
	});
});
