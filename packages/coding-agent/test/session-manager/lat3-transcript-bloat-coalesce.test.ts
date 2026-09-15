import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantUsageOf(entry: { type: string; message?: unknown }): { input: number } {
	const message = entry.message as { role?: string; usage?: { input: number } } | undefined;
	if (entry.type !== "message" || message?.role !== "assistant") throw new Error("not an assistant message entry");
	return message.usage ?? { input: 0 };
}

function fileLineCount(file: string): number {
	return readFileSync(file, "utf-8").split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * LAT-3: a long child run streams one child_usage_attributed entry per child
 * assistant message (one every ~3s on the real 103MB/101,481-line session:
 * 56,622 lines, 55.8% of the file, for 288 distinct child targets) and the
 * summarizer persists an identical agent_status line on every idle settle
 * (17,081 lines, 16.8%). Both bloat every O(lines) load/scan path. The fix
 * coalesces the on-disk attribution ledger (in-memory per-merge entries and
 * all usage folds stay exact) and drops no-op agent_status writes.
 */
describe("LAT-3 transcript bloat: attribution coalescing + agent_status no-op dedupe", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lat3-bloat-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("coalesces 20k attribution merges for one target into a bounded line count (red: one line per merge)", () => {
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file was not created");
		const targetId = manager.appendMessage(assistantMessage("parent turn", usage(100, 0)));

		const merges = 20_000;
		for (let i = 1; i <= merges; i++) {
			// childUsage is per-merge; aggregateUsage is the growing parent aggregate.
			manager.appendChildUsageAttribution(targetId, usage(1, 0), usage(100 + i, 0), "spawn_task");
		}

		// Hot-path scan cost is one JSON.parse per file line: the file must stay
		// proportional to distinct child runs, not to streamed child messages.
		// 20k merges -> first line + ceil((merges-1)/32) coalesced lines + 2 base lines.
		const lines = fileLineCount(file);
		expect(lines).toBeLessThanOrEqual(700);
		expect(lines).toBeGreaterThan(0);

		// The in-memory session keeps every per-merge entry (folds stay exact live).
		expect(manager.getEntries().filter((entry) => entry.type === "child_usage_attributed")).toHaveLength(merges);
		// The live aggregate rewrite is unchanged.
		const liveTarget = manager.getEntries().find((entry) => entry.id === targetId);
		if (!liveTarget) throw new Error("target entry missing");
		expect(assistantUsageOf(liveTarget).input).toBe(100 + merges);

		// Run-settle boundary: the run end flushes the deferred tail, exactly as
		// the child-run finally block does in agent-session.
		manager.flushChildUsageAttributions();

		// Reload: the disk ledger must fold back to the same state.
		const reloaded = SessionManager.open(file, join(tempDir, "sessions"));
		const reloadedAttributions = reloaded
			.getEntries()
			.filter((entry) => entry.type === "child_usage_attributed");
		expect(reloadedAttributions.length).toBeLessThanOrEqual(700);
		// Sum of childUsage deltas is preserved exactly.
		const childSum = reloadedAttributions.reduce(
			(sum, entry) => sum + (entry.type === "child_usage_attributed" ? entry.childUsage.input : 0),
			0,
		);
		expect(childSum).toBe(merges);
		// Newest-wins aggregate fold: the target's usage equals the final aggregate.
		const reloadedTarget = reloaded.getEntries().find((entry) => entry.id === targetId);
		if (!reloadedTarget) throw new Error("reloaded target missing");
		expect(assistantUsageOf(reloadedTarget).input).toBe(100 + merges);

		// Chain integrity: every parentId resolves on the reloaded index.
		const byId = new Map(reloaded.getEntries().map((entry) => [entry.id, entry]));
		for (const entry of reloaded.getEntries()) {
			if (entry.parentId === null || entry.parentId === undefined) continue;
			expect(byId.has(entry.parentId)).toBe(true);
		}
			});

	it("keeps per-target ledgers separate and folds both after reload", () => {
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file was not created");
		const targetA = manager.appendMessage(assistantMessage("turn A", usage(50, 0)));
		const targetB = manager.appendMessage(assistantMessage("turn B", usage(60, 0)));

		for (let i = 1; i <= 40; i++) {
			manager.appendChildUsageAttribution(targetA, usage(2, 0), usage(50 + 2 * i, 0), "spawn_task");
			manager.appendChildUsageAttribution(targetB, usage(3, 0), usage(60 + 3 * i, 0), "agent_message");
		}

		manager.flushChildUsageAttributions();
		const reloaded = SessionManager.open(file, join(tempDir, "sessions"));
		const attributions = reloaded
			.getEntries()
			.filter((entry) => entry.type === "child_usage_attributed");
		const sumA = attributions.reduce(
			(sum, entry) => sum + (entry.type === "child_usage_attributed" && entry.targetId === targetA ? entry.childUsage.input : 0),
			0,
		);
		const sumB = attributions.reduce(
			(sum, entry) => sum + (entry.type === "child_usage_attributed" && entry.targetId === targetB ? entry.childUsage.input : 0),
			0,
		);
		expect(sumA).toBe(80);
		expect(sumB).toBe(120);
		const reloadedA = reloaded.getEntries().find((entry) => entry.id === targetA);
		const reloadedB = reloaded.getEntries().find((entry) => entry.id === targetB);
		if (!reloadedA || !reloadedB) throw new Error("targets missing after reload");
		expect(assistantUsageOf(reloadedA).input).toBe(50 + 80);
		expect(assistantUsageOf(reloadedB).input).toBe(60 + 120);
			});

	it("skips identical consecutive agent_status writes but keeps real changes (red: one line per call)", () => {
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file was not created");

		// agent_status is only persisted once the session has an assistant entry.
		manager.appendMessage(assistantMessage("status turn", usage(10, 0)));
		const sameStatus = { summary: "", taskState: undefined, basedOnMessageCount: 5 } as const;
		for (let i = 0; i < 20_000; i++) {
			manager.appendAgentStatus(sameStatus);
		}
		const afterNoops = fileLineCount(file);
		expect(afterNoops).toBeLessThanOrEqual(3); // header + assistant + one status line

		manager.appendAgentStatus({ summary: "verdict: done", taskState: "completed", basedOnMessageCount: 9 });
		const reloaded = SessionManager.open(file, join(tempDir, "sessions"));
		const statuses = reloaded.getEntries().filter((entry) => entry.type === "agent_status");
		expect(statuses).toHaveLength(2);
		if (statuses[1]?.type !== "agent_status") throw new Error("missing final status");
		expect(statuses[1].status.summary).toBe("verdict: done");
		expect(statuses[1].status.taskState).toBe("completed");
		expect(manager.getLatestAgentStatus()?.summary).toBe("verdict: done");
			});
});
