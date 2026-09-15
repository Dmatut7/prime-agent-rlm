import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string, input: number, output: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai",
		provider: "openai",
		model: "m",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function transcriptFile(dir: string, name: string, messageCount: number): string {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: `stats-${name}`,
			timestamp: "2026-01-01T00:00:00Z",
			cwd: dir,
		}),
	];
	for (let index = 0; index < messageCount; index++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `e${index + 1}`,
				parentId: index === 0 ? null : `e${index}`,
				timestamp: "2026-01-01T00:00:00Z",
				message: index % 2 === 0 ? userMessage(`turn ${index}`) : assistantMessage(`answer ${index}`, 10, 2),
			}),
		);
	}
	const path = join(dir, `${name}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** The proposition: the O(1) stats always describe exactly what getEntries() returns. */
function expectStatsMatchEntries(manager: SessionManager): void {
	const entries = manager.getEntries();
	const stats = manager.getEntryStats();
	expect(stats.count).toBe(entries.length);
	expect(stats.tailId).toBe(entries.at(-1)?.id);
}

describe("SessionManager incremental entry stats", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `entry-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("matches getEntries() after opening a transcript", () => {
		const manager = SessionManager.open(transcriptFile(tempDir, "open", 5));
		expectStatsMatchEntries(manager);
	});

	it("advances with appends of every entry-writing kind", () => {
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		expect(manager.getEntryStats()).toEqual({ count: 0, tailId: undefined });
		const firstId = manager.appendMessage(userMessage("first"));
		expectStatsMatchEntries(manager);
		expect(manager.getEntryStats().tailId).toBe(firstId);
		manager.appendMessage(assistantMessage("answer", 5, 1));
		expectStatsMatchEntries(manager);
		manager.appendCustomEntry("probe", { x: 1 });
		expectStatsMatchEntries(manager);
		manager.appendLabelChange(firstId, "checkpoint");
		expectStatsMatchEntries(manager);
		manager.branch(firstId);
		expectStatsMatchEntries(manager);
	});

	it("rebuilds when the session file is swapped", () => {
		const manager = SessionManager.open(transcriptFile(tempDir, "swap-a", 7));
		expectStatsMatchEntries(manager);
		manager.setSessionFile(transcriptFile(tempDir, "swap-b", 3));
		expectStatsMatchEntries(manager);
	});

	it("resets for a new session", () => {
		const manager = SessionManager.open(transcriptFile(tempDir, "reset", 6));
		expect(manager.getEntryStats().count).toBe(6);
		manager.newSession();
		expect(manager.getEntryStats()).toEqual({ count: 0, tailId: undefined });
	});
});
