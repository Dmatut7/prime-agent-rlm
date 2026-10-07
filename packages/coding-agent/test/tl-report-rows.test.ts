import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRelationship,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildFailureMessage, createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import {
	AgentMessageComponent,
	laneKey,
	reportParts,
	SubagentLane,
	shortAgentName,
	verdictLevel,
} from "../src/modes/interactive/components/agent-message.js";
import { createAgentMessageRow } from "../src/modes/interactive/components/conversation-components.js";
import { subagentNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { plain, useTruecolorTheme } from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
	timelineShowAll.set(false);
});

const W = 100;
const AT = new Date(2026, 8, 29, 18, 54).getTime();

function report(
	name: string,
	body: string,
	options: { relationship?: AgentFamilyRelationship; at?: number } = {},
): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id: `agentmsg_${name}`,
			source: AGENT_MESSAGE_SOURCE,
			message: body,
			from: { sessionName: name, sessionId: `${name}-s`, activeSessionId: `${name}-a` },
			fromRelationship: options.relationship ?? "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		options.at ?? AT,
	);
}

const okBody = "车道B（框的长高和折叠）审查完成，报告：/tmp/b.md\n\n结论：没问题（7 条小建议）。其余略。";

/** The design's row: ` HH:MM   │  ◇   <content><pad>›  ` fitted to the width. */
function designRow(content: string, width = W): string {
	const head = " 18:54   │  ◇   ";
	const tail = "›  ";
	return head + content + " ".repeat(width - visibleWidth(head) - visibleWidth(content) - tail.length) + tail;
}

describe("a subagent's report row, cell by cell", () => {
	it("reads `HH:MM │  ◇   X 交回   task：conclusion` with the › at the right edge", () => {
		const component = new AgentMessageComponent(report("review-grow-B-box", okBody), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		const lines = plain(component.render(W));
		expect(lines).toEqual([designRow("B 交回   框的长高和折叠：没问题（7 条小建议）")]);
		expect(visibleWidth(lines[0] ?? "")).toBe(W);
		const row = lines[0] ?? "";
		expect(row.indexOf("│")).toBe(9);
		expect(row.indexOf("◇")).toBe(12);
		expect(row.indexOf("B 交回")).toBe(16);
	});

	it("paints X 交回 bold in the subagent color, the task dim, the conclusion soft and the arrow faint bold", () => {
		const component = new AgentMessageComponent(report("review-grow-B-box", okBody), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		const raw = component.render(W)[0] ?? "";
		expect(raw).toContain(theme.bold(theme.fg("timelineSub", "B 交回")));
		expect(raw).toContain(theme.fg("timelineTime", "   框的长高和折叠："));
		expect(raw).toContain(theme.fg("timelineSoft", "没问题（7 条小建议）"));
		expect(raw).toContain(theme.bold(theme.fg("timelineFaint", "›")));
		expect(raw).toContain(theme.bold(theme.fg("timelineSub", "  ◇")));
	});

	it("colors the conclusion by how bad it reads: must, should, otherwise soft", () => {
		const cases: Array<[string, "timelineMust" | "timelineFix" | "timelineSoft"]> = [
			["结论：1 条必修，发版删了测试要读的文件。", "timelineMust"],
			["结论：P0×1、P1×2、P2×8", "timelineMust"],
			["结论：1 条要修，256 色撞色。", "timelineFix"],
			["结论：P1 一条，其余是 P2", "timelineFix"],
			["结论：没问题（4 条小建议）", "timelineSoft"],
			["结论：无 P0、无 P1，4 条 P2。", "timelineSoft"],
			["结论：无 P0/P1，7 条 P2。", "timelineSoft"],
			["结论：没有 P0，1 条 P1", "timelineFix"],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [body, token] of cases) {
			const component = new AgentMessageComponent(report("review-x-D-y", body), undefined, {
				suppressLeadingSpace: true,
				timeline: { before: "off", after: "off" },
			});
			const raw = component.render(W)[0] ?? "";
			const conclusion = reportParts(body).conclusion;
			expect(raw, body).toContain(theme.fg(token, conclusion));
		}
	});

	it("says 发来 for a message from anyone else and never colors it as a verdict", () => {
		const component = new AgentMessageComponent(
			report("Planner", "请审查分片七，有 P0 就报。", { relationship: "parent" }),
			undefined,
			{ suppressLeadingSpace: true, timeline: { before: "off", after: "off" } },
		);
		const raw = component.render(W)[0] ?? "";
		expect(plain([raw])[0]).toContain("Planner 发来   请审查分片七，有 P0 就报");
		expect(raw).toContain(theme.fg("timelineSoft", "请审查分片七，有 P0 就报"));
	});

	it("keeps the row inside a narrow screen", () => {
		const component = new AgentMessageComponent(report("review-grow-B-box", okBody), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "off", after: "off" },
		});
		for (const width of [24, 30, 40, 60]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("the blank row above a block of reports and the row that closes the lane", () => {
	it("opens the block with one blank main-line row in the lane the others are still out in", () => {
		const component = new AgentMessageComponent(report("review-grow-B-box", okBody), undefined, {
			timeline: { before: "on", after: "on" },
		});
		const lines = plain(component.render(W)).map((line) => line.trimEnd());
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("         │  ┆");
		expect(lines[1]).toBe(designRow("B 交回   框的长高和折叠：没问题（7 条小建议）").trimEnd());
		expect(component.getClickRegions()[0]?.line).toBe(1);
	});

	it("puts `├──╯   四个都交回了` under the last report, in the design's columns", () => {
		const component = new AgentMessageComponent(report("review-grow-C-strip", okBody), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "off", joined: 4 },
		});
		const lines = plain(component.render(W)).map((line) => line.trimEnd());
		expect(lines).toEqual([
			designRow("C 交回   框的长高和折叠：没问题（7 条小建议）").trimEnd(),
			"         ├──╯   四个都交回了",
		]);
		const raw = component.render(W)[1] ?? "";
		expect(raw).toContain(theme.fg("timelineRail", "├"));
		expect(raw).toContain(theme.fg("timelineRail", "──╯"));
		expect(raw).toContain(theme.fg("timelineFaint", "四个都交回了"));
	});

	it("words the closing row for one, two and many", () => {
		const closing = (joined: number) =>
			plain(
				new AgentMessageComponent(report("review-grow-C-strip", okBody), undefined, {
					suppressLeadingSpace: true,
					timeline: { before: "on", after: "off", joined },
				}).render(W),
			)[1]?.trimEnd();
		expect(closing(1)).toBe("         ├──╯   交回了");
		expect(closing(2)).toBe("         ├──╯   两个都交回了");
		expect(closing(3)).toBe("         ├──╯   三个都交回了");
		expect(closing(12)).toBe("         ├──╯   12个都交回了");
	});
});

describe("the lane the returns are drawn in", () => {
	it("draws the dotted lane until the last subagent is back, then closes it once", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-A-tui", "review-grow-B-box", "review-grow-C-strip"]);
		expect(lane.comeBack("review-grow-B-box")).toEqual({ before: "on", after: "on" });
		expect(lane.comeBack("review-grow-A-tui")).toEqual({ before: "on", after: "on" });
		expect(lane.comeBack("review-grow-C-strip")).toEqual({ before: "on", after: "off", joined: 3 });
		expect(lane.comeBack("review-grow-C-strip")).toEqual({ before: "off", after: "off" });
	});

	it("still counts the round and draws the join when the lane settled out of band before the report", () => {
		// A terminal snapshot (upsertSubagent settle) closes the span before the
		// queued report row exists; the report that arrives after must still
		// close the round with the right count and tally, and a late report
		// after the round closed joins nothing.
		const lane = new SubagentLane();
		lane.tracker.spawned(["A", "B"]);
		lane.tracker.settle("A", Date.now(), "failed");

		const joined = lane.comeBack("B");
		// A settled out of band (failed), B's report is the row that reads the
		// round: two returns, one of them a failure.
		expect(joined).toMatchObject({ joined: 2, tally: { failed: 1, silent: 0, cancelled: 0 } });

		// A's own report arriving after the round closed joins nothing (the
		// settle was consumed by B's return).
		expect(lane.comeBack("A")).toEqual({ before: "off", after: "off" });
	});

	it("draws the join on the report row when the settle itself emptied the lane", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["solo"]);
		lane.tracker.settle("solo", Date.now(), "silent");

		// The span closed at the settle, but the round's closing line reads
		// where the report row lands.
		expect(lane.comeBack("solo", undefined, undefined, "silent")).toMatchObject({ joined: 1 });
	});

	it("counts a new round from zero and forgets everyone on a new question", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["A"]);
		expect(lane.comeBack("A").joined).toBe(1);
		lane.tracker.spawned(["A", "B"]);
		lane.reset();
		expect(lane.tracker.active).toBe(false);
		lane.tracker.spawned(["A", "B"]);
		lane.comeBack("A");
		expect(lane.comeBack("B").joined).toBe(2);
	});

	it("does not close a lane for a message from someone who was never out", () => {
		const lane = new SubagentLane();
		expect(lane.comeBack("stranger")).toEqual({ before: "off", after: "off" });
		lane.tracker.spawned(["A"]);
		expect(lane.comeBack("stranger")).toEqual({ before: "on", after: "on" });
		expect(lane.tracker.pending).toEqual(["A"]);
	});

	it("draws the report and the closing row through the conversation's own row builder", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-B-box", "review-grow-D-hygiene"]);
		const first = createAgentMessageRow(report("review-grow-B-box", okBody), {
			quiet: true,
			lane,
			previous: undefined,
		});
		const second = createAgentMessageRow(report("review-grow-D-hygiene", okBody), {
			quiet: true,
			lane,
			previous: first,
		});
		expect(plain(first.render(W)).map((line) => line.trimEnd())[0]).toBe("         │  ┆");
		expect(plain(second.render(W)).map((line) => line.trimEnd())).toEqual([
			designRow("D 交回   框的长高和折叠：没问题（7 条小建议）").trimEnd(),
			"         ├──╯   两个都交回了",
		]);
	});
});

describe("opening a report", () => {
	function opened() {
		const body = "车道B（框的长高和折叠）审查完成。\n\n结论：没问题。\n第二段很长".concat("，很长".repeat(30));
		const component = new AgentMessageComponent(report("review-grow-B-box", body), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		component.render(60);
		return component;
	}

	it("lists the whole report under the row, on the main line, in the lane, wrapped and never cut", () => {
		const component = opened();
		const click = component.getClickRegions().find((region) => !region.passive);
		click?.onClick({ row: 0, col: 0 });
		const lines = plain(component.render(60)).map((line) => line.trimEnd());
		expect(lines[0]).toContain("B 交回");
		expect(lines[0]?.endsWith("▴")).toBe(true);
		expect(lines[1]).toBe("         │  ┆     车道B（框的长高和折叠）审查完成。");
		expect(lines[2]).toBe("         │  ┆");
		expect(lines[3]).toBe("         │  ┆     结论：没问题。");
		const text = lines
			.slice(4)
			.map((line) => line.slice(18).trim())
			.join("");
		expect(text).toBe(`第二段很长${"，很长".repeat(30)}`);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("closes again on a second click and promises the rows a click opens", () => {
		const component = opened();
		const region = component.getClickRegions().find((candidate) => !candidate.passive);
		expect(region?.revealBelow).toBeGreaterThan(3);
		region?.onClick({ row: 0, col: 0 });
		component.render(60);
		expect(component.getClickRegions()[0]?.revealBelow).toBe(0);
		component.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
		expect(plain(component.render(60))).toHaveLength(1);
	});

	it("lights the whole row under the pointer without moving a row", () => {
		const component = opened();
		const before = component.render(60);
		const region = component.getClickRegions()[0];
		expect(region?.hoverKey).toBe("agent-message:agentmsg_review-grow-B-box");
		region?.onHover?.(true);
		const lit = component.render(60);
		expect(lit).toHaveLength(before.length);
		expect(lit[0]).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(plain(lit)).toEqual(plain(before));
		region?.onHover?.(false);
		expect(component.render(60)[0]).not.toContain(theme.getBgAnsi("timelineHoverBg"));
	});
});

describe("the key a subagent is on the lane by", () => {
	it("is the session name first, else the fallback, trimmed, and empty when there is neither", () => {
		expect(laneKey("review-grow-B-box", "ac-1")).toBe("review-grow-B-box");
		expect(laneKey("  review-grow-B-box  ", "ac-1")).toBe("review-grow-B-box");
		expect(laneKey(undefined, " ac-1 ")).toBe("ac-1");
		expect(laneKey("   ", "ac-1")).toBe("ac-1");
		expect(laneKey(undefined, undefined)).toBe("");
		expect(laneKey("", "")).toBe("");
	});

	it("releases a subagent by the name or the fallback the dispatch registered it under", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-B-box", "ac-2"]);
		expect(lane.comeBack(" review-grow-B-box ", "ignored-because-named").before).toBe("on");
		expect(lane.tracker.pending).toEqual(["ac-2"]);
		expect(lane.comeBack(undefined, "ac-2").joined).toBe(2);
	});

	it("does not let a sender with neither a name nor an active session id release anyone", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["agent", "review-grow-B-box"]);
		const stranger = report("x", "好了", { relationship: "child" });
		const details = { ...stranger.details, from: { clientId: "agent", sessionId: "agent" } };
		const row = createAgentMessageRow({ ...stranger, details }, { quiet: true, lane, previous: undefined });
		expect(lane.tracker.pending).toEqual(["agent", "review-grow-B-box"]);
		expect(row.render(W).length).toBeGreaterThan(0);
	});

	it("releases the subagent a report names by its session name, then its active session id", () => {
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-B-box", "ac-2"]);
		createAgentMessageRow(report("review-grow-B-box", okBody), { quiet: true, lane, previous: undefined });
		expect(lane.tracker.pending).toEqual(["ac-2"]);
		const unnamed = report("x", okBody);
		createAgentMessageRow(
			{ ...unnamed, details: { ...unnamed.details, from: { activeSessionId: "ac-2", sessionId: "s2" } } },
			{ quiet: true, lane, previous: undefined },
		);
		expect(lane.tracker.active).toBe(false);
	});
});

describe("a long report costs nothing per frame", () => {
	/** A report whose text counts how often anything reads it. */
	function counted(): { message: AgentSessionMessage; reads: () => number } {
		const base = report("review-grow-B-box", okBody);
		const text = `${okBody}\n\n${"很长的一段说明，".repeat(2_000)}`;
		let reads = 0;
		const details = {
			...base.details,
			get message(): string {
				reads += 1;
				return text;
			},
		};
		return { message: { ...base, details }, reads: () => reads };
	}

	it("reads and wraps the report once for a collapsed row, however many frames are drawn", () => {
		const { message, reads } = counted();
		const component = new AgentMessageComponent(message, undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		component.render(W);
		const afterFirst = reads();
		for (let frame = 0; frame < 50; frame++) component.render(W);
		expect(reads()).toBe(afterFirst);
	});

	it("wraps again for a new width or lane, and after an invalidation, but not for a hover or an open", () => {
		const { message, reads } = counted();
		const component = new AgentMessageComponent(message, undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		component.render(W);
		const first = reads();
		component.getClickRegions()[0]?.onHover?.(true);
		component.render(W);
		component.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
		const opened = component.render(W);
		expect(reads()).toBe(first);
		expect(opened.length).toBeGreaterThan(100);
		component.render(60);
		expect(reads()).toBeGreaterThan(first);
		const afterWidth = reads();
		component.render(60);
		expect(reads()).toBe(afterWidth);
		component.invalidate();
		component.render(60);
		expect(reads()).toBeGreaterThan(afterWidth);
	});

	it("still promises the rows a click opens from the cached body", () => {
		const { message } = counted();
		const component = new AgentMessageComponent(message, undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		component.render(W);
		const promised = component.getClickRegions()[0]?.revealBelow ?? 0;
		component.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
		expect(plain(component.render(W)).length - 1).toBe(promised);
	});
});

describe("what a report says on its one row", () => {
	it("takes the task from the brackets after the lane name and the conclusion after `结论：`", () => {
		expect(reportParts(okBody)).toEqual({ label: "框的长高和折叠", conclusion: "没问题（7 条小建议）" });
		expect(
			reportParts(
				"车道D（测试质量+发版文档卫生）完工。报告：/tmp/laneD.md\n\n结论：P0×1、P1×2、P2×8（另列「已查无恙」11 项覆盖面）。**注意：审查期间仓库动了**",
			),
		).toEqual({ label: "测试质量+发版文档卫生", conclusion: "P0×1、P1×2、P2×8（另列「已查无恙」11 项覆盖面）" });
	});

	it("falls back to the first sentence, without the lane name and brackets, when there is no conclusion line", () => {
		expect(reportParts("车道C（子代理条带重写）审查完毕。报告在 /tmp/c.md")).toEqual({
			label: "子代理条带重写",
			conclusion: "审查完毕",
		});
		expect(reportParts("好了")).toEqual({ conclusion: "好了" });
		expect(reportParts("")).toEqual({ conclusion: "" });
		expect(reportParts("第一行\n第二行")).toEqual({ conclusion: "第一行" });
	});

	it("reads a conclusion heading's next line", () => {
		expect(reportParts("## 结论：\n没有阻塞项。\n细节略").conclusion).toBe("没有阻塞项");
	});

	it("names a subagent by its lane letter, and only when it has exactly one", () => {
		expect(shortAgentName("review-grow-B-box")).toBe("B");
		expect(shortAgentName("ff-review-d-keys")).toBe("D");
		expect(shortAgentName("worker-1")).toBe("worker-1");
		expect(shortAgentName("a-b-lane")).toBe("a-b-lane");
		expect(shortAgentName("Planner")).toBe("Planner");
	});

	it("reads negated levels as no level", () => {
		expect(verdictLevel("无 P0、无 P1，4 条 P2")).toBe("ok");
		expect(verdictLevel("no P0 or P1, three P2")).toBe("ok");
		expect(verdictLevel("0 条 P0，2 条 P1")).toBe("fix");
		expect(verdictLevel("P2 only")).toBe("ok");
		expect(verdictLevel("this must change")).toBe("must");
		expect(verdictLevel("you should look")).toBe("fix");
	});
});

describe("a subagent's notice on the timeline", () => {
	const notice = (name: string, lastText?: string) =>
		createRlmChildTerminalNoticeMessage(
			{
				kind: "completed_without_reply",
				childId: `${name}-id`,
				sessionName: name,
				...(lastText ? { lastAssistantText: lastText } : {}),
			},
			AT,
		);

	it("stays out of sight by default, and shows as a dim note under 完整过程", () => {
		timelineShowAll.set(false);
		const lane = new SubagentLane();
		const row = subagentNoticeRow(notice("review-grow-C-strip", "我看完了"), lane);
		expect(row?.render(W)).toEqual([]);
		expect(row?.getClickRegions()).toEqual([]);
		timelineShowAll.set(true);
		try {
			const lines = plain(row?.render(W) ?? []).map((line) => line.trimEnd());
			expect(lines).toHaveLength(1);
			expect(lines[0]?.startsWith(" 18:54   ·      子代理 C 做完了，没发回消息")).toBe(true);
			expect(lines[0]?.endsWith("▸")).toBe(true);
			row?.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
			const opened = plain(row?.render(W) ?? []).map((line) => line.trimEnd());
			expect(opened.some((line) => line.includes("它最后写的："))).toBe(true);
			expect(opened.some((line) => line.includes("我看完了"))).toBe(true);
		} finally {
			timelineShowAll.set(false);
		}
	});

	it("still closes the lane when it is the last one out, even out of sight", () => {
		timelineShowAll.set(false);
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-C-strip"]);
		const row = subagentNoticeRow(notice("review-grow-C-strip"), lane);
		expect(plain(row?.render(W) ?? []).map((line) => line.trimEnd())).toEqual(["         ├──╯   做完了，没发回消息"]);
		expect(lane.tracker.active).toBe(false);
		expect(row?.drawsNothing).toBe(false);
	});

	it("always shows a failure, in red on the subagent lane, and lets the lane go", () => {
		timelineShowAll.set(false);
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-C-strip", "review-grow-D-hygiene"]);
		const failure = createRlmChildFailureMessage(
			{ childId: "c-id", sessionName: "review-grow-C-strip", error: "out of memory", kind: "error" },
			AT,
		);
		const row = subagentNoticeRow(failure, lane);
		const lines = plain(row?.render(W) ?? []).map((line) => line.trimEnd());
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith(" 18:54   │  ◇   子代理 C 失败（出错）")).toBe(true);
		expect(row?.render(W)[0]).toContain(theme.fg("timelineMust", "子代理 C 失败（出错）"));
		expect(lane.tracker.pending).toEqual(["review-grow-D-hygiene"]);
	});

	const stallNotice = (silentMs: number | undefined) => ({
		role: "custom" as const,
		customType: "rlm_child_stall_notice",
		content: "silent",
		display: true,
		details: {
			childId: "c",
			sessionName: "review-grow-C-strip",
			...(silentMs !== undefined ? { silentMs } : {}),
			thresholdMs: 300_000,
			inFlightTools: [],
		},
		timestamp: AT,
	});

	it("always shows a stall warning, in amber, without 完整过程, and keeps the subagent out", () => {
		timelineShowAll.set(false);
		const lane = new SubagentLane();
		lane.tracker.spawned(["review-grow-C-strip", "review-grow-D-hygiene"]);
		const row = subagentNoticeRow(stallNotice(600_000), lane);
		const lines = plain(row?.render(W) ?? []).map((line) => line.trimEnd());
		expect(lines).toEqual([" 18:54   ·  ┆   子代理 C 已经 10 分钟没动静"]);
		expect(row?.render(W)[0]).toContain(theme.fg("timelineFix", "子代理 C 已经 10 分钟没动静"));
		expect(row?.drawsNothing).toBe(false);
		expect(lane.tracker.pending).toEqual(["review-grow-C-strip", "review-grow-D-hygiene"]);
	});

	it("words the silence in seconds, minutes and hours, and says so when it does not know how long", () => {
		const said = (silentMs: number | undefined) =>
			plain(subagentNoticeRow(stallNotice(silentMs), new SubagentLane())?.render(W) ?? [])[0]
				?.trimEnd()
				.slice(16);
		expect(said(45_000)).toBe("子代理 C 已经 45 秒没动静");
		expect(said(60_000)).toBe("子代理 C 已经 1 分钟没动静");
		expect(said(3_600_000)).toBe("子代理 C 已经 1 小时没动静");
		expect(said(5_400_000)).toBe("子代理 C 已经 1 小时 30 分钟没动静");
		expect(said(undefined)).toBe("子代理 C 一阵没动静了");
	});

	it("keeps a silent finish and a cancel out of sight without 完整过程", () => {
		timelineShowAll.set(false);
		const cancelled = createRlmChildTerminalNoticeMessage(
			{ kind: "cancelled", childId: "c", sessionName: "review-grow-C-strip", reason: "用户取消" },
			AT,
		);
		expect(subagentNoticeRow(cancelled, new SubagentLane())?.render(W)).toEqual([]);
	});

	it("is undefined for any other message", () => {
		expect(
			subagentNoticeRow(
				{ role: "custom", customType: "other", content: "x", display: true, timestamp: AT },
				new SubagentLane(),
			),
		).toBeUndefined();
	});
});
