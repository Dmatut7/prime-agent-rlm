import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/index.js";
import { SubagentLane } from "../src/modes/interactive/components/agent-message.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { at, createReplayHost, replayInto, screenOf, summariesOf } from "./tl-fc-host.js";
import { assistant } from "./ui-blocks-helpers.js";
import { handedBack } from "./ui-live-chat.js";

/**
 * The subagent lane for a view that has learned nothing of its own (a window opened on a running
 * session), and for a rebuild that crosses from one question into the next.
 */

const W = 160;
const A = "review-grow-A-tui";
const B = "review-grow-B-box";
const C = "review-grow-C-strip";
const D = "review-grow-D-hygiene";
const E = "review-grow-E-extra";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(at(19, 30));
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

function child(
	name: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"] = "running",
	parentId?: string,
): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: `id-${name}`,
		...(parentId ? { parentId } : {}),
		activeSessionId: `${name}-active`,
		sessionName: name,
		label: `${name} 的任务`,
		status,
		sessionDir: `/tmp/${name}`,
	};
}

function report(id: string, name: string, ts: number): AgentSessionMessage {
	return handedBack(id, ts, name, `车道（${name}）审查完成。\n结论：没问题。`);
}

function command(id: string, start: number) {
	return {
		id,
		code: `r = await bash("echo ${id}")`,
		endsAt: start + 3_000,
		details: {
			activities: [
				{
					id: `${id}-a`,
					kind: "command",
					label: `echo ${id}`,
					status: "ok",
					detail: "",
					startedAt: start,
					endedAt: start + 3_000,
				},
			],
		},
	};
}

function step(ts: number, words: string, id: string): AgentMessage[] {
	const cmd = command(id, ts);
	return [
		assistant(
			ts,
			[
				{ type: "text", text: words },
				{ type: "toolCall", id, name: "ipython", arguments: { code: cmd.code } },
			],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "ipython",
			content: [{ type: "text", text: "ok" }],
			details: cmd.details,
			isError: false,
			timestamp: ts + 3_000,
		},
	];
}

const laneOf = (rows: readonly string[], needle: string): string => {
	const row = rows.find((candidate) => candidate.includes(needle));
	expect(row, `a row with ${needle}`).toBeDefined();
	return (row ?? "").slice(10, 13);
};

describe("a window opened on a running session, whose dispatch it cannot see", () => {
	const EARLY = "趁它们干活，我先看代码。";
	const LATE = "还在等它们。";

	/** What a compaction leaves: the question and the dispatch were summarized away. */
	const compacted = (): AgentMessage[] => [...step(at(18, 50), EARLY, "c1"), ...step(at(18, 52), LATE, "c2")];

	it("draws the subagents the session says are running as out, on every row of the window", async () => {
		const host = createReplayHost([child(A), child(B)]);
		await replayInto(host, compacted(), { clearChat: true, limitTranscript: true });
		const summary = summariesOf(host)[0]!;
		expect(summary.state.timeline.laneTracker?.pending).toEqual([A, B]);
		const rows = screenOf(host, W);
		expect(laneOf(rows, EARLY)).toBe("  ┆");
		expect(laneOf(rows, LATE)).toBe("  ┆");
	});

	it("draws them out when the context starts at a compaction summary and a step is still running", async () => {
		const host = createReplayHost([child(A), child(B)]);
		(host.connectionState as { isStreaming: boolean }).isStreaming = true;
		const running = assistant(
			at(18, 52),
			[
				{ type: "text", text: LATE },
				{ type: "toolCall", id: "c2", name: "ipython", arguments: { code: "await bash('sleep 60')" } },
			],
			"toolUse",
		);
		await replayInto(
			host,
			[
				{ role: "compactionSummary", summary: "## 目标\n审查", tokensBefore: 166_000, timestamp: at(18, 49) },
				...step(at(18, 50), EARLY, "c1"),
				running,
			],
			{ clearChat: true, limitTranscript: true },
		);
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([A, B]);
		expect(laneOf(screenOf(host, W), EARLY)).toBe("  ┆");
	});

	it("lets them come back: the report of the last one closes the lane", async () => {
		const host = createReplayHost([child(A), child(B)]);
		await replayInto(host, [...compacted(), report("m1", A, at(18, 55)), report("m2", B, at(18, 56))], {
			clearChat: true,
			limitTranscript: true,
		});
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([]);
		const rows = screenOf(host, W);
		expect(rows.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd())).toEqual([
			"         ├──╯   两个都交回了",
		]);
	});

	it("leaves out a child that is not running, one of another parent, and one that was cancelled", async () => {
		const host = createReplayHost([
			child(A),
			child(B, "done"),
			child(C, "cancelled"),
			child(D, "running", "someone-else"),
		]);
		await replayInto(host, compacted(), { clearChat: true, limitTranscript: true });
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([A]);
	});

	it("draws no lane when nothing is running", async () => {
		const host = createReplayHost([child(A, "done")]);
		await replayInto(host, compacted(), { clearChat: true, limitTranscript: true });
		const rows = screenOf(host, W);
		expect(laneOf(rows, EARLY)).toBe("   ");
		expect(laneOf(rows, LATE)).toBe("   ");
	});

	it("does not add a child whose dispatch the window shows: it goes out once, at the dispatch", async () => {
		const host = createReplayHost([child(A)]);
		const dispatch = {
			activities: [
				{
					id: "s-a",
					kind: "subagent",
					label: A,
					status: "ok",
					detail: "glm-5.3-prime",
					startedAt: at(18, 48, 1),
					endedAt: at(18, 48, 2),
				},
			],
		};
		await replayInto(
			host,
			[
				{ role: "user", content: "审查", timestamp: at(18, 47) },
				assistant(
					at(18, 48),
					[{ type: "toolCall", id: "spawn", name: "ipython", arguments: { code: "await rlm.spawn(...)" } }],
					"toolUse",
				),
				{
					role: "toolResult",
					toolCallId: "spawn",
					toolName: "ipython",
					content: [{ type: "text", text: "ok" }],
					details: dispatch,
					isError: false,
					timestamp: at(18, 48, 3),
				},
				...step(at(18, 50), EARLY, "c1"),
			],
			{ clearChat: true, limitTranscript: true },
		);
		const rows = screenOf(host, W);
		expect(rows.filter((row) => row.includes("├──╮"))).toHaveLength(1);
		expect(laneOf(rows, EARLY)).toBe("  ┆");
	});

	describe("a long turn that opens on its tail", () => {
		function longTranscript(): AgentMessage[] {
			const messages: AgentMessage[] = [
				{ role: "user", content: "审查", timestamp: at(18, 47) },
				...step(at(18, 48), "派一个去审查。", "spawn"),
			];
			for (let index = 0; index < 210; index++) {
				messages.push(...step(at(18, 50) + index * 20_000, `第 ${index} 步。`, `f${index}`));
			}
			return messages;
		}

		it("keeps the running subagent out on the last event, as the whole turn would", async () => {
			const host = createReplayHost([child(A)]);
			await replayInto(host, longTranscript(), { clearChat: true, limitTranscript: true });
			const summary = summariesOf(host)[0]!;
			expect(summary.state.timeline.earlierSteps).toBeGreaterThan(0);
			expect(summary.state.timeline.laneTracker?.pending).toEqual([A]);
			expect(laneOf(screenOf(host, W), "第 209 步。")).toBe("  ┆");
		});

		it("does not carry a subagent that is not running over", async () => {
			const host = createReplayHost([child(A, "done")]);
			await replayInto(host, longTranscript(), { clearChat: true, limitTranscript: true });
			expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([]);
			expect(laneOf(screenOf(host, W), "第 209 步。")).toBe("   ");
		});
	});
});

describe("a rebuild that crosses into a new question", () => {
	it("does not count the earlier question's returns among the new question's", () => {
		const earlier = new SubagentLane();
		earlier.tracker.spawned([A, B, C], undefined, at(18, 48));
		earlier.comeBack(A, undefined, at(18, 50));
		earlier.comeBack(B, undefined, at(18, 51));
		const snapshot = earlier.snapshot();
		expect(snapshot.back).toBe(2);

		// The owner asked something new while this view was away.
		const fresh = new SubagentLane();
		fresh.tracker.spawned([D, E], undefined, at(19, 30));
		fresh.restore(snapshot, at(19, 29));
		expect(fresh.tracker.pending).toEqual([D, E]);
		fresh.comeBack(D, undefined, at(19, 35));
		const last = fresh.comeBack(E, undefined, at(19, 36));
		expect(last.joined).toBe(2);
	});

	it("does not carry an earlier failure into the new question's tally either", () => {
		const earlier = new SubagentLane();
		earlier.tracker.spawned([A, B, C], undefined, at(18, 48));
		earlier.comeBack(A, undefined, at(18, 50), "failed");
		earlier.comeBack(B, undefined, at(18, 51), "silent");
		const fresh = new SubagentLane();
		fresh.tracker.spawned([D, E], undefined, at(19, 30));
		fresh.restore(earlier.snapshot(), at(19, 29));
		fresh.comeBack(D, undefined, at(19, 35));
		const last = fresh.comeBack(E, undefined, at(19, 36));
		expect(last.joined).toBe(2);
		expect(last.tally).toBeUndefined();
	});

	it("keeps the counts of the question the rebuild ends in", () => {
		const running = new SubagentLane();
		running.tracker.spawned([A, B, C], undefined, at(19, 30));
		running.comeBack(A, undefined, at(19, 32));
		running.comeBack(B, undefined, at(19, 33), "failed");
		const snapshot = running.snapshot();
		// A resync replays the question from its start and finds neither dispatch nor returns of it.
		const rebuilt = new SubagentLane();
		rebuilt.restore(snapshot, at(19, 29));
		expect(rebuilt.tracker.pending).toEqual([C]);
		const last = rebuilt.comeBack(C, undefined, at(19, 40));
		expect(last.joined).toBe(3);
		expect(last.tally).toEqual({ failed: 1, silent: 0, cancelled: 0 });
	});

	it("keeps them when it is not told where the question began", () => {
		const running = new SubagentLane();
		running.tracker.spawned([A, B], undefined, at(18, 48));
		running.comeBack(A, undefined, at(18, 50));
		const rebuilt = new SubagentLane();
		rebuilt.restore(running.snapshot());
		const last = rebuilt.comeBack(B, undefined, at(18, 55));
		expect(last.joined).toBe(2);
	});
});
