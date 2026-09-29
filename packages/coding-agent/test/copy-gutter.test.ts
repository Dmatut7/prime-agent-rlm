import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { FullscreenViewport, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { addCommand, plain, quietTurn, useTruecolorTheme } from "./ui-blocks-helpers.js";

const WIDTH = 100;
const AT = new Date(2026, 8, 29, 18, 54).getTime();
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const GUTTER_GLYPHS = /[│┆┃◇◆●✦╵├╎]/;
const CLOCK = /\d\d:\d\d/;

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => restoreTheme());

function summary(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: AT,
	};
}

function report(name: string, body: string): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id: `agentmsg_${name}`,
			source: AGENT_MESSAGE_SOURCE,
			message: body,
			from: { sessionName: name, sessionId: `${name}-s`, activeSessionId: `${name}-a` },
			fromRelationship: "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		AT,
	);
}

/** Drag from the first cell of the first row to the far end of the last row and return what is copied. */
function dragCopyAll(lines: string[]): string | null {
	const viewport = new FullscreenViewport();
	const dock = ["> prompt"];
	const height = lines.length + dock.length;
	viewport.composeFrame(lines, dock, height);
	expect(viewport.beginSelection(0, 0)).toBe(true);
	viewport.extendSelection(lines.length - 1, WIDTH);
	return viewport.endSelection();
}

describe("copying a drag-selection from the timeline", () => {
	it("takes the words of every kind of row and none of the time column or rails", () => {
		const turn = quietTurn({ live: false });
		addCommand(turn, "k1", "npm run check", { output: "ok" });
		const rows = [
			...new UserMessageComponent("审查最近的改动", undefined, undefined, AT, { quiet: true }).render(WIDTH),
			...turn.summary.render(WIDTH),
			...new AgentMessageComponent(report("review-b", "车道B审查完成\n\n结论：没问题（3 条小建议）。"), undefined, {
				suppressLeadingSpace: true,
				timeline: { before: "on", after: "on" },
			}).render(WIDTH),
			...new AssistantMessageComponent(
				summary("第一段结论。\n\n第二段说明，含有 18:54 这个时间。"),
				false,
				undefined,
				"思考",
				{ quiet: true },
			).render(WIDTH),
		];
		expect(plain(rows).some((row) => CLOCK.test(row) && GUTTER_GLYPHS.test(row))).toBe(true);

		const copied = dragCopyAll(rows);
		expect(copied).not.toBeNull();
		const text = copied ?? "";
		expect(text).toContain("审查最近的改动");
		expect(text).toContain("没问题（3 条小建议）");
		expect(text).toContain("第一段结论。\n\n第二段说明，含有 18:54 这个时间。");
		expect(text).toContain("总结");
		// The only clock in the copied text is the one the summary itself says.
		expect(text.match(/\d\d:\d\d/g)).toEqual(["18:54"]);
		expect(text).not.toMatch(GUTTER_GLYPHS);
		for (const row of text.split("\n")) expect(row).toBe(row.trimEnd());
	});

	it("keeps the empty rows between paragraphs of a summary", () => {
		const rows = new AssistantMessageComponent(summary("甲段。\n\n乙段。"), false, undefined, "思考", {
			quiet: true,
		}).render(WIDTH);
		expect(dragCopyAll(rows)).toBe("总结\n\n甲段。\n\n乙段。");
	});
});

describe("the mark does not disturb what reads a row's shape", () => {
	it("a return that opens a turn shares the turn's two empty rows instead of adding a third", () => {
		const turn = quietTurn({ live: false });
		turn.summary.setLeadingRows(2);
		const agent = new AgentMessageComponent(report("review-b", "车道B审查完成\n\n结论：没问题。"), undefined, {
			timeline: { before: "on", after: "on" },
		});
		expect(plain(agent.render(WIDTH))[0]?.trim()).toMatch(/^│/);
		turn.summary.addInlineRow(agent, AT);
		turn.state.markTurnEnded(AT + 60_000);
		const rows = plain(turn.summary.render(WIDTH)).map((row) => row.trimEnd());
		const firstReport = rows.findIndex((row) => row.includes("交回"));
		expect(firstReport).toBe(2);
	});

	it("a block copy takes the words of the rows, not their gutter", () => {
		const turn = quietTurn({ live: false });
		addCommand(turn, "k1", "npm run check", { output: "ok" });
		const copied = turn.summary.getBlockCopyText();
		expect(copied).toContain("跑了 1 条命令");
		expect(copied).not.toMatch(CLOCK);
		expect(copied).not.toMatch(GUTTER_GLYPHS);
		expect(copied).not.toContain("pi:content");
	});
});
