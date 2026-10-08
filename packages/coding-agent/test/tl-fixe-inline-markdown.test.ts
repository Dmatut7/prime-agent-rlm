import { setKeybindings } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementOutcomeMessage, createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { AgentMessageComponent, reportParts, SubagentLane } from "../src/modes/interactive/components/agent-message.js";
import {
	INLINE_MARKDOWN_MAX_LENGTH,
	stripInlineMarkdown,
	styleInlineMarkdown,
} from "../src/modes/interactive/components/inline-markdown.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { subagentNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { plain, useTruecolorTheme } from "./ui-blocks-helpers.js";

let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	// Bold and colors only show in the output when the color level is on; without it every paint assertion holds vacuously.
	chalkLevel = chalk.level;
	chalk.level = 3;
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
	timelineShowAll.set(false);
});

describe("what the inline markup of a sentence turns into", () => {
	// The whole list of what is understood, pinned as one table: a change to the parser must change it.
	const cases: Array<[string, string, string]> = [
		["code", "见 `src/a.ts` 里", "见 src/a.ts 里"],
		["code keeps what is inside", "路径 `**/*.ts` 要留着", "路径 **/*.ts 要留着"],
		["double-backtick code", "双反引号 ``x`` 的 span", "双反引号 x 的 span"],
		["double-backtick code around a backtick", "a ``x`y`` b", "a x`y b"],
		["an empty span stays as typed", "空的 `` 不动", "空的 `` 不动"],
		["an unmatched backtick stays", "只有一个 ` 号", "只有一个 ` 号"],
		["bold", "结论：**无 P0**，其余略", "结论：无 P0，其余略"],
		["an unmatched bold marker stays", "**没闭合", "**没闭合"],
		["bold with padding is not bold", "a ** b ** c", "a ** b ** c"],
		["link keeps its text only", "见 [报告](https://x.y/r.md) 全文", "见 报告 全文"],
		["link with a double-quoted title", '见 [报告](https://x.y/r.md "发布说明") 全文', "见 报告 全文"],
		["link with a single-quoted title", "见 [报告](https://x.y/r.md '发布说明') 全文", "见 报告 全文"],
		["link with a parenthesized title", "见 [报告](https://x.y/r.md (发布说明)) 全文", "见 报告 全文"],
		[
			"link whose title never closes stays",
			'看 [t](https://a.y/b "没闭合) 这条',
			'看 [t](https://a.y/b "没闭合) 这条',
		],
		[
			"link with text after the title stays",
			'看 [t](https://a.y/b "t" 多余) 这条',
			'看 [t](https://a.y/b "t" 多余) 这条',
		],
		["link with parentheses in its address", "看 [t](https://a.y/b(c)) 这条", "看 t 这条"],
		["link with nested parentheses", "看 [t](https://a.y/b(c(d))) 这条", "看 t 这条"],
		["link whose address never closes stays", "看 [t](https://a.y/b 这条", "看 [t](https://a.y/b 这条"],
		["a backtick inside bold is kept, not deleted", "**a `b` c**", "a b c"],
		["bold link text", "[**x**](u)", "x"],
		["a link inside bold", "**[x](u)**", "x"],
		["code as link text", "[`x`](u)", "x"],
		["a lone star is plain", "5 * 3 = 15", "5 * 3 = 15"],
		["italics are not understood and stay", "*italic* 和 __name__ 和 ~~gone~~", "*italic* 和 __name__ 和 ~~gone~~"],
	];

	it("is pinned for every supported and unsupported form", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const [name, input, expected] of cases) {
			expect(stripInlineMarkdown(input), name).toBe(expected);
		}
	});

	it("keeps the code inside a bold run painted as code and bold", () => {
		expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
		const raw = styleInlineMarkdown("看 **a `b` c** 吧", "text");
		expect(raw).toContain(theme.bold(theme.fg("text", "a ")));
		expect(raw).toContain(theme.bold(theme.fg("timelineSoft", "b")));
		expect(raw).toContain(theme.bold(theme.fg("text", " c")));
		expect(plain([raw])[0]).toBe("看 a b c 吧");
	});

	it("leaves a very long line as plain text instead of parsing it", () => {
		// splitInline rescans the remaining text for every `[`, so past the guard
		// a single line parses in O(n²) (tl2 FIX-D 硬门槛: 50KB took 1.1s): the
		// markup is left as written instead.
		const long = `${"x".repeat(INLINE_MARKDOWN_MAX_LENGTH)} **bold** \`code\` [link](https://x.y)`;
		expect(long.length).toBeGreaterThan(INLINE_MARKDOWN_MAX_LENGTH);
		expect(stripInlineMarkdown(long)).toBe(long);
		expect(styleInlineMarkdown(long, "text")).toBe(theme.fg("text", long));

		// Exactly at the guard the line still parses.
		const atGuard = `${"x".repeat(INLINE_MARKDOWN_MAX_LENGTH - "**b**".length)}**b**`;
		expect(atGuard.length).toBe(INLINE_MARKDOWN_MAX_LENGTH);
		expect(stripInlineMarkdown(atGuard)).toBe(`${"x".repeat(INLINE_MARKDOWN_MAX_LENGTH - "**b**".length)}b`);
	});
});

const AT = new Date(2026, 8, 29, 18, 54).getTime();
const MARKED = "结论：**无 P0**，修了 `src/a.ts`，见 [报告](https://x.y/r.md)。";
const BODY = `车道B（盒子）审查完成。\n\n${MARKED}\n\n\`\`\`\nrun **not bold** [x](y)\n\`\`\``;

function report(body: string): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id: "agentmsg_B",
			source: AGENT_MESSAGE_SOURCE,
			message: body,
			from: { sessionName: "review-grow-B-box", sessionId: "B-s", activeSessionId: "B-a" },
			fromRelationship: "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		AT,
	);
}

function reportRows(expanded: boolean): string[] {
	const component = new AgentMessageComponent(report(BODY), undefined, {
		suppressLeadingSpace: true,
		timeline: { before: "on", after: "on" },
	});
	if (expanded) component.setExpanded(true);
	return plain(component.render(120)).map((row) => row.trimEnd());
}

describe("a subagent's report row", () => {
	it("says its conclusion without markup or the link's address", () => {
		expect(reportParts(MARKED).conclusion).toBe("无 P0，修了 src/a.ts，见 报告");
		const [head] = reportRows(false);
		expect(head).toContain("无 P0，修了 src/a.ts，见 报告");
		expect(head).not.toContain("https://");
		expect(head).not.toContain("[");
	});

	it("opens to the whole report with its inline markup drawn, and code fences left as written", () => {
		const rows = reportRows(true);
		const conclusion = rows.find((row) => row.includes("结论：")) ?? "";
		expect(conclusion).toContain("结论：无 P0，修了 src/a.ts，见 报告。");
		expect(conclusion).not.toContain("**");
		expect(conclusion).not.toContain("https://");
		expect(rows.some((row) => row.includes("run **not bold** [x](y)"))).toBe(true);
	});

	it("paints the opened report's bold words bold", () => {
		const component = new AgentMessageComponent(report(BODY), undefined, {
			suppressLeadingSpace: true,
			timeline: { before: "on", after: "on" },
		});
		component.setExpanded(true);
		expect(component.render(120).join("\n")).toContain(theme.bold(theme.fg("timelineSoft", "无 P0")));
	});
});

describe("a subagent notice's detail", () => {
	it("draws what the child wrote last without its markup", () => {
		timelineShowAll.set(true);
		try {
			const notice = createRlmChildTerminalNoticeMessage(
				{
					kind: "completed_without_reply",
					childId: "c-id",
					sessionName: "review-grow-C-strip",
					lastAssistantText: "改完了 **三处**，见 [说明](https://x.y/z) 与 `a.ts`",
				},
				AT,
			);
			const row = subagentNoticeRow(notice, new SubagentLane());
			row?.getClickRegions();
			row?.render(120);
			row?.getClickRegions()[0]?.onClick({ row: 0, col: 0 });
			const opened = plain(row?.render(120) ?? []).map((line) => line.trimEnd());
			const line = opened.find((entry) => entry.includes("改完了")) ?? "";
			expect(line).toContain("改完了 三处，见 说明 与 a.ts");
			expect(line).not.toContain("https://");
		} finally {
			timelineShowAll.set(false);
		}
	});
});

describe("a memory tidy's own note on why", () => {
	it("draws its inline markup, once the tidy is opened", () => {
		const after: HarnessEntry = {
			id: "eval-progress",
			kind: "memory",
			title: "评估进度",
			content: "停止",
			path: "memories/eval.md",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refinement",
			created_at: "2026-09-24T00:00:00.000Z",
			updated_at: "2026-09-24T00:00:00.000Z",
			version: 1,
		};
		const result: RefinementResult = {
			id: "r1",
			summary: "把 `eval` 状态改成 **停止**，见 [说明](https://x.y/z)。",
			rationale: "",
			expectedOutcome: "",
			appliedEdits: [
				{
					action: "update",
					kind: "memory",
					id: after.id,
					title: after.title,
					content: after.content,
					after,
					applied: true,
				},
			],
			harnessStatePath: "/tmp/state.json",
			scope: "local",
		};
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result));
		component.setExpanded(true);
		timelineShowAll.set(true);
		try {
			const rows = plain(component.render(120));
			const why = rows.find((row) => row.includes("状态改成")) ?? "";
			expect(why).toContain("把 eval 状态改成 停止，见 说明。");
			expect(why).not.toContain("https://");
			expect(why).not.toContain("**");
		} finally {
			timelineShowAll.set(false);
		}
	});
});
