import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/index.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { at, createReplayHost, plain, replayInto, screenOf } from "./tl-fc-host.js";
import { assistant } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * A subagent started from a Python cell (`rlm.run`): the kernel first reports a `running` record whose
 * label is the task text, and once the child is admitted the same record turns `ok` and carries the
 * session name. The live view always sees both records; a replay only the last. Both must draw the
 * same dispatch, the same lane and the same return.
 */

const W = 160;

const TASK = "钉住框头：检查框头在滚动时是否钉住，并写报告";
const NAME = "review-grow-A-tui";

function record(status: "running" | "ok" | "error", label: string, extra: Record<string, unknown> = {}) {
	return {
		id: "subagent-1",
		kind: "subagent",
		label,
		status,
		startedAt: at(18, 48, 1),
		...(status === "running" ? {} : { endedAt: at(18, 48, 2) }),
		...extra,
	};
}

const CODE = "h = await rlm.run(task)";

function toolCall(id: string, ts: number, words: string): AssistantMessage {
	return assistant(
		ts,
		[
			{ type: "text", text: words },
			{ type: "toolCall", id, name: "ipython", arguments: { code: CODE } },
		],
		"toolUse",
	);
}

function toolResult(id: string, ts: number, details: unknown): AgentMessage {
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

/** The session's own record of the child: its name and the task it was given. */
function snapshotOf(label: string): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: "child-A",
		label,
		sessionName: NAME,
		activeSessionId: `${NAME}-active`,
		status: "running",
		sessionDir: `/tmp/${NAME}`,
	};
}

function report(ts: number): AgentSessionMessage {
	return handedBack("r1", ts, NAME, "车道A（钉住框头）审查完成。\n结论：没问题。");
}

/** The transcript the live run below leaves: only the last record of the cell is in it. */
function transcript(final: unknown, options: { returned: boolean }): AgentMessage[] {
	const messages: AgentMessage[] = [
		{ role: "user", content: "审查", timestamp: at(18, 47) },
		toolCall("spawn", at(18, 48), "派一个去审查。"),
		toolResult("spawn", at(18, 48, 3), { activities: [final] }),
	];
	if (options.returned) {
		messages.push(report(at(18, 55)));
		messages.push(assistant(at(18, 56), [{ type: "text", text: "收到，审查没问题。" }], "stop"));
	} else {
		messages.push(assistant(at(18, 49), [{ type: "text", text: "派出去了，等它交回。" }], "stop"));
	}
	return messages;
}

function replayed(messages: AgentMessage[]): string[] {
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

/** The live run: the running record arrives as a tool update, the settled one with the tool result. */
function liveRun(records: { running: unknown[]; final: unknown[] }, options: { returned: boolean }): LiveChat {
	const chat = new LiveChat();
	chat.setClock(at(18, 47));
	chat.user("审查");
	chat.say(
		at(18, 48),
		{ words: "派一个去审查。", calls: [{ id: "spawn", code: CODE, details: { activities: records.running } }] },
		{ open: true },
	);
	chat.flow.assistantEnd(toolCall("spawn", at(18, 48), "派一个去审查。"));
	vi.setSystemTime(at(18, 48, 3));
	chat.flow.toolEnd(
		"spawn",
		"ipython",
		{ details: { activities: records.final }, content: [{ type: "text", text: "ok" }] },
		false,
	);
	if (options.returned) {
		vi.setSystemTime(at(18, 55));
		chat.report(report(at(18, 55)));
		chat.say(at(18, 56), { words: "收到，审查没问题。" });
	} else {
		chat.say(at(18, 49), { words: "派出去了，等它交回。" });
	}
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	return chat;
}

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

const dispatchRows = (rows: readonly string[]) => rows.filter((row) => row.includes("├──╮"));
const laneColumn = (rows: readonly string[]) => rows.map((row) => row.slice(10, 13));

describe("a subagent started from Python is one subagent, dispatched once its child has a name", () => {
	it("does not draw the task text as a subagent while the record still says it is being admitted", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(
			at(18, 48),
			{
				words: "派一个去审查。",
				calls: [{ id: "spawn", code: CODE, details: { activities: [record("running", TASK)] } }],
			},
			{ open: true },
		);
		expect(chat.flow.subagentLane.tracker.pending).toEqual([]);
		const rows = plain(chat.lines(W));
		expect(dispatchRows(rows)).toEqual([]);
		expect(rows.join("\n")).not.toContain("◇  钉住框头");
		chat.flow.dispose();
	});

	it("dispatches the child once, under its session name, when the record turns ok, and lets it go when it reports", () => {
		const chat = liveRun(
			{ running: [record("running", TASK)], final: [record("ok", NAME, { detail: "glm-5.3-prime" })] },
			{ returned: false },
		);
		expect(chat.flow.subagentLane.tracker.pending).toEqual([NAME]);
		const rows = plain(chat.lines(W));
		expect(dispatchRows(rows)).toHaveLength(1);
		expect(dispatchRows(rows)[0]?.trimEnd()).toBe("         ├──╮   ◇  A 钉住框头");
		chat.report(report(at(18, 55)));
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		const after = plain(chat.lines(W));
		expect(after.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd())).toEqual([
			"         ├──╯   交回了",
		]);
		chat.flow.dispose();
	});

	it("draws the same review live and replayed: one dispatch, the lane to the return, the closing row", async () => {
		const live = liveRun(
			{ running: [record("running", TASK)], final: [record("ok", NAME, { detail: "glm-5.3-prime" })] },
			{ returned: true },
		);
		// The closing row of the request is left out: its time and cost are measured differently in a replay.
		const withoutClosing = (rows: readonly string[]) => rows.filter((row) => !row.includes("╵"));
		const liveRows = withoutClosing(plain(live.lines(W)));
		const messages = transcript(record("ok", NAME, { detail: "glm-5.3-prime" }), { returned: true });
		const host = createReplayHost([snapshotOf(TASK)]);
		await replayInto(host, messages);
		const replayRows = withoutClosing(screenOf(host, W));
		expect(dispatchRows(replayRows)).toHaveLength(1);
		expect(dispatchRows(liveRows)).toHaveLength(1);
		expect(liveRows.filter((row) => row.includes("├──╯")).map((row) => row.trimEnd())).toEqual([
			"         ├──╯   交回了",
		]);
		expect(laneColumn(liveRows)).toEqual(laneColumn(replayRows));
		expect(liveRows.map((row) => row.trimEnd())).toEqual(replayRows.map((row) => row.trimEnd()));
		// A rebuild of the messages alone has no session record: the same lines but the task's tag.
		expect(laneColumn(replayed(messages))).toEqual(laneColumn(replayRows));
		live.flow.dispose();
	});

	it("draws nothing for a child that never started: an error record keeps the task text off the lane, live and replayed", () => {
		const failed = record("error", TASK, { detail: "RuntimeError: no model" });
		const live = liveRun({ running: [record("running", TASK)], final: [failed] }, { returned: false });
		expect(live.flow.subagentLane.tracker.pending).toEqual([]);
		const liveRows = plain(live.lines(W));
		const replayRows = replayed(transcript(failed, { returned: false }));
		for (const rows of [liveRows, replayRows]) {
			expect(dispatchRows(rows)).toEqual([]);
			expect(rows.join("\n")).not.toContain("钉住框头：检查框头");
			for (const lane of laneColumn(rows)) expect(lane).toBe("   ");
		}
		live.flow.dispose();
	});
});

describe("a cell that only dispatches subagents is a step of its event", () => {
	const spawnCell = [record("ok", NAME, { detail: "glm-5.3-prime" })];

	it("lists the cell as one step under its event, replayed and live, that opens to say what it started", () => {
		const live = liveRun({ running: [record("running", TASK)], final: spawnCell }, { returned: false });
		const replayRows = replayed(transcript(spawnCell[0], { returned: false }));
		for (const rows of [plain(live.lines(W)), replayRows]) {
			const event = rows.find((row) => row.includes("派一个去审查。")) ?? "";
			expect(event.trimEnd().endsWith("1 步 ▸"), event).toBe(true);
		}
		const summary = live.summaries()[0]!;
		summary.render(W);
		summary.activate(summary.getFocusOrder().find((key) => key.startsWith("ev:")) ?? "");
		const opened = plain(live.lines(W));
		const step = opened.find((row) => row.includes("派出子代理 A")) ?? "";
		expect(step, opened.join("\n")).not.toBe("");
		expect(step.slice(21, 22)).toBe("✓");
		live.flow.dispose();
	});

	it("counts the cell in the live tail's step number", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派一个去审查。",
			calls: [{ id: "spawn", code: CODE, details: { activities: spawnCell } }],
		});
		chat.say(
			at(18, 50),
			{
				words: "趁它干活，我先跑测试。",
				calls: [
					{
						id: "t1",
						code: 'r = await bash("npm test")',
						details: {
							activities: [
								{
									id: "t1-a",
									kind: "command",
									label: "npm test",
									status: "running",
									detail: "",
									startedAt: at(18, 50),
								},
							],
						},
					},
				],
			},
			{ open: true },
		);
		vi.setSystemTime(at(18, 50, 5));
		const tail = plain(chat.lines(W)).find((row) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(row)) ?? "";
		expect(tail.trimEnd().endsWith("第 2 步"), tail).toBe(true);
		chat.flow.dispose();
	});
});

describe("the dispatch row names the task in a replay too", () => {
	async function replayedByMode(messages: AgentMessage[], children: AgentConnectionRlmChildAgentSnapshot[]) {
		const host = createReplayHost(children);
		await replayInto(host, messages);
		return screenOf(host, W);
	}

	it("takes the task's short tag from the session's own record of the child, as the live view does", async () => {
		const messages = transcript(record("ok", NAME), { returned: false });
		const withRecord = await replayedByMode(messages, [snapshotOf(TASK)]);
		expect(dispatchRows(withRecord)[0]?.trimEnd()).toBe("         ├──╮   ◇  A 钉住框头");
		const without = await replayedByMode(messages, []);
		expect(dispatchRows(without)[0]?.trimEnd()).toBe("         ├──╮   ◇  A");
	});

	it("draws in the live view the tag the running record already carries, and the same row as the replay", async () => {
		const live = liveRun({ running: [record("running", TASK)], final: [record("ok", NAME)] }, { returned: false });
		const liveRow = dispatchRows(plain(live.lines(W)))[0]?.trimEnd();
		expect(liveRow).toBe("         ├──╮   ◇  A 钉住框头");
		const replay = await replayedByMode(transcript(record("ok", NAME), { returned: false }), [snapshotOf(TASK)]);
		expect(dispatchRows(replay)[0]?.trimEnd()).toBe(liveRow);
		live.flow.dispose();
	});
});
