import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type ConversationReplayTarget,
	replayConversation,
} from "../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { plain } from "./ui-blocks-helpers.js";

/**
 * R5-M19: a reply that died (the owner's Escape, an error) leaves its calls unsettled, so the
 * replay made a result up for each of them - `已中断` - and never put them in `pendingTools`. When
 * the transcript went on to carry the call's *real* result (the tool had settled before the stop
 * landed; the live view keeps that output) the replay had nowhere to pair it: the made-up row
 * stood, the real result was filed as an orphan, and an edit's diff went with it.
 */

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(timestamp: number, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: USAGE,
		stopReason,
		timestamp,
	} satisfies AssistantMessage;
}

function result(toolCallId: string, toolName: string, details: unknown, text: string, timestamp: number) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp,
	} satisfies ToolResultMessage;
}

function replay(messages: readonly AgentMessage[], quiet = false) {
	const children: unknown[] = [];
	const target: ConversationReplayTarget = {
		children: children as ConversationReplayTarget["children"],
		addChild: (component) => {
			children.push(component);
		},
		removeChild: (component) => {
			const index = children.indexOf(component);
			if (index >= 0) children.splice(index, 1);
		},
	};
	const outcome = replayConversation(messages, target, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		...(quiet ? { processMode: "quiet" as const } : {}),
	});
	const tools = children.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent);
	const summaries = children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
	return { ...outcome, tools, summaries };
}

/** The tool's own rows once opened, and what `y` copies from it. */
function opened(tool: ToolExecutionComponent): string[] {
	tool.setExpanded(true);
	return plain(tool.render(120));
}

const CALL = [
	{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('npm run check')" } },
] as const;

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("a replayed turn whose reply was cut off", () => {
	it("shows the step's real result when the transcript kept one", () => {
		const run = replay([
			{ role: "user", content: "跑个检查", timestamp: 1_000 },
			reply(1_100, [...CALL], "aborted"),
			result("c1", "ipython", { stdout: "全部通过\nEXIT=0" }, "EXIT=0", 1_200),
		]);
		expect(run.tools).toHaveLength(1);
		const shown = opened(run.tools[0]!);
		expect(shown.join("\n")).toContain("全部通过");
		expect(shown.join("\n")).toContain("EXIT=0");
		expect(shown.join("\n")).not.toContain("已中断");
		expect(run.tools[0]!.getBlockCopyText()).toBe("全部通过\nEXIT=0");
		// The real result is paired, so nothing is left for a backfill page to re-pair.
		expect([...run.orphanToolResults.keys()]).toEqual([]);
		expect([...run.pendingTools.keys()]).toEqual([]);
	});

	it("keeps an edit's diff, which the made-up result had no room for", () => {
		const diff = "--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,2 @@\n-old()\n+new()\n keep()\n";
		const run = replay([
			{ role: "user", content: "改一下", timestamp: 1_000 },
			reply(1_100, [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "/work/app/a.go" } }], "aborted"),
			result("e1", "edit", { diff, success: true }, "已写入 a.go", 1_200),
		]);
		expect(run.tools).toHaveLength(1);
		const tool = run.tools[0]!;
		const shown = opened(tool);
		// The change the edit really made, which a made-up `已中断` has no room for.
		expect(shown.join("\n")).toContain("a.go +2 −2");
		expect(shown.join("\n")).not.toContain("已中断");
		tool.setEditDiffsExpanded(true);
		const diffRows = plain(tool.render(120)).join("\n");
		expect(diffRows).toContain("old()");
		expect(diffRows).toContain("new()");
		expect([...run.orphanToolResults.keys()]).toEqual([]);
	});

	it("still says 已中断 for a call the transcript has no result for", () => {
		const run = replay([{ role: "user", content: "跑个检查", timestamp: 1_000 }, reply(1_100, [...CALL], "aborted")]);
		expect(run.tools).toHaveLength(1);
		const shown = opened(run.tools[0]!);
		expect(shown.join("\n")).toContain("已中断");
		expect(run.tools[0]!.getBlockCopyText()).toBe("已中断");
	});

	it("reads the same on the quiet face: the box's step keeps the real output", () => {
		const run = replay(
			[
				{ role: "user", content: "跑个检查", timestamp: 1_000 },
				reply(1_100, [...CALL], "aborted"),
				result("c1", "ipython", { stdout: "全部通过\nEXIT=0" }, "EXIT=0", 1_200),
			],
			true,
		);
		expect(run.summaries).toHaveLength(1);
		const step = run.summaries[0]!.state.timeline.stepData.get("c1");
		expect(step?.outputText).toContain("全部通过");
		expect(step?.error).toBeUndefined();
		expect(stripAnsi(run.summaries[0]!.render(120).join("\n"))).not.toContain("已中断");
	});
});
