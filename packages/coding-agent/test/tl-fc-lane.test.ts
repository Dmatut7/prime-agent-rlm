import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	createRlmChildFailureMessage,
	createRlmChildStallNoticeMessage,
	createRlmChildTerminalNoticeMessage,
} from "../src/core/messages.js";
import { joinText } from "../src/modes/interactive/components/agent-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { at, createReplayHost, plain, replayInto, screenOf, summariesOf } from "./tl-fc-host.js";
import { assistant } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * The subagent lane across the moments a turn is drawn: a round a report woke while other subagents
 * are still out, a rebuild that forgot who is out, and the words that close the lane. Every case runs
 * on the live path and on a replay of the same messages and expects the same lines.
 */

const W = 160;
const A = "review-grow-A-tui";
const B = "review-grow-B-box";
const C = "review-grow-C-strip";
const D = "review-grow-D-hygiene";

function subagentRecord(id: string, name: string, start: number) {
	return {
		id,
		kind: "subagent",
		label: name,
		status: "ok",
		detail: "glm-5.3-prime",
		startedAt: start,
		endedAt: start + 500,
	};
}

const SPAWN_AB = { activities: [subagentRecord("s-a", A, at(18, 48, 1)), subagentRecord("s-b", B, at(18, 48, 2))] };
const SPAWN_A = { activities: [subagentRecord("s-a", A, at(18, 48, 1))] };

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

function report(id: string, name: string, ts: number): AgentSessionMessage {
	return handedBack(id, ts, name, `车道（${name}）审查完成。\n结论：没问题。`);
}

function callMessage(ts: number, words: string, id: string, code: string) {
	return assistant(
		ts,
		[
			{ type: "text", text: words },
			{ type: "toolCall", id, name: "ipython", arguments: { code } },
		],
		"toolUse",
	);
}

function resultMessage(id: string, ts: number, details: unknown): AgentMessage {
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

const say = (ts: number, words: string) => assistant(ts, [{ type: "text", text: words }], "stop");

function built(messages: AgentMessage[]): string[] {
	const container = new Container();
	for (const component of buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	})) {
		container.addChild(component);
	}
	return plain(container.render(W));
}

const laneOf = (rows: readonly string[], needle: string): string => {
	const row = rows.find((candidate) => candidate.includes(needle));
	expect(row, `a row with ${needle}`).toBeDefined();
	return (row ?? "").slice(10, 13);
};

/** The row drawn straight above the first row with `needle`. */
const above = (rows: readonly string[], needle: string): string => {
	const index = rows.findIndex((row) => row.includes(needle));
	expect(index, `a row with ${needle}`).toBeGreaterThan(0);
	return rows[index - 1] ?? "";
};

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(at(18, 47));
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

const E1 = "A 回来了，B 还在跑，我先看代码。";
const E2 = "B 也回来了，我来汇总。";

/** Two subagents go out; A's report wakes the AI, and B's lands while the woken round works. */
function wokenTranscript(): AgentMessage[] {
	return [
		{ role: "user", content: "审查", timestamp: at(18, 47) },
		callMessage(at(18, 48), "派两个。", "spawn", "await rlm.spawn(...)"),
		resultMessage("spawn", at(18, 48, 3), SPAWN_AB),
		say(at(18, 49), "派出去了，等它们交回。"),
		report("m1", A, at(19, 0)),
		callMessage(at(19, 1), E1, "e1", 'r = await bash("echo e1")'),
		resultMessage("e1", at(19, 1, 3), command("e1", at(19, 1)).details),
		report("m2", B, at(19, 4)),
		callMessage(at(19, 5), E2, "e2", 'r = await bash("echo e2")'),
		resultMessage("e2", at(19, 5, 3), command("e2", at(19, 5)).details),
		say(at(19, 6), "都看完了。"),
	];
}

function wokenLive(options: { renderMidway: boolean }): LiveChat {
	const chat = new LiveChat();
	chat.setClock(at(18, 47));
	chat.user("审查");
	chat.say(at(18, 48), {
		words: "派两个。",
		calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_AB, endsAt: at(18, 48, 3) }],
	});
	chat.say(at(18, 49), { words: "派出去了，等它们交回。" });
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	vi.setSystemTime(at(19, 0));
	chat.flow.agentStart();
	chat.report(report("m1", A, at(19, 0)));
	const e1 = command("e1", at(19, 1));
	chat.say(at(19, 1), { words: E1, calls: [{ id: e1.id, code: e1.code, details: e1.details, endsAt: e1.endsAt }] });
	if (options.renderMidway) chat.lines(W);
	vi.setSystemTime(at(19, 4));
	chat.report(report("m2", B, at(19, 4)));
	if (options.renderMidway) chat.lines(W);
	const e2 = command("e2", at(19, 5));
	chat.say(at(19, 5), { words: E2, calls: [{ id: e2.id, code: e2.code, details: e2.details, endsAt: e2.endsAt }] });
	chat.say(at(19, 6), { words: "都看完了。" });
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	return chat;
}

describe("a round a report woke draws the lane by time, not by when it is drawn", () => {
	function expectWokenLanes(rows: readonly string[], label: string): void {
		// B is out until 19:04: the first event of the round is on the lane, the one after B came back is not.
		expect(laneOf(rows, E1), label).toBe("  ┆");
		expect(laneOf(rows, E2), label).toBe("   ");
		// The empty row between A's report and the round's first line is on the lane too.
		expect(above(rows, E1).slice(10, 13), label).toBe("  ┆");
		expect(
			rows.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd()),
			label,
		).toEqual(["         ├──╯   两个都交回了"]);
	}

	it("lights the round's lines while B is out and darkens them once B is back, when the messages are rebuilt", () => {
		expectWokenLanes(built(wokenTranscript()), "built");
	});

	it("draws the same when the mode replays the session", async () => {
		const host = createReplayHost();
		await replayInto(host, wokenTranscript());
		expectWokenLanes(screenOf(host, W), "replayed");
	});

	it("draws the same live, whether or not a frame was drawn while B was still out", () => {
		const watched = wokenLive({ renderMidway: true });
		const unwatched = wokenLive({ renderMidway: false });
		expectWokenLanes(plain(watched.lines(W)), "watched");
		expectWokenLanes(plain(unwatched.lines(W)), "unwatched");
		watched.flow.dispose();
		unwatched.flow.dispose();
	});

	it("gives the live view and the replay the same lane on every line of the round", async () => {
		const live = plain(wokenLive({ renderMidway: false }).lines(W));
		const host = createReplayHost();
		await replayInto(host, wokenTranscript());
		const replay = screenOf(host, W);
		const lane = (rows: readonly string[]) =>
			rows.filter((row) => /^ \d\d:\d\d /.test(row) || row.startsWith("         │")).map((row) => row.slice(10, 13));
		expect(lane(live).length).toBeGreaterThan(5);
		expect(lane(live)).toEqual(lane(replay));
	});
});

describe("subagents still out survive a rebuild of the chat", () => {
	const E_EARLY = "趁它们干活，我先看代码。";
	const E_LATE = "还在等它们。";

	const full = (): AgentMessage[] => [
		{ role: "user", content: "审查", timestamp: at(18, 47) },
		callMessage(at(18, 48), "派两个去审查。", "spawn", "await rlm.spawn(...)"),
		resultMessage("spawn", at(18, 48, 3), SPAWN_AB),
		callMessage(at(18, 50), E_EARLY, "c1", 'r = await bash("echo c1")'),
		resultMessage("c1", at(18, 50, 5), command("c1", at(18, 50)).details),
		callMessage(at(18, 52), E_LATE, "c2", 'r = await bash("echo c2")'),
		resultMessage("c2", at(18, 52, 5), command("c2", at(18, 52)).details),
	];

	/** What a compaction leaves: the dispatch and the question were summarized away. */
	const compacted = (): AgentMessage[] => full().slice(3);

	it("keeps them out (lane, waiting names) when the rebuild no longer sees their dispatch", async () => {
		const host = createReplayHost();
		await replayInto(host, full());
		const before = summariesOf(host)[0]!;
		expect(before.state.timeline.laneTracker?.pending).toEqual([A, B]);
		const whole = plain(before.render(W));
		await replayInto(host, compacted(), { clearChat: true, keepCompactedHistory: true });
		const after = summariesOf(host)[0]!;
		expect(after.state.timeline.laneTracker?.pending).toEqual([A, B]);
		const rows = plain(after.render(W));
		expect(rows.filter((row) => row.includes("├──╮")).map((row) => row.trimEnd())).toHaveLength(1);
		expect(laneOf(rows, E_EARLY)).toBe("  ┆");
		expect(laneOf(rows, E_LATE)).toBe("  ┆");
		expect(laneOf(rows, E_EARLY)).toBe(laneOf(whole, E_EARLY));
		expect(laneOf(rows, E_LATE)).toBe(laneOf(whole, E_LATE));
	});

	it("lets one go and closes the lane when its report is in the rebuilt part, though its dispatch is not", async () => {
		const host = createReplayHost();
		await replayInto(host, [
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派一个去审查。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 3), SPAWN_A),
			callMessage(at(18, 50), E_EARLY, "c1", 'r = await bash("echo c1")'),
			resultMessage("c1", at(18, 50, 5), command("c1", at(18, 50)).details),
		]);
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([A]);
		await replayInto(
			host,
			[
				callMessage(at(18, 50), E_EARLY, "c1", 'r = await bash("echo c1")'),
				resultMessage("c1", at(18, 50, 5), command("c1", at(18, 50)).details),
				report("m1", A, at(18, 55)),
				say(at(18, 56), "收到，审查没问题。"),
			],
			{ clearChat: true, keepCompactedHistory: true },
		);
		const summary = summariesOf(host)[0]!;
		expect(summary.state.timeline.laneTracker?.pending).toEqual([]);
		const rows = screenOf(host, W);
		expect(laneOf(rows, E_EARLY)).toBe("  ┆");
		expect(rows.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd())).toEqual([
			"         ├──╯   交回了",
		]);
		const join = rows.findIndex((row) => row.includes("├──╯"));
		for (const row of rows.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
	});
});

describe("a rebuild takes back only the question it shows", () => {
	it("does not bring an earlier question's subagent into the question a resync ends in", async () => {
		const first: AgentMessage[] = [
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派一个去审查。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 3), SPAWN_A),
			say(at(18, 49), "派出去了。"),
		];
		const host = createReplayHost();
		await replayInto(host, first);
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([A]);
		// The session moved on while this view was away: the owner asked something else.
		await replayInto(host, [
			...first,
			{ role: "user", content: "换个话题", timestamp: at(19, 30) },
			callMessage(at(19, 31), "先看一眼。", "look", 'r = await bash("ls")'),
			resultMessage("look", at(19, 31, 3), command("look", at(19, 31)).details),
			say(at(19, 32), "好了。"),
		]);
		const summaries = summariesOf(host);
		expect(summaries).toHaveLength(2);
		expect(summaries[1]?.state.timeline.laneTracker?.pending).toEqual([]);
		expect(laneOf(screenOf(host, W), "先看一眼。")).toBe("   ");
	});
});

describe("a window that reopens a long turn keeps the subagents that are out", () => {
	function longTranscript(): AgentMessage[] {
		const messages: AgentMessage[] = [
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派一个去审查。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 3), SPAWN_A),
		];
		for (let index = 0; index < 210; index++) {
			const ts = at(18, 50) + index * 20_000;
			messages.push(callMessage(ts, `第 ${index} 步。`, `f${index}`, `print(${index})`));
			messages.push(resultMessage(`f${index}`, ts + 5_000, {}));
		}
		return messages;
	}

	it("draws the last event of the window on the lane, as the whole turn does", async () => {
		const messages = longTranscript();
		const host = createReplayHost();
		await replayInto(host, messages);
		expect(summariesOf(host)[0]?.state.timeline.laneTracker?.pending).toEqual([A]);
		const whole = screenOf(host, W);
		expect(laneOf(whole, "第 209 步。")).toBe("  ┆");
		await replayInto(host, messages, { clearChat: true, limitTranscript: true });
		const summary = summariesOf(host)[0]!;
		expect(summary.state.timeline.earlierSteps).toBeGreaterThan(0);
		expect(summary.state.timeline.laneTracker?.pending).toEqual([A]);
		expect(laneOf(screenOf(host, W), "第 209 步。")).toBe("  ┆");
	});
});

describe("the row that closes the lane says how the subagents came back", () => {
	const names = [A, B, C, D];
	const SPAWN_ALL = {
		activities: names.map((name, index) => subagentRecord(`s-${index}`, name, at(18, 48, index + 1))),
	};

	const failure = (name: string, ts: number) =>
		createRlmChildFailureMessage({ childId: `${name}-id`, sessionName: name, error: "boom", kind: "error" }, ts);
	const silent = (name: string, ts: number) =>
		createRlmChildTerminalNoticeMessage(
			{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
			ts,
		);
	const cancelled = (name: string, ts: number) =>
		createRlmChildTerminalNoticeMessage({ kind: "cancelled", childId: `${name}-id`, sessionName: name }, ts);

	function transcript(returns: AgentMessage[]): AgentMessage[] {
		return [
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派四个。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 5), SPAWN_ALL),
			say(at(18, 49), "派出去了。"),
			...returns,
		];
	}

	const closing = (rows: readonly string[]) => rows.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd());

	it("keeps 四个都交回了 when all four handed a report back", () => {
		const rows = built(transcript(names.map((name, index) => report(`r${index}`, name, at(19, index)))));
		expect(closing(rows)).toEqual(["         ├──╯   四个都交回了"]);
	});

	it("does not count a failed or silent child as having handed something back, replayed and live", async () => {
		const returns = [
			report("r0", A, at(19, 0)),
			report("r1", B, at(19, 1)),
			failure(C, at(19, 2)),
			silent(D, at(19, 3)),
		];
		const expected = ["         ├──╯   四个都回来了（1 个失败，1 个没发回消息）"];
		expect(closing(built(transcript(returns)))).toEqual(expected);
		const host = createReplayHost();
		await replayInto(host, transcript(returns));
		expect(closing(screenOf(host, W))).toEqual(expected);
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派四个。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_ALL, endsAt: at(18, 48, 5) }],
		});
		chat.say(at(18, 49), { words: "派出去了。" });
		chat.endRun();
		chat.report(report("r0", A, at(19, 0)));
		chat.report(report("r1", B, at(19, 1)));
		chat.wakeByNotice(C, { failed: true, answer: undefined });
		chat.wakeByNotice(D, { answer: undefined });
		expect(closing(plain(chat.lines(W)))).toEqual(expected);
		chat.flow.dispose();
	});

	it("names every kind that did not hand a report back, and a lone one plainly", () => {
		const pair = {
			activities: [subagentRecord("s-a", A, at(18, 48, 1)), subagentRecord("s-b", B, at(18, 48, 2))],
		};
		const two = built([
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派两个。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 5), pair),
			say(at(18, 49), "派出去了。"),
			report("r0", A, at(19, 0)),
			cancelled(B, at(19, 1)),
		]);
		expect(closing(two)).toEqual(["         ├──╯   两个都回来了（1 个已取消）"]);
		expect(joinText(4)).toBe("四个都交回了");
		expect(joinText(1)).toBe("交回了");
		expect(joinText(3, { failed: 0, silent: 0, cancelled: 1 })).toBe("三个都回来了（1 个已取消）");
		expect(joinText(2, { failed: 2, silent: 0, cancelled: 0 })).toBe("两个都回来了（2 个失败）");
		expect(joinText(1, { failed: 1, silent: 0, cancelled: 0 })).toBe("失败了");
		expect(joinText(1, { failed: 0, silent: 1, cancelled: 0 })).toBe("做完了，没发回消息");
		expect(joinText(1, { failed: 0, silent: 0, cancelled: 1 })).toBe("已取消");
	});
});

describe("a subagent named on a system line reads as short as on its dispatch and return rows", () => {
	const failure = createRlmChildFailureMessage(
		{ childId: "c-id", sessionName: C, error: "boom", kind: "error" },
		at(19, 2),
	);

	it("shortens the name in the failure line, replayed and live", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派一个。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 3), { activities: [subagentRecord("s-c", C, at(18, 48, 1))] }),
			say(at(18, 49), "派出去了。"),
			failure,
		];
		const rows = built(messages);
		expect(rows.some((row) => row.includes("子代理 C 失败（出错）"))).toBe(true);
		expect(rows.join("\n")).not.toContain(C);
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派一个。",
			calls: [
				{
					id: "spawn",
					code: "await rlm.spawn(...)",
					details: { activities: [subagentRecord("s-c", C, at(18, 48, 1))] },
					endsAt: at(18, 48, 3),
				},
			],
		});
		chat.say(at(18, 49), { words: "派出去了。" });
		chat.endRun();
		chat.wakeByNotice(C, { failed: true, answer: undefined });
		const live = plain(chat.lines(W));
		expect(live.some((row) => row.includes("子代理 C 失败（出错）"))).toBe(true);
		expect(live.join("\n")).not.toContain(C);
		chat.flow.dispose();
	});

	it("shortens it in the stall line too", () => {
		const stall = createRlmChildStallNoticeMessage(
			{ childId: "c-id", sessionName: C, silentMs: 600_000, thresholdMs: 300_000, inFlightTools: [] },
			at(19, 3),
		);
		const rows = built([
			{ role: "user", content: "审查", timestamp: at(18, 47) },
			callMessage(at(18, 48), "派一个。", "spawn", "await rlm.spawn(...)"),
			resultMessage("spawn", at(18, 48, 3), { activities: [subagentRecord("s-c", C, at(18, 48, 1))] }),
			say(at(18, 49), "派出去了。"),
			stall,
		]);
		expect(rows.some((row) => row.includes("子代理 C 已经 10 分钟没动静"))).toBe(true);
		expect(rows.join("\n")).not.toContain(C);
	});
});
