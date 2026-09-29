import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The question row and the summary (answer) on the timeline, cell for cell
 * against the Tl2Done design: ` HH:MM   ` (9 columns), the AI's line (1),
 * the subagent lane (3), three spaces, content from column 16.
 */
const SENT_AT = new Date(2026, 8, 29, 18, 47).getTime();
const ANSWERED_AT = new Date(2026, 8, 29, 19, 6).getTime();
const PROMPT = "对最近的改动做全面的审查 多个代理一起";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: ANSWERED_AT,
		...extra,
	};
}

function answer(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return assistant([{ type: "text", text }], extra);
}

/** What the terminal shows: no styling, no OSC 133 zone marks, trailing spaces gone. */
function shown(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).trimEnd());
}

function quietAnswer(message: AssistantMessage, options: { lane?: "off" | "on" } = {}): AssistantMessageComponent {
	return new AssistantMessageComponent(message, false, undefined, "思考", { quiet: true, ...options });
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("your question on the timeline", () => {
	function question(text = PROMPT, options: { lane?: "off" | "on" } = {}): UserMessageComponent {
		return new UserMessageComponent(text, undefined, undefined, SENT_AT, { quiet: true, ...options });
	}

	test("draws `HH:MM ● 你   <text>` and two empty main-line rows, no bubble, no `you` label", () => {
		const lines = question().render(100);
		expect(shown(lines)).toEqual([
			" 18:47   ●      你   对最近的改动做全面的审查 多个代理一起",
			"         │",
			"         │",
		]);
		expect(lines.join("")).not.toContain("\x1b[48");
		expect(shown(lines).join("\n")).not.toContain("you");
	});

	test("the label starts at column 16 and the text at column 21", () => {
		const first = shown(question().render(100))[0] ?? "";
		expect(visibleWidth(first.slice(0, first.indexOf("你")))).toBe(16);
		expect(visibleWidth(first.slice(0, first.indexOf("对")))).toBe(21);
	});

	test("the time, the dot and the label take the timeline colors, the label in bold", () => {
		const first = question().render(100)[0] ?? "";
		expect(first).toContain(theme.fg("timelineTime", " 18:47   "));
		expect(first).toContain(theme.bold(theme.fg("timelineUser", "●")));
		expect(first).toContain(theme.bold(theme.fg("timelineUser", "你")));
	});

	test("the two rows under it carry the main line in the rail color", () => {
		const lines = question().render(100);
		expect(lines[1]).toContain(theme.fg("timelineRail", "│"));
		expect(lines[2]).toContain(theme.fg("timelineRail", "│"));
	});

	test("the lane column follows the lane it was given, on every row", () => {
		expect(shown(question(PROMPT, { lane: "on" }).render(100))).toEqual([
			` 18:47   ●  ┆   你   ${PROMPT}`,
			"         │  ┆",
			"         │  ┆",
		]);
	});

	test("setLane repaints a rendered question with the new lane", () => {
		const component = question();
		expect(shown(component.render(100))[1]).toBe("         │");
		component.setLane("on");
		expect(shown(component.render(100))[1]).toBe("         │  ┆");
		component.setLane("off");
		expect(shown(component.render(100))[1]).toBe("         │");
	});

	test("a multi-line question continues on the main line, content on column 16", () => {
		expect(shown(question("第一行\n第二行\n第三行").render(100))).toEqual([
			" 18:47   ●      你   第一行",
			"         │      第二行",
			"         │      第三行",
			"         │",
			"         │",
		]);
	});

	test("a long question wraps inside the width, its continuation on column 16", () => {
		const text = "查一下为什么这个测试在两百五十六色的终端里会变红并且给出修法".repeat(3);
		const lines = shown(question(text).render(60));
		expect(lines.length).toBeGreaterThan(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		const continuation = lines.slice(1, -2);
		expect(continuation.length).toBeGreaterThan(0);
		for (const line of continuation) {
			expect(line.slice(0, 16)).toBe("         │      ");
			expect(line.slice(16).trim().length).toBeGreaterThan(0);
		}
		const body = lines
			.slice(0, -2)
			.map((line, index) => (index === 0 ? line.slice(20) : line.slice(16)))
			.join("");
		expect(body).toBe(text);
	});

	test("the words are never dropped by the wrap", () => {
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma";
		const rows = shown(question(text).render(50)).slice(0, -2);
		const body = rows.map((line, index) => (index === 0 ? line.slice(20) : line.slice(16))).join(" ");
		expect(body.replace(/\s+/g, " ").trim()).toBe(text);
	});

	test("slash commands keep their highlight", () => {
		const component = new UserMessageComponent("/compact focus", undefined, (name) => name === "compact", SENT_AT, {
			quiet: true,
		});
		const first = component.render(100)[0] ?? "";
		expect(first).toContain(theme.fg("accent", "/compact"));
		expect(shown([first])[0]).toBe(" 18:47   ●      你   /compact focus");
	});

	test("no send time: the time column stays blank", () => {
		const component = new UserMessageComponent(PROMPT, undefined, undefined, undefined, { quiet: true });
		expect(shown(component.render(100))[0]).toBe(`         ●      你   ${PROMPT}`);
	});

	test("unchanged content hands back the same array (the parent's identity cache)", () => {
		const component = question();
		expect(component.render(100)).toBe(component.render(100));
		expect(component.render(100)).not.toBe(component.render(90));
	});

	test("copying the block still gives the question as typed", () => {
		expect(question("hello\nworld").getBlockCopyText()).toBe("hello\nworld");
	});

	test("a terminal too narrow for the timeline falls back to the bubble", () => {
		const lines = question("hello").render(20);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(shown(lines).join("\n")).toContain("you");
		expect(shown(lines).join("\n")).toContain("hello");
	});

	test("without quiet the question keeps the tinted bubble", () => {
		const lines = new UserMessageComponent("hello", undefined, undefined, SENT_AT).render(40);
		expect(lines).toHaveLength(3);
		expect(shown(lines)[0]).toContain("you");
		expect(lines.join("")).not.toContain("你");
	});
});

describe("the summary on the timeline", () => {
	const SUMMARY = [
		"审查完成，四个代理并行、加上我自己的复核，都收口了。",
		"",
		"**一句话结论**",
		"",
		"这批「框长高 + 子代理小块」的代码本身没问题，但 0.11.16 发版时把一个测试弄红了。",
	].join("\n");

	test("two empty main-line rows, `HH:MM ◆ 总结`, an empty answer row, the body on `┃`, one empty main-line row", () => {
		expect(shown(quietAnswer(answer(SUMMARY)).render(100))).toEqual([
			"         │",
			"         │",
			" 19:06   ◆      总结",
			"         ┃",
			"         ┃      审查完成，四个代理并行、加上我自己的复核，都收口了。",
			"         ┃",
			"         ┃      一句话结论",
			"         ┃",
			"         ┃      这批「框长高 + 子代理小块」的代码本身没问题，但 0.11.16 发版时把一个测试弄红了。",
			"         │",
		]);
	});

	test("the header and the bar take the timeline colors; the header word is bold", () => {
		const lines = quietAnswer(answer(SUMMARY)).render(100);
		const header = lines.find((line) => stripAnsi(line).includes("总结")) ?? "";
		expect(header).toContain(theme.fg("timelineTime", " 19:06   "));
		expect(header).toContain(theme.bold(theme.fg("timelineAi", "◆")));
		expect(header).toContain(theme.bold(theme.fg("timelineAi", "总结")));
		const body = lines.find((line) => stripAnsi(line).includes("审查完成")) ?? "";
		expect(body).toContain(theme.fg("timelineAi", "┃"));
	});

	test("Markdown bold stays bold", () => {
		const lines = quietAnswer(answer(SUMMARY)).render(100);
		const heading = lines.find((line) => stripAnsi(line).includes("一句话结论")) ?? "";
		expect(heading).toContain(theme.bold("一句话结论"));
	});

	test("the body starts on column 16 and wraps at the width minus 16", () => {
		const long = "这是一段很长的回答，".repeat(20);
		const rows = shown(quietAnswer(answer(long)).render(60));
		const bodyRows = rows.filter((line) => line.startsWith("         ┃      "));
		expect(bodyRows.length).toBeGreaterThan(2);
		for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		for (const line of bodyRows) expect(visibleWidth(line.slice(16))).toBeLessThanOrEqual(44);
		expect(bodyRows.map((line) => line.slice(16)).join("")).toBe(long);
	});

	test("the lane column follows the lane it was given, on every row", () => {
		const rows = shown(quietAnswer(answer("好了。"), { lane: "on" }).render(100));
		expect(rows).toEqual([
			"         │  ┆",
			"         │  ┆",
			" 19:06   ◆  ┆   总结",
			"         ┃  ┆",
			"         ┃  ┆   好了。",
			"         │  ┆",
		]);
	});

	test("setLane repaints a rendered summary with the new lane", () => {
		const component = quietAnswer(answer("好了。"));
		expect(shown(component.render(100))[4]).toBe("         ┃      好了。");
		component.setLane("on");
		expect(shown(component.render(100))[4]).toBe("         ┃  ┆   好了。");
	});

	test("unchanged content hands back the same array (the parent's identity cache)", () => {
		const component = quietAnswer(answer(SUMMARY));
		expect(component.render(100)).toBe(component.render(100));
	});

	test("while it streams: the two gap rows and the words behind the bar, no header and no empty bar row", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, "思考", { quiet: true });
		component.updateContent(answer("先写一句。"), true);
		expect(shown(component.render(100))).toEqual([
			"         │",
			"         │",
			"         ┃      先写一句。",
			"         │",
		]);
		component.updateContent(answer("先写一句。\n\n再写一句。"), true);
		const rows = shown(component.render(100));
		expect(rows.join("\n")).not.toContain("总结");
		expect(rows).toEqual([
			"         │",
			"         │",
			"         ┃      先写一句。",
			"         ┃",
			"         ┃      再写一句。",
			"         │",
		]);
	});

	test("the header and the empty bar row appear once the message has finished with no tool calls", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, "思考", { quiet: true });
		component.updateContent(answer("先写一句。"), true);
		expect(shown(component.render(100)).join("\n")).not.toContain("总结");
		component.updateContent(answer("先写一句。"), false);
		expect(shown(component.render(100))).toEqual([
			"         │",
			"         │",
			" 19:06   ◆      总结",
			"         ┃",
			"         ┃      先写一句。",
			"         │",
		]);
	});

	test("a streaming summary draws the lane it was given on every row", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, "思考", { quiet: true, lane: "on" });
		component.updateContent(answer("先写一句。"), true);
		expect(shown(component.render(100))).toEqual([
			"         │  ┆",
			"         │  ┆",
			"         ┃  ┆   先写一句。",
			"         │  ┆",
		]);
	});

	test("an aborted answer keeps its `已中断` under the summary", () => {
		const rows = shown(quietAnswer(answer("写到一半", { stopReason: "aborted" })).render(100));
		expect(rows).toContain(" 19:06   ◆      总结");
		expect(rows.join("\n")).toContain("已中断");
	});

	test("a terminal too narrow for the timeline draws the plain answer", () => {
		const lines = quietAnswer(answer("好了，收工。")).render(20);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		const text = shown(lines).join("\n");
		expect(text).toContain("好了，收工。");
		expect(text).not.toContain("┃");
	});

	test("without quiet the answer keeps its old face (no header, no bar)", () => {
		const text = shown(
			new AssistantMessageComponent(answer("好了。"), false, undefined, "思考", {}).render(100),
		).join("\n");
		expect(text).toContain("好了。");
		expect(text).not.toContain("总结");
		expect(text).not.toContain("┃");
	});
});

describe("text of a message that carries tool calls is only the event row's", () => {
	const call = { type: "toolCall" as const, id: "toolu_tl_out", name: "ipython", arguments: { code: "1" } };

	test("the text before the tool call draws nothing here", () => {
		const message = assistant([{ type: "text", text: "先看最近的提交，定下审查范围。" }, call], {
			stopReason: "toolUse",
		});
		expect(quietAnswer(message).render(100)).toEqual([]);
	});

	test("the text after the tool call is not repeated as an answer either", () => {
		const message = assistant(
			[{ type: "text", text: "先查一下。" }, call, { type: "text", text: "结论：目录里有三个文件。" }],
			{ stopReason: "toolUse" },
		);
		expect(quietAnswer(message).render(100)).toEqual([]);
	});

	test("a tool-call message that ended in an error still shows the error", () => {
		const message = assistant([{ type: "text", text: "先查一下。" }, call], { stopReason: "aborted" });
		expect(shown(quietAnswer(message).render(100)).join("\n")).toContain("已中断");
	});

	test("a streaming step that ends in a tool call never shows the summary header", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, "思考", { quiet: true });
		const seen: string[] = [];
		for (const words of ["我", "我先看", "我先看一下"]) {
			component.updateContent(answer(words), true);
			seen.push(...shown(component.render(100)));
		}
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.join("\n")).not.toContain("总结");
		component.updateContent(assistant([{ type: "text", text: "我先看一下" }, call], { stopReason: "toolUse" }), true);
		expect(component.render(100)).toEqual([]);
		component.updateContent(
			assistant([{ type: "text", text: "我先看一下" }, call], { stopReason: "toolUse" }),
			false,
		);
		expect(component.render(100)).toEqual([]);
	});

	test("without quiet the narration keeps its old face", () => {
		const message = assistant([{ type: "text", text: "先看最近的提交。" }, call], { stopReason: "toolUse" });
		const text = shown(new AssistantMessageComponent(message, false, undefined, "思考", {}).render(100)).join("\n");
		expect(text).toContain("先看最近的提交。");
	});
});
