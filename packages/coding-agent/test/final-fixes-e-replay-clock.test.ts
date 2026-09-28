import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const T0 = 1_700_000_000_000;

function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
		...(errorMessage ? { errorMessage } : {}),
	};
}

function toolResult(id: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

/** The box header line of the one turn a replay of `messages` builds. */
function replayedHeader(messages: AgentMessage[]): string {
	const components = buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
	const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
	expect(summaries).toHaveLength(1);
	// Line 0 is the `◆ prime` line and line 1 the box's top rule.
	return plain((summaries[0] as TurnSummaryComponent).render(120))[2] ?? "";
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
});

describe("a replayed turn that ended on an interrupt or an error keeps its own clock", () => {
	// The turn's first reply is at T0+1s and the cut-off one at T0+5s: four seconds, years before now.
	const cutOff = (stopReason: "aborted" | "error", errorMessage?: string): AgentMessage[] => [
		{ role: "user", content: "跑一下测试", timestamp: T0 },
		assistant(
			T0 + 1_000,
			[{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } }],
			"toolUse",
		),
		toolResult("c1", T0 + 3_000),
		assistant(
			T0 + 5_000,
			[{ type: "toolCall", id: "c2", name: "ipython", arguments: { code: "print(2)" } }],
			stopReason,
			errorMessage,
		),
	];

	it("reads four seconds for a turn the owner interrupted, not the hours since its messages", () => {
		const header = replayedHeader(cutOff("aborted"));
		expect(header).toContain("已停止");
		expect(header).toContain("4秒");
		expect(header).not.toMatch(/小时/);
	});

	it("reads four seconds for a turn that ended on a model error too", () => {
		const header = replayedHeader(cutOff("error", "model gave up"));
		expect(header).toContain("✗");
		expect(header).toContain("4秒");
		expect(header).not.toMatch(/小时/);
	});
});
