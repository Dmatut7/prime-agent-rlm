import { CONTENT_START_MARKER, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildFailureMessage } from "../src/core/messages.js";
import {
	AgentMessageComponent,
	agentMessageBodyLines,
	agentMessagePreview,
	agentMessageSenderName,
	agentMessageSummaryLine,
	receivedAgentMessageLine,
	reportParts,
	SubagentLane,
	shortAgentName,
} from "../src/modes/interactive/components/agent-message.js";
import { sanitizeDisplayText } from "../src/modes/interactive/components/diff-rows.js";
import { recapLineText } from "../src/modes/interactive/components/recap-line.js";
import {
	SystemNoticeLine,
	subagentNoticeRow,
	TimelineNoticeRow,
} from "../src/modes/interactive/components/system-notice.js";
import type { BoxRow, TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import { TurnActivityState } from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER, computeBoxHeader } from "../src/modes/interactive/components/turn-box.js";
import { addCommand, assistant, plain, quietTurn, text, useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * The render faces that build their own rows instead of handing their text to
 * `Text` (whose render is the central wash): the turn box's header and step meta,
 * a subagent's report row, a timeline notice and its opened detail. Each of them
 * interpolates text a model wrote - a subagent's name, a report, a command, an
 * error - so each of them is a terminal-injection face: an OSC 52 rewrites the
 * user's clipboard, a CSI J clears the screen, a BEL rings, a newline turns one
 * accounted row into two.
 */

const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J\u001b[H";
const HYPERLINK = "\u001b]8;;http://evil.example\u0007\u001b]8;;\u0007";
const PAINT = "\u001b[31m";

/** A word with every vector the audit's probes used hung off it. */
function dirty(words: string): string {
	return `${words}${OSC52}${CLEAR}\u0007\r${PAINT}${HYPERLINK}`;
}

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

/** What a face may still emit: its own markers and the theme's SGR codes. Nothing else. */
function ownEscapes(line: string): string {
	return line
		.split(CONTENT_START_MARKER)
		.join("")
		.split(BOX_FOCUS_MARKER)
		.join("")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Byte-level clean, and the words the reader was meant to see are still there. */
function expectClean(lines: readonly string[], face: string, keeps: readonly string[] = []): void {
	expect(lines.length, `${face}: nothing rendered`).toBeGreaterThan(0);
	for (const line of lines) {
		const left = ownEscapes(line);
		expect(left, `${face}: an escape survived in ${JSON.stringify(line)}`).not.toContain("\u001b");
		expect(left, `${face}: a BEL survived in ${JSON.stringify(line)}`).not.toContain("\u0007");
		expect(line, `${face}: the clipboard payload survived`).not.toContain("cGFzdGU=");
		expect(line, `${face}: an OSC 52 survived`).not.toContain("]52;");
		expect(line, `${face}: a clear-screen survived`).not.toContain("[2J");
	}
	const shown = plain(lines).join("\n");
	for (const words of keeps) expect(shown, `${face}: lost ${words}`).toContain(words);
}

const EMPTY_FACTS: TimelineFacts = {
	thinkCount: 0,
	commandCount: 0,
	readCount: 0,
	stepCount: 0,
	subagentCount: 0,
	errorCount: 0,
	projectChanges: [],
	scratchChanges: [],
	memories: [],
	trackingIncomplete: false,
};

function row(kind: BoxRow["kind"], textOfRow: string, extra: Partial<BoxRow> = {}): BoxRow {
	return {
		key: `k-${kind}`,
		kind,
		status: "running",
		glyph: "",
		glyphColor: "kindRead",
		text: textOfRow,
		textColor: "text",
		meta: [],
		...extra,
	};
}

function headerOf(rows: readonly BoxRow[], currentThinking = ""): string {
	const turn = quietTurn();
	return computeBoxHeader({
		rows,
		facts: EMPTY_FACTS,
		timeline: turn.timeline,
		live: true,
		phase: currentThinking ? "thinking" : "waiting",
		currentThinking,
		now: Date.now(),
	}).plain;
}

describe("R4-M1: the turn box's header washes what its step rows already washed", () => {
	it("names a waiting subagent without its escape sequences", () => {
		const header = headerOf([row("subagent", dirty("worker"))]);
		expect(header).toBe("在等子代理 worker 交回结果");
	});

	it("reads a running command, a file and an edit without their control characters", () => {
		expect(headerOf([row("cmd", dirty("npm test"))])).toBe("正在运行 npm test");
		expect(headerOf([row("read", dirty("x.ts"), { files: [`/tmp/${dirty("notes.md")}`] })])).toBe(
			"正在读取 /tmp/notes.md",
		);
		expect(headerOf([row("edit", dirty("src/a.ts"))])).toBe("正在修改 src/a.ts");
	});

	it("counts several waiting subagents without repeating a dirty name", () => {
		const header = headerOf([row("subagent", dirty("a")), { ...row("subagent", dirty("b")), key: "k2" }]);
		expect(header).toBe("在等 2 个子代理交回结果");
	});

	it("keeps a header one physical row when the name carries a newline", () => {
		const header = headerOf([row("subagent", "worker\nsecond row")]);
		expect(header).toBe("在等子代理 worker second row 交回结果");
		expect(header).not.toContain("\n");
	});

	it("quotes a thinking sentence without the escapes it carries", () => {
		const header = headerOf([], `先看一下${OSC52}。再看`);
		expect(header.startsWith("思考中 · ")).toBe(true);
		expect(header).not.toContain("cGFzdGU=");
		expect(ownEscapes(header)).not.toContain("\u001b");
	});

	it("draws a finished step's words and its meta clean end to end", () => {
		const turn = quietTurn({ live: false });
		addCommand(turn, "c1", dirty("npm run check"), { detail: dirty("全绿"), output: dirty("ok") });
		turn.state.markTurnEnded(Date.now());
		turn.state.finishBox(Date.now());
		// Open the event, so the step rows and their right-side meta are drawn too.
		turn.summary.render(120);
		for (const key of turn.summary.getFocusOrder()) turn.summary.activate(key);
		const lines = turn.summary.render(120);
		expectClean(lines, "the finished box");
		const shown = text(lines);
		expect(shown).toContain("npm run check");
		expect(shown).toContain("全绿");
	});

	it("opens a merged multi-file read without the escapes its file names carry", () => {
		const turn = quietTurn({ live: false });
		const at = Date.now() - 4_000;
		// The dirty tail deliberately holds no `/`: the step label takes the path's
		// last slash-separated segment as the file name, so a URL-shaped escape
		// would move the "name" rather than test the detail's own wash.
		const dirtyName = (name: string) => `${name}${OSC52}${CLEAR}\u0007\r${PAINT}`;
		// Two read calls in one reply: the box merges them into one `读取了 2 个文件`
		// row whose expanded detail lists each file path the model named.
		const reads = [
			{ id: "read-a", file: `src/${dirtyName("a.ts")}` },
			{ id: "read-b", file: `docs/${dirtyName("b.md")}` },
		];
		turn.timeline.noteMessage(
			assistant(
				at,
				reads.map(({ id, file }) => ({
					type: "toolCall" as const,
					id,
					name: "read",
					arguments: { file_path: file },
				})),
			),
			true,
		);
		for (const { id, file } of reads) {
			turn.state.addStep({ toolCallId: id, toolName: "read", args: { file_path: file }, status: "done" });
		}
		turn.state.markTurnEnded(Date.now());
		turn.state.finishBox(Date.now());
		turn.summary.render(120);
		for (const key of turn.summary.getFocusOrder()) {
			if (key.startsWith("ev:") && turn.summary.enterLabel(key) === "展开") turn.summary.activate(key);
		}
		const opened = plain(turn.summary.render(120));
		expect(opened.join("\n")).toContain("读取了 2 个文件");
		// Click the merged read row to expand its per-file detail.
		const index = opened.findIndex((line) => line.includes("读取了 2 个文件"));
		const region = turn.summary.getClickRegions().find((candidate) => candidate.line === index);
		expect(region, "the merged read row").toBeDefined();
		region?.onClick({ row: index, col: 0 });
		const lines = turn.summary.render(120);
		expectClean(lines, "the opened read detail", ["a.ts", "b.md"]);
	});
});

describe("R4-M2: a subagent's report is washed on every face that draws it", () => {
	it("washes the sender name, the preview and the short name", () => {
		expect(agentMessageSenderName({ sessionName: dirty("worker") })).toBe("worker");
		expect(shortAgentName(dirty("review-grow-B-box"))).toBe("B");
		expect(shortAgentName(dirty("worker"))).toBe("worker");
		expect(agentMessagePreview(10, `结论：没问题。${OSC52}`)).toBe("结论：没问题。");
	});

	it("falls through to the next identity when a sender name is only escape sequences", () => {
		// A name that washes to nothing must not win the fallback chain and blank
		// the row: the next identity names the sender instead.
		expect(agentMessageSenderName({ sessionName: `${OSC52}${CLEAR}`, activeSessionId: "act-9" })).toBe("act-9");
		expect(agentMessageSenderName({ sessionName: `${OSC52}${PAINT}` })).toBe("unknown");
	});

	it("washes the summary line and the received-message line", () => {
		expect(ownEscapes(agentMessageSummaryLine(dirty("子代理"), dirty("worker"), dirty("好了")))).not.toContain(
			"\u001b",
		);
		expect(plain([receivedAgentMessageLine(dirty("worker"), "交回", dirty("好了"))])[0]).toContain(
			"worker 交回：好了",
		);
		expect(ownEscapes(receivedAgentMessageLine(dirty("worker"), "交回", dirty("好了")))).not.toContain("\u001b");
	});

	it("washes the label and the conclusion a report row is built from", () => {
		const parts = reportParts(`车道 C（清洗${OSC52}残余）审查完毕\n\n结论：没问题${CLEAR}。其余略。`);
		expect(parts.label).toBe("清洗残余");
		expect(parts.conclusion).toBe("没问题");
	});

	it("keeps the body's own line breaks and drops everything else", () => {
		const lines = agentMessageBodyLines(`第一行${OSC52}\n第二行\t缩进`, 100);
		expectClean(lines, "the legacy body");
		expect(plain(lines).join("\n")).toContain("第一行");
		expect(plain(lines).join("\n")).toContain("第二行");
		expect(lines.length).toBe(2);
	});

	const report = createAgentSessionMessage({
		id: "agentmsg_lane_c",
		source: AGENT_MESSAGE_SOURCE,
		message: `车道 C（清洗${OSC52}残余）审查完毕\n\n结论：没问题${CLEAR}。\n\n\u0060\u0060\u0060\n${dirty("code")}\n\u0060\u0060\u0060\n`,
		from: { sessionName: dirty("review-grow-C-box"), sessionId: "c1" },
		fromRelationship: "child",
		target: { activeSessionId: "main-active", sessionId: "main" },
	});

	it("draws the timeline row and its opened report clean", () => {
		const component = new AgentMessageComponent(report, undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "off", after: "off" },
		});
		const closed = component.render(120);
		expectClean(closed, "the report row", ["C 交回", "清洗残余", "没问题"]);
		component.setExpanded(true);
		const opened = component.render(120);
		expectClean(opened, "the opened report", ["code"]);
		expect(opened.length).toBeGreaterThan(closed.length);
	});

	it("draws the legacy header and its opened body clean", () => {
		const component = new AgentMessageComponent(report, undefined, { suppressLeadingSpace: true });
		const closed = component.render(120);
		expectClean(closed, "the legacy header row", ["review-grow-C-box 交回"]);
		expect(closed.length).toBe(1);
		component.setExpanded(true);
		expectClean(component.render(120), "the legacy opened report", ["code"]);
	});
});

describe("R4-M3: a timeline notice washes its row and its opened detail", () => {
	const notice = {
		tone: "error" as const,
		text: `子代理 ${dirty("worker")} 失败了`,
		detail: `第一行${OSC52}\n${CLEAR}第二行`,
	};

	it("draws the head row and the opened detail clean", () => {
		const row = new TimelineNoticeRow(notice, Date.now(), {
			shown: true,
			back: { before: "off", after: "off" },
			hoverKey: "lane-c-notice",
		});
		const closed = row.render(120);
		expectClean(closed, "the notice row", ["子代理 worker 失败了"]);
		const regions = row.getClickRegions();
		expect(regions.length).toBe(1);
		regions[0]?.onClick({ row: 0, col: 0 });
		const opened = row.render(120);
		expectClean(opened, "the opened notice", ["第一行", "第二行"]);
		expect(opened.length).toBeGreaterThan(closed.length);
	});

	it("draws the centered system-notice line clean", () => {
		const lines = new SystemNoticeLine(dirty("memory updated"), dirty("记下一条经验"), dirty("Ctrl+O diff")).render(
			120,
		);
		expectClean(lines, "the system notice line", ["memory updated", "记下一条经验"]);
		expect(lines.length).toBe(1);
	});
});

describe("R4-M17's faces: a subagent failure notice carries a dirty name and a dirty error", () => {
	it("draws the failure row and its opened error clean", () => {
		const lane = new SubagentLane();
		const row = subagentNoticeRow(
			createRlmChildFailureMessage({
				kind: "error",
				childId: "child-1",
				sessionName: dirty("review-grow-C-box"),
				error: `TypeError: x is not a function${OSC52}\n${CLEAR}at foo (bar.ts:1)`,
			}),
			lane,
		);
		expect(row).toBeDefined();
		const closed = row?.render(120) ?? [];
		expectClean(closed, "the failure row", ["子代理", "失败"]);
		row?.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
		const opened = row?.render(120) ?? [];
		expectClean(opened, "the opened failure", ["TypeError", "at foo (bar.ts:1)"]);
		expect(opened.length).toBeGreaterThan(closed.length);
	});
});

describe("the shared display washer drops whole sequences, not just the ESC that starts them", () => {
	it("leaves no visible residue of a clipboard write", () => {
		expect(sanitizeDisplayText(`worker${OSC52}`)).toBe("worker");
		expect(sanitizeDisplayText(`a${CLEAR}b`)).toBe("ab");
		expect(sanitizeDisplayText("keep\nthis line break")).toBe("keep\nthis line break");
	});
});

describe("R4-M14 read side: the recap line washes whatever source it replays", () => {
	it("washes a poisoned journal recap before it reaches the TruncatedText row", () => {
		// The recap line renders through TruncatedText, a component the Text gate
		// never sees, and the snapshot's baseline recap comes straight from a journal
		// a pre-wash build could have written.
		const line = recapLineText(`修好了${OSC52}登录${CLEAR}的回归`, false);
		expect(line).toBe("回顾：修好了登录的回归");
	});

	it("drops a recap that was nothing but escape sequences", () => {
		expect(recapLineText(`${OSC52}${CLEAR}${PAINT}`, false)).toBeUndefined();
	});

	it("still reads a clean recap the way it always did", () => {
		expect(recapLineText("干净的一条回顾", false)).toBe("回顾：干净的一条回顾");
	});
});

describe("R3-M22 residual: the legacy process line washes its tool verbs", () => {
	it("washes a malformed tool name where the aggregate verb line joins it", () => {
		const state = new TurnActivityState(Date.now() - 5_000);
		state.addStep({ toolCallId: "t1", toolName: `ba${OSC52}sh`, args: {}, status: "done" });
		state.addStep({ toolCallId: "t2", toolName: `ba\u0007sh${CLEAR}`, args: {}, status: "done" });
		const text = state.summaryText();
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
		// Two dirty names that wash to the same verb count as one verb, twice.
		expect(text).toContain("bash×2");
	});
});
