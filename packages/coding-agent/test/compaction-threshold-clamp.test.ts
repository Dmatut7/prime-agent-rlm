import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	capKeepRecentTokens,
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
	const settings: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 1000 };

	it("does not trigger when the reserve consumes the whole window", () => {
		expect(shouldCompact(50_000, 16_384, settings)).toBe(false);
		expect(shouldCompact(50_000, 10_000, settings)).toBe(false);
		expect(shouldCompact(50_000, 0, settings)).toBe(false);
	});

	it("still triggers above a positive threshold", () => {
		// threshold = 30000 - 16384 = 13616
		expect(shouldCompact(20_000, 30_000, settings)).toBe(true);
		expect(shouldCompact(13_616, 30_000, settings)).toBe(false);
	});
});

describe("capKeepRecentTokens (scan2 C1)", () => {
	const settings: CompactionSettings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 50_000 };

	it("caps keepRecent at the post-reserve threshold", () => {
		expect(capKeepRecentTokens(settings, 30_000)).toBe(29_000);
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
		const settings: CompactionSettings = { enabled: true, reserveTokens: 500, keepRecentTokens: 3000 };
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
