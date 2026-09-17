import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	capKeepRecentTokens,
	compactionThresholdTokens,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_COMPACTION_TRIGGER_RATIO,
	MAX_COMPACTION_TRIGGER_RATIO,
	MIN_COMPACTION_TRIGGER_RATIO,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.js";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

describe("shouldCompact threshold clamp (scan2 C1)", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		reserveTokens: 16384,
		keepRecentTokens: 1000,
	};

	it("does not trigger when the reserve consumes the whole window", () => {
		expect(shouldCompact(50_000, 16_384, settings)).toBe(false);
		expect(shouldCompact(50_000, 10_000, settings)).toBe(false);
		expect(shouldCompact(50_000, 0, settings)).toBe(false);
	});

	it("still triggers above a positive threshold", () => {
		// The reserve ceiling wins here: min(30000 * 0.8, 30000 - 16384) = 13616.
		expect(compactionThresholdTokens(30_000, settings)).toBe(13_616);
		expect(shouldCompact(20_000, 30_000, settings)).toBe(true);
		expect(shouldCompact(13_616, 30_000, settings)).toBe(false);
	});
});

describe("trigger ratio and measured input limit", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		reserveTokens: 16384,
		keepRecentTokens: 20_000,
	};

	it("fires at the configured share of the window when the reserve ceiling is higher", () => {
		// 1M window, default ratio 0.8 -> 800000, well below 1000000 - 16384.
		expect(compactionThresholdTokens(1_000_000, settings)).toBe(800_000);
		expect(shouldCompact(800_001, 1_000_000, settings)).toBe(true);
		expect(shouldCompact(800_000, 1_000_000, settings)).toBe(false);
		// The old trigger (window - reserve = 983616) would not have fired yet: that
		// gap is exactly where an ordinary request hit the provider's input wall first.
		expect(shouldCompact(900_000, 1_000_000, settings)).toBe(true);
	});

	it("clamps the base to the provider's measured input limit", () => {
		// kimi-k3 declares 1048576 and accepts 1000000 (model-input-limits.ts).
		const limits = { provider: "bailian", modelId: "kimi-k3" };
		expect(compactionThresholdTokens(1_048_576, settings, limits)).toBe(800_000);
		expect(shouldCompact(820_000, 1_048_576, settings)).toBe(false);
		expect(shouldCompact(820_000, 1_048_576, settings, limits)).toBe(true);
		// qwen3.8-max-0902 declares 1000000 and accepts 983616.
		const qwen = { provider: "bailian", modelId: "qwen3.8-max-0902" };
		expect(compactionThresholdTokens(1_000_000, settings, qwen)).toBe(Math.floor(983_616 * 0.8));
	});

	it("honors a configured ratio inside the bounds", () => {
		expect(compactionThresholdTokens(100_000, { ...settings, triggerRatio: 0.5 })).toBe(50_000);
		// A small reserve so the ratio, not the reserve ceiling, is what binds.
		const loose = { ...settings, reserveTokens: 1000 };
		expect(compactionThresholdTokens(100_000, { ...loose, triggerRatio: 0.95 })).toBe(95_000);
		expect(compactionThresholdTokens(100_000, { ...loose, triggerRatio: 0.8 })).toBe(80_000);
	});

	it("validates an out-of-range or unusable ratio instead of disabling the trigger", () => {
		// Below the floor: would compact constantly. Above the ceiling: no headroom
		// left for the estimator's error. Non-finite/absent: the default.
		expect(compactionThresholdTokens(100_000, { ...settings, triggerRatio: 0.1 })).toBe(
			Math.floor(100_000 * MIN_COMPACTION_TRIGGER_RATIO),
		);
		expect(compactionThresholdTokens(100_000, { ...settings, triggerRatio: 1.4 })).toBe(
			Math.min(Math.floor(100_000 * MAX_COMPACTION_TRIGGER_RATIO), 100_000 - settings.reserveTokens),
		);
		expect(compactionThresholdTokens(100_000, { ...settings, reserveTokens: 1000, triggerRatio: 1.4 })).toBe(
			Math.floor(100_000 * MAX_COMPACTION_TRIGGER_RATIO),
		);
		expect(compactionThresholdTokens(100_000, { ...settings, triggerRatio: Number.NaN })).toBe(
			Math.floor(100_000 * DEFAULT_COMPACTION_TRIGGER_RATIO),
		);
	});
});

describe("capKeepRecentTokens (scan2 C1)", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		reserveTokens: 1000,
		keepRecentTokens: 50_000,
	};

	it("caps keepRecent at the trigger threshold", () => {
		// min(30000 * 0.8, 30000 - 1000) = 24000: the cap follows the same threshold
		// the trigger uses, or a retained slice could sit above it by construction and
		// re-fire compaction every turn.
		expect(capKeepRecentTokens(settings, 30_000)).toBe(24_000);
		expect(capKeepRecentTokens(settings, 30_000)).toBe(compactionThresholdTokens(30_000, settings));
	});

	it("leaves keepRecent alone without a window or if already small", () => {
		expect(capKeepRecentTokens(settings, undefined)).toBe(50_000);
		expect(capKeepRecentTokens(settings, 0)).toBe(50_000);
		expect(capKeepRecentTokens({ ...settings, keepRecentTokens: 500 }, 30_000)).toBe(500);
	});

	it("caps to zero when the reserve exceeds the window", () => {
		expect(capKeepRecentTokens(settings, 800)).toBe(0);
	});
});

describe("prepareCompaction keepRecent cap (scan2 C1)", () => {
	it("cuts deeper when the window caps keepRecent", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 6; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i} ${"y".repeat(4000)}`)));
			entries.push(createMessageEntry(createAssistantMessage(`Assistant ${i} ${"a".repeat(400)}`)));
		}
		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			reserveTokens: 500,
			keepRecentTokens: 3000,
		};
		const indexOf = (id: string | undefined) => entries.findIndex((entry) => entry.id === id);

		const uncapped = prepareCompaction(entries, settings);
		// window 2500 - reserve 500 = threshold 2000, below keepRecent 3000.
		const capped = prepareCompaction(entries, settings, 2500);

		expect(uncapped).toBeDefined();
		expect(capped).toBeDefined();
		expect(capped!.firstKeptEntryId).not.toBe(uncapped!.firstKeptEntryId);
		// A smaller effective keepRecent keeps less recent context, so the first
		// kept entry sits deeper in the branch.
		expect(indexOf(capped!.firstKeptEntryId)).toBeGreaterThan(indexOf(uncapped!.firstKeptEntryId));
	});
});
