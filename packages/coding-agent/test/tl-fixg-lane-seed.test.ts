import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/index.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import {
	buildSubagentPanelRows,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { LaneSpans, TimelineLaneTracker, timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { at, createReplayHost, replayInto, screenOf } from "./tl-fc-host.js";
import { assistant } from "./ui-blocks-helpers.js";

/**
 * A window opened on a running session seeds the child as out from the start of what it shows; the
 * dispatch the window does hold says when it really went out, and rows before that are not on the lane.
 */

const W = 160;
const A = "review-grow-A-tui";

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

function child(name: string): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: `id-${name}`,
		activeSessionId: `${name}-active`,
		sessionName: name,
		label: `${name} 的任务`,
		status: "running",
		sessionDir: `/tmp/${name}`,
	};
}

function commandDetails(id: string, start: number) {
	return {
		activities: [
			{
				id: `${id}-a`,
				kind: "command",
				label: `echo ${id}`,
				status: "ok",
				detail: "",
				startedAt: start,
				endedAt: start + 2_000,
			},
		],
	};
}

function call(ts: number, words: string, id: string, code: string): AgentMessage {
	return assistant(
		ts,
		[
			{ type: "text", text: words },
			{ type: "toolCall", id, name: "ipython", arguments: { code } },
		],
		"toolUse",
	);
}

function result(id: string, ts: number, details: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: ts,
	};
}

function step(ts: number, words: string, id: string): AgentMessage[] {
	return [call(ts, words, id, `r = await bash("echo ${id}")`), result(id, ts + 500, commandDetails(id, ts))];
}

const SPAWN_DETAILS = {
	activities: [
		{
			id: "s-a",
			kind: "subagent",
			label: A,
			status: "ok",
			detail: "glm-5.3-prime",
			startedAt: at(18, 48, 10),
			endedAt: at(18, 48, 11),
		},
	],
};

/** 400+ messages: the question is cut out of the window, the dispatch stays in it. */
function dispatchInsideWindow(): AgentMessage[] {
	const messages: AgentMessage[] = [{ role: "user", content: "审查", timestamp: at(18, 47) }];
	for (let index = 0; index < 200; index++) {
		messages.push(...step(at(18, 47, 10) + index * 1_000, `第 ${index} 步。`, `f${index}`));
	}
	messages.push(...step(at(18, 48, 5), "先看前面。", "pre"));
	messages.push(call(at(18, 48, 10), "派一个去审查。", "spawn", "await rlm.spawn(...)"));
	messages.push(result("spawn", at(18, 48, 12), SPAWN_DETAILS));
	for (let index = 0; index < 3; index++) {
		messages.push(...step(at(18, 50) + index * 2_000, `派出后第 ${index} 步。`, `g${index}`));
	}
	return messages;
}

const lane = (row: string): string => row.slice(10, 13);

function rowWith(rows: readonly string[], needle: string): string {
	const row = rows.find((candidate) => candidate.includes(needle));
	expect(row, `a row with ${needle}`).toBeDefined();
	return row ?? "";
}

describe("a window that holds the dispatch of a child the session says is running", () => {
	it("keeps the rows before the dispatch off the lane and the rows after it on", async () => {
		const host = createReplayHost([child(A)]);
		await replayInto(host, dispatchInsideWindow(), { clearChat: true, limitTranscript: true });
		const rows = screenOf(host, W);
		const dispatch = rows.findIndex((row) => row.includes("派一个去审查"));
		expect(dispatch).toBeGreaterThan(0);
		const before = rows.slice(0, dispatch).filter((row) => row.trim().length > 0);
		expect(before.length).toBeGreaterThan(0);
		expect(before.filter((row) => lane(row) === "  ┆")).toEqual([]);
		expect(lane(rowWith(rows, "先看前面。"))).toBe("   ");
		expect(lane(rowWith(rows, "派出后第 0 步。"))).toBe("  ┆");
	});

	it("has the same gutter on every row as a window that had no snapshot to seed from", async () => {
		const seeded = createReplayHost([child(A)]);
		await replayInto(seeded, dispatchInsideWindow(), { clearChat: true, limitTranscript: true });
		const bare = createReplayHost([]);
		await replayInto(bare, dispatchInsideWindow(), { clearChat: true, limitTranscript: true });
		// The snapshot adds the child's task to the dispatch row; the time, main line and lane columns are the point.
		const gutters = (host: typeof seeded) => screenOf(host, W).map((row) => row.slice(0, 13));
		expect(gutters(seeded).length).toBeGreaterThan(0);
		expect(gutters(seeded)).toEqual(gutters(bare));
	});
});

describe("a lane span that is already open", () => {
	it("takes the later of its start and the time it is told it went out", () => {
		const spans = new LaneSpans();
		spans.open("A", 1_000);
		spans.open("A", 5_000);
		expect(spans.snapshot().spans).toEqual([{ name: "A", from: 5_000 }]);
		spans.open("A", 3_000);
		expect(spans.snapshot().spans).toEqual([{ name: "A", from: 5_000 }]);
	});

	it("is not moved by a dispatch that names no time of its own", () => {
		const tracker = new TimelineLaneTracker();
		tracker.spawned(["A"], undefined, 1_000);
		vi.setSystemTime(at(23, 0));
		tracker.spawned(["A"]);
		expect(tracker.spans.snapshot().spans).toEqual([{ name: "A", from: 1_000 }]);
	});
});

describe("a rebuild takes back who came back as well as who was out", () => {
	it("keeps a return the replay could not see, so a child that never was on the lane stays back", () => {
		const before = new TimelineLaneTracker();
		before.noteReturned("X", at(18, 55));
		const after = new TimelineLaneTracker();
		after.restore(before.snapshot());
		expect(after.spans.returnedAt("X")).toBe(at(18, 55));
	});

	it("leaves out a return older than the question the replay ends in", () => {
		const before = new TimelineLaneTracker();
		before.noteReturned("X", at(18, 40));
		const after = new TimelineLaneTracker();
		after.restore(before.snapshot(), at(18, 47));
		expect(after.spans.returnedAt("X")).toBeUndefined();
	});

	it("keeps the return the replay learned itself", () => {
		const before = new TimelineLaneTracker();
		before.noteReturned("X", at(18, 55));
		const after = new TimelineLaneTracker();
		after.noteReturned("X", at(18, 58));
		after.restore(before.snapshot());
		expect(after.spans.returnedAt("X")).toBe(at(18, 58));
	});
});

describe("two subagents whose names shorten to the same letter", () => {
	const WIDTH = 160;

	function strip(names: string[]): string {
		const rows = buildSubagentPanelRows(
			names.map((name, index) => ({ ...child(name), id: `c${index}` })),
			undefined,
		);
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
		line.setSubagentRows(rows);
		line.setOpenable(true);
		return stripAnsi(line.render(WIDTH)[0] ?? "");
	}

	it("show their own names, so the blocks can be told apart", () => {
		const line = strip(["audit-a-quick", "check-a-slow"]);
		expect(line).toContain("audit-a-quick");
		expect(line).toContain("check-a-slow");
		expect(line).not.toContain(" ◇ A ");
	});

	it("keep the short name when nothing else shares it", () => {
		const line = strip(["review-grow-A-tui", "review-grow-B-box"]);
		expect(line).toContain(" ◇ A ");
		expect(line).toContain(" ◇ B ");
	});

	it("keep the short name for a child that shares nothing, and give the colliding ones their names", () => {
		const line = strip(["audit-a-quick", "check-a-slow", "review-grow-B-box"]);
		expect(line).toContain("audit-a-quick");
		expect(line).toContain("check-a-slow");
		expect(line).toContain(" ◇ B ");
	});
});
