/**
 * Symptom A: on a 1M-context model the trigger used to be
 * `contextWindow - reserveTokens` (~98.4% of the window) while the estimate priced
 * every character at chars/4, which under-counts CJK by ~1.6x. The two errors push
 * the same way, so an ordinary request hit the provider's input wall (DashScope
 * answers an oversized prompt with HTTP 400) before compaction ever fired.
 *
 * These pins hold the two halves of the fix: the trigger is a ratio of the real
 * input limit, and the estimate that feeds it is content-density priced.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	compactionThresholdTokens,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	estimateTokensByContent,
	measureContentDensity,
	shouldCompact,
} from "../src/core/compaction/index.js";

/** Chinese prose: about one token per 1.5 characters, not per four. */
const CJK_SENTENCE = "压缩必须在供应商输入墙之前触发，否则普通请求先收到四百错误。";
const ASCII_SENTENCE = "Compaction has to fire before the provider's input wall, or the request 400s first.";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("content-density estimate caliber", () => {
	it("prices CJK text above the flat chars/4 caliber", () => {
		const text = CJK_SENTENCE.repeat(20);
		const flat = estimateTokens(userMessage(text));
		const corrected = estimateTokensByContent(userMessage(text));
		// CJK is priced at 1.5 chars/token against the flat 4: at least 1.5x, and the
		// measured ratio for this sentence is close to 4 / 1.5.
		expect(corrected).toBeGreaterThan(flat * 1.5);
		expect(measureContentDensity(text).densityRatio).toBeGreaterThan(1.5);
	});

	it("leaves plain ASCII prose at the flat caliber (the correction is not a blanket inflation)", () => {
		const text = ASCII_SENTENCE.repeat(20);
		expect(estimateTokensByContent(userMessage(text))).toBe(estimateTokens(userMessage(text)));
	});

	it("prices fenced code above the flat caliber", () => {
		const text = "```ts\nconst a = 1;\nconst b = a + 2;\n```";
		expect(estimateTokensByContent(userMessage(text))).toBeGreaterThan(estimateTokens(userMessage(text)));
	});
});

describe("trigger caliber on a CJK-heavy context", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		reserveTokens: 100,
		keepRecentTokens: 200,
	};
	const contextWindow = 1000;
	const threshold = compactionThresholdTokens(contextWindow, settings);

	it("triggers at the configured share of the window", () => {
		// min(1000 * 0.8, 1000 - 100) = 800.
		expect(threshold).toBe(800);
	});

	it("fires where the flat caliber stayed silent", () => {
		// 1350 CJK characters: ~900 real tokens, but only ~338 by chars/4.
		const text = CJK_SENTENCE.repeat(45);
		expect(text.length).toBeGreaterThan(1300);
		const messages = [userMessage(text)];
		const flat = messages.reduce((total, message) => total + estimateTokens(message), 0);
		const corrected = estimateContextTokens(messages).tokens;

		expect(flat).toBeLessThan(threshold);
		expect(corrected).toBeGreaterThan(threshold);
		// The trigger reads the corrected caliber, so it fires.
		expect(shouldCompact(corrected, contextWindow, settings)).toBe(true);
		// Control: the same context under the old caliber would not have fired, which
		// is the bug - the estimate said "38% full" while the provider was at "90%".
		expect(shouldCompact(flat, contextWindow, settings)).toBe(false);
	});

	it("clamps the trigger base to the provider's measured input limit", () => {
		// kimi-k3: models.json declares 1048576, DashScope accepts 1000000. Without the
		// clamp the trigger would sit above what the provider takes as input.
		const limits = { provider: "bailian", modelId: "kimi-k3" };
		const big: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 16384 };
		expect(compactionThresholdTokens(1_048_576, big, limits)).toBe(800_000);
		expect(compactionThresholdTokens(1_048_576, big)).toBe(Math.floor(1_048_576 * 0.8));
	});
});
