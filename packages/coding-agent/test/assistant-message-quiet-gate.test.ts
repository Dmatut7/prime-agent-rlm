import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * TUI v4 batch 1 / T2a': the quiet-conversation gate inside
 * AssistantMessageComponent. One gate covers the live stream, the replay,
 * and the test builder: an assistant message that carries tool calls is
 * intermediate narration and folds in quiet mode; the turn's final output
 * (no tool calls) always renders in full; legacy keeps the old face.
 */
describe("assistant message quiet gate", () => {
	const EMPTY_USAGE: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};

	function narration(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "text", text: "我先列出 /tmp 下按修改时间排序的前几个文件，再据此下结论。" },
				{
					type: "toolCall",
					id: "toolu_quiet-gate-1",
					name: "ipython",
					arguments: { code: "print('ls /tmp')" },
				},
			],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function conclusion(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "结论：/tmp 下最近修改的 3 个文件是 research_r1、p2_search 和 go_server_local.log。",
				},
			],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function render(component: AssistantMessageComponent): string {
		return stripAnsi(component.render(100).join("\n"));
	}

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("quiet folds only the pre-tool preamble; text after the tool call stays visible (P1-1)", () => {
		// One message that talks before AND after the tool call: the preamble
		// folds, the closing narrative (the same message's conclusion) renders.
		const message = narration();
		message.content = [
			{ type: "text", text: "先查一下。" },
			{
				type: "toolCall",
				id: "toolu_quiet-gate-preamble",
				name: "ipython",
				arguments: { code: "print('ls /tmp')" },
			},
			{ type: "text", text: "结论：目录里有三个文件，可以收工。" },
		];
		const component = new AssistantMessageComponent(message, false, undefined, "思考", { quiet: true });
		const rendered = render(component);
		expect(rendered).not.toContain("先查一下。");
		expect(rendered).toContain("结论：目录里有三个文件，可以收工。");
	});

	test("quiet folds intermediate narration (text + tool call) to zero lines", () => {
		const component = new AssistantMessageComponent(narration(), false, undefined, "思考", { quiet: true });
		expect(render(component)).toBe("");
	});

	test("quiet keeps the turn's final output (no tool calls) in full", () => {
		const component = new AssistantMessageComponent(conclusion(), false, undefined, "思考", { quiet: true });
		expect(render(component)).toContain("结论：/tmp 下最近修改的 3 个文件");
	});

	test("legacy renders intermediate narration in full (the old face)", () => {
		const component = new AssistantMessageComponent(narration(), false, undefined, "思考", { quiet: false });
		expect(render(component)).toContain("我先列出 /tmp 下按修改时间排序的前几个文件");
	});

	test("quiet never folds an aborted message's error surface", () => {
		const message = narration();
		message.stopReason = "aborted";
		const component = new AssistantMessageComponent(message, false, undefined, "思考", { quiet: true });
		expect(render(component)).toContain("已中断");
	});

	test("a streaming message folds once a tool call arrives", () => {
		// Start streaming text with no tool calls yet: the preamble shows.
		const message = narration();
		message.content = [{ type: "text", text: "我先列出 /tmp 下按修改时间排序的前几个文件，再据此下结论。" }];
		const component = new AssistantMessageComponent(undefined, false, undefined, "思考", { quiet: true });
		component.updateContent(message, true);
		expect(render(component)).toContain("我先列出 /tmp 下按修改时间排序");

		// The tool call streams in: the same message is now intermediate
		// narration and must fold without a new component.
		const streamed = narration();
		component.updateContent(streamed, true);
		expect(render(component)).toBe("");
	});

	test("buildConversationComponents passes the gate through (quiet vs legacy)", () => {
		const options = {
			ui: { requestRender: () => {} } as never,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		};
		const messages = [narration(), conclusion()];

		const quiet = buildConversationComponents(messages, { ...options, processMode: "quiet" });
		const legacy = buildConversationComponents(messages, { ...options, processMode: "legacy" });

		const quietText = quiet.map((c) => stripAnsi(c.render(100).join("\n")).trim());
		const legacyText = legacy.map((c) => stripAnsi(c.render(100).join("\n")).trim());

		expect(quietText.join("\n")).not.toContain("我先列出 /tmp 下按修改时间排序");
		expect(legacyText.join("\n")).toContain("我先列出 /tmp 下按修改时间排序");
	});
});
