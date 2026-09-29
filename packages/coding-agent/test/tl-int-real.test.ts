import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { assistant } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/**
 * Data shaped like the owner's real review session (01a0ecc6…): the four subagents are started from a
 * Python cell, so the kernel's record of that cell lists them as `subagent` activities named after
 * their sessions and no snapshot ever tells the timeline; the reports come as `agent_message`s from
 * `child:<session name>`; a notice says a child finished without a word.
 */

let chalkLevel: typeof chalk.level;

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
	chalkLevel = chalk.level;
	chalk.level = 3;
});

afterAll(() => {
	chalk.level = chalkLevel;
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b[\]_][^\x07]*\x07/g, ""));

const NAMES = ["review-grow-A-tui", "review-grow-B-box", "review-grow-C-strip", "review-grow-D-hygiene"];

/** The kernel's record of the cell that started the four subagents (real field values). */
const SPAWN_DETAILS = {
	durationMs: 1850,
	status: "ok",
	stdout: `${NAMES.join(" ")}\n`,
	activities: NAMES.map((label, index) => ({
		id: `subagent-${8 + index}`,
		kind: "subagent",
		label,
		status: "ok",
		detail: index < 2 ? "bailian/glm-5.3-prime" : "bailian/deepseek-v4.1-flash",
		startedAt: at(18, 48, index),
		endedAt: at(18, 48, index + 1),
	})),
};

function report(name: string, at_: number, conclusion: string): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id: `agentmsg_${name}`,
			source: AGENT_MESSAGE_SOURCE,
			message: `车道（${name}）审查完成，报告：/tmp/review/${name}.md\n\n结论：${conclusion}`,
			from: { sessionName: name, sessionId: `${name}-session`, activeSessionId: `${name}-active` },
			fromRelationship: "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		at_,
	);
}

function toolResult(
	id: string,
	at_: number,
	details: unknown = { status: "ok", stdout: "" },
	isError = false,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: isError ? "命令失败" : "ok" }],
		details,
		isError,
		timestamp: at_,
	};
}

function call(id: string, at_: number, words: string | undefined, code = "print(1)"): AgentMessage {
	return assistant(
		at_,
		[
			...(words ? [{ type: "text" as const, text: words }] : []),
			{ type: "toolCall" as const, id, name: "ipython", arguments: { code } },
		],
		"toolUse",
	);
}

/** The review as a transcript: a spawn cell, the AI's own checks, four reports, the summary. */
function transcript(): AgentMessage[] {
	const messages: AgentMessage[] = [
		{ role: "user", content: "对最近的改动做全面的审查 多个代理一起", timestamp: at(18, 47) },
		call("c1", at(18, 47, 5), "先看最近的提交。"),
		toolResult("c1", at(18, 47, 6)),
		call("spawn", at(18, 48), "四个车道并行审查。", "await rlm.spawn('review-grow-A-tui', task)"),
		toolResult("spawn", at(18, 48, 4), SPAWN_DETAILS),
		call("c2", at(18, 50), "趁它们干活，我自己跑检查。"),
		toolResult("c2", at(18, 50, 5)),
		call("c3", at(18, 53), "还在跑测试。"),
		toolResult("c3", at(18, 53, 5)),
	];
	const back: Array<[string, number, number, string]> = [
		[NAMES[1] ?? "", 18, 54, "无 P0/P1，7 条 P2"],
		[NAMES[0] ?? "", 19, 0, "无 P0、无 P1，4 条 P2"],
		[NAMES[3] ?? "", 19, 4, "P0×1、P1×2"],
		[NAMES[2] ?? "", 19, 5, "无 P0"],
	];
	back.forEach(([name, hour, minute, conclusion], index) => {
		messages.push(report(name, at(hour, minute), conclusion));
		messages.push(call(`d${index}`, at(hour, minute, 30), `车道交卷了，我接着查 ${index}。`));
		messages.push(toolResult(`d${index}`, at(hour, minute, 40)));
	});
	messages.push(assistant(at(19, 6), [{ type: "text", text: "审查完成，四车道都收口了。" }], "stop"));
	return messages;
}

function replay(messages: AgentMessage[], width = 160): string[] {
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
	return plain(container.render(width));
}

describe("subagents started from a Python cell get their dispatch row and lane", () => {
	it("replays the dispatch row, the dotted lane, the returns and the join", () => {
		setMotionReduced(true);
		const rows = replay(transcript());
		const split = rows.findIndex((row) => row.includes("├──╮"));
		expect(split).toBeGreaterThan(0);
		expect(rows[split]?.trimEnd()).toBe("         ├──╮   ◇  A   B   C   D");
		// The cell's own records are not listed a second time as steps.
		expect(rows.join("\n")).not.toContain("子代理 review-grow");
		const join = rows.findIndex((row) => row.includes("├──╯"));
		expect(join).toBeGreaterThan(split);
		expect(rows[join]?.trimEnd()).toBe("         ├──╯   四个都交回了");
		expect(rows.filter((row) => row.includes("├──╯"))).toHaveLength(1);
		// From the dispatch to the last return every row is on the lane; before and after none is.
		for (const row of rows.slice(split + 1, join)) expect(row.slice(10, 13), row).toMatch(/^ {2}[┆◇]$/);
		for (const row of rows.slice(0, split)) expect(row.slice(10, 13), row).toBe("   ");
		for (const row of rows.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
		const returns = rows.filter((row) => /│ {2}◇ {3}\S 交回/.test(row));
		expect(returns.map((row) => row.slice(16, 20))).toEqual(
			["B 交回", "A 交回", "D 交回", "C 交回"].map((r) => r.slice(0, 4)),
		);
	});

	it("lights the events between the dispatch and the returns even though every subagent is back", () => {
		setMotionReduced(true);
		const rows = replay(transcript());
		const during = rows.find((row) => row.includes("趁它们干活")) ?? "";
		expect(during.slice(0, 16)).toMatch(/^ 18:50 {3}◆ {2}┆ {3}$/);
		const before = rows.find((row) => row.includes("先看最近的提交")) ?? "";
		expect(before.slice(10, 13)).toBe("   ");
		// After A's return D and C are still out; after C's, the last one, nobody is.
		const between = rows.find((row) => row.includes("我接着查 1")) ?? "";
		expect(between.slice(10, 13)).toBe("  ┆");
		const after = rows.find((row) => row.includes("我接着查 3")) ?? "";
		expect(after.slice(10, 13)).toBe("   ");
	});

	it("draws the same dispatch live, from the cell's records alone", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "四个车道并行审查。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_DETAILS, endsAt: at(18, 48, 4) }],
		});
		expect(chat.flow.subagentLane.tracker.pending).toEqual(NAMES);
		chat.say(at(18, 50), { words: "趁它们干活，我自己跑检查。" });
		const rows = plain(chat.lines(160));
		expect(rows.find((row) => row.includes("├──╮"))?.trimEnd()).toBe("         ├──╮   ◇  A   B   C   D");
		NAMES.forEach((name, index) => {
			vi.setSystemTime(at(19, index));
			chat.report(report(name, at(19, index), "没问题"));
		});
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		const done = plain(chat.lines(160));
		expect(done.filter((row) => row.includes("├──╯"))).toHaveLength(1);
		const join = done.findIndex((row) => row.includes("├──╯"));
		for (const row of done.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
		chat.flow.dispose();
	});

	it("does not draw the dispatch twice when a snapshot of the same subagent arrives too", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "四个车道并行审查。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_DETAILS, endsAt: at(18, 48, 4) }],
		});
		for (const name of NAMES) {
			chat.child({
				id: `child-${name}`,
				label: `${name.slice(-4)}：检查这一批的改动`,
				sessionName: name,
				activeSessionId: `${name}-active`,
				status: "running",
				sessionDir: `/tmp/${name}`,
			});
		}
		const rows = plain(chat.lines(160));
		expect(rows.filter((row) => row.includes("├──╮"))).toHaveLength(1);
		expect(rows.find((row) => row.includes("├──╮"))).toContain("A ");
		expect(chat.flow.subagentLane.tracker.pending).toEqual(NAMES);
		chat.flow.dispose();
	});
});

/** The round the real session shows after its summary: a notice that a child finished without a word. */
describe("a round woken only by a silent-finish notice", () => {
	const ACK =
		"查过了，这条通知不用处理：车道 C 其实交了报告——我上一轮就收到了它的回复和完整报告文件，内容也已经并入给你的总报告里（就是 256 色撞码根因、旧面板信息丢失那几条）。它的报告文件还在 /tmp/review_20260929_growbatch/车道C_报告.md，四份车道报告都在原处，这条「没发回复」的系统提示是记账滞后，实际交付齐全。";

	function afterSummary(extra: AgentMessage[] = [], reply: AgentMessage | undefined = undefined): AgentMessage[] {
		const readReport = assistant(
			at(19, 7),
			[
				{ type: "thinking", thinking: "先确认它交没交。" },
				{
					type: "toolCall",
					id: "n1",
					name: "ipython",
					arguments: { code: 'print(open("/tmp/review/车道C_报告.md").read()[:200])' },
				},
			],
			"toolUse",
		);
		return [
			...transcript(),
			createRlmChildTerminalNoticeMessage(
				{ kind: "completed_without_reply", childId: "sub-80b28b9e", sessionName: NAMES[2] ?? "" },
				at(19, 8),
			),
			readReport,
			toolResult("n1", at(19, 8, 5), {
				status: "ok",
				stdout: "exists: True\n",
				activities: [
					{
						id: "cmd-1",
						kind: "command",
						label: "cat 车道C_报告.md",
						status: "ok",
						detail: "",
						startedAt: at(19, 8, 2),
						endedAt: at(19, 8, 4),
					},
				],
			}),
			...extra,
			reply ?? assistant(at(19, 9), [{ type: "text", text: ACK }], "stop"),
		];
	}

	it("draws nothing of a long acknowledgement with three steps, and everything with 完整过程", () => {
		setMotionReduced(true);
		expect(ACK.length).toBeGreaterThan(150);
		const rows = replay(afterSummary());
		const screen = rows.join("\n");
		expect(screen).toContain("审查完成，四车道都收口了。");
		expect(screen).not.toContain("查过了，这条通知不用处理");
		expect(rows.filter((row) => row.endsWith("总结"))).toHaveLength(1);
		timelineShowAll.set(true);
		expect(replay(afterSummary()).join("\n")).toContain("查过了，这条通知不用处理");
	});

	it("keeps the round when it saved a memory or ended on an unfixed error", () => {
		setMotionReduced(true);
		const memory = toolResult("n2", at(19, 8, 30), {
			status: "ok",
			memoryChanges: [
				{
					op: "created",
					kind: "memory",
					scope: "session",
					title: "车道 收口 记账",
					after: "已核",
					at: at(19, 8, 30),
				},
			],
		});
		const saved = replay(afterSummary([call("n2", at(19, 8, 20), undefined), memory])).join("\n");
		expect(saved).toContain("查过了，这条通知不用处理");
		// The run ended right after a failed step, its last reply cut off: nothing corrected the failure.
		const broken = toolResult("n3", at(19, 8, 40), { status: "error", error: "命令失败" }, true);
		const cut = assistant(at(19, 9), [{ type: "text", text: "查过了，这条通知不用处理，让我再试" }], "length");
		const failed = replay(afterSummary([call("n3", at(19, 8, 35), undefined), broken], cut)).join("\n");
		expect(failed).toContain("查过了，这条通知不用处理");
		// A failed step the AI then corrected and answered is not an alarm: the round stays out of sight.
		const fixed = replay(afterSummary([call("n3", at(19, 8, 35), undefined), broken])).join("\n");
		expect(fixed).not.toContain("查过了，这条通知不用处理");
	});
});
