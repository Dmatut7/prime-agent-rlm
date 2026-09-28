import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
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

function host(): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
	};
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

/** The finished box of a turn made of `replies`, as the timeline sees them. */
function finishedBox(replies: AssistantMessage[], options: { errorEnded?: boolean } = {}) {
	const state = new TurnActivityState(T0);
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	for (const reply of replies) state.timeline.noteMessage(reply, true);
	state.timeline.errorEnded = options.errorEnded === true;
	state.markTurnEnded(T0 + 5_000);
	return summary;
}

/** Line 0 is the `◆ prime` line and line 1 the box's top rule. */
const headerOf = (summary: TurnSummaryComponent) => plain(summary.render(120))[2] ?? "";

function replayedSummary(messages: AgentMessage[]): TurnSummaryComponent {
	const components = buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
	const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
	expect(summaries).toHaveLength(1);
	return summaries[0] as TurnSummaryComponent;
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
});

describe("a turn that produced nothing says so instead of claiming an answer", () => {
	it("says the turn had no output for a reply with no text, no step and no thought", () => {
		const header = headerOf(finishedBox([assistant(T0 + 1_000, [], "length")]));
		expect(header).toContain("✓ （这轮没有输出）");
		expect(header).not.toContain("直接回答了");
	});

	it("counts blank text and a blank thought as nothing too", () => {
		const blank = assistant(
			T0 + 1_000,
			[
				{ type: "thinking", thinking: "  " },
				{ type: "text", text: " \n" },
			],
			"length",
		);
		const header = headerOf(finishedBox([blank]));
		expect(header).toContain("（这轮没有输出）");
		expect(header).not.toContain("直接回答了");
	});

	it("says it on a replayed session, whose facts are worked out again from its messages", () => {
		const summary = replayedSummary([
			{ role: "user", content: "在吗", timestamp: T0 },
			assistant(T0 + 1_000, [], "length"),
		]);
		expect(headerOf(summary)).toContain("（这轮没有输出）");
	});
});

describe("a turn that did say something keeps its wording", () => {
	it("still says the turn answered directly for a plain text reply", () => {
		const header = headerOf(
			finishedBox([assistant(T0 + 1_000, [{ type: "text", text: "好的，已经改好了。" }], "stop")]),
		);
		expect(header).toContain("✓ 直接回答了");
		expect(header).not.toContain("这轮没有输出");
	});

	it("still says it on a replayed plain text reply", () => {
		const summary = replayedSummary([
			{ role: "user", content: "在吗", timestamp: T0 },
			assistant(T0 + 1_000, [{ type: "text", text: "在的。" }], "stop"),
		]);
		expect(headerOf(summary)).toContain("✓ 直接回答了");
	});

	it("counts an empty reply followed by a text reply of the same turn as an answer", () => {
		const header = headerOf(
			finishedBox([
				assistant(T0 + 1_000, [], "length"),
				assistant(T0 + 2_000, [{ type: "text", text: "换个说法重答一遍。" }], "stop"),
			]),
		);
		expect(header).toContain("✓ 直接回答了");
	});

	it("counts a text reply followed by an empty reply of the same turn as an answer too", () => {
		const header = headerOf(
			finishedBox([
				assistant(T0 + 1_000, [{ type: "text", text: "先答一句。" }], "stop"),
				assistant(T0 + 2_000, [], "length"),
			]),
		);
		expect(header).toContain("✓ 直接回答了");
		expect(header).not.toContain("这轮没有输出");
	});

	it("keeps counting a thought that has text as a thought", () => {
		const header = headerOf(
			finishedBox([assistant(T0 + 1_000, [{ type: "thinking", thinking: "先想一想。再想一想。" }], "length")]),
		);
		expect(header).toContain("想了 1 次");
		expect(header).not.toContain("这轮没有输出");
		expect(header).not.toContain("直接回答了");
	});

	it("leaves a turn that ended on a model error to its error row", () => {
		const summary = finishedBox([assistant(T0 + 1_000, [], "error", "接口超时")], { errorEnded: true });
		const header = headerOf(summary);
		expect(header).toContain("✗ 1 处出错");
		expect(header).not.toContain("这轮没有输出");
		expect(header).not.toContain("直接回答了");
		setMotionReduced(true);
		summary.toggleBox();
		expect(plain(summary.render(120)).join("\n")).toContain("模型出错：接口超时");
	});
});
