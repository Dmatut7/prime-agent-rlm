import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildFailureMessage } from "../src/core/messages.js";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "../src/core/provider-fallback.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import { QuietCompactionNoticeComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, outline, replay, screenLines } from "./tl-fd-helpers.js";
import { assistant, T0 } from "./ui-blocks-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * R3-5: there is exactly one replay implementation. The mode's
 * renderSessionContext (attach/resync/rebuild) drives replayConversation in
 * components/conversation-components.ts; buildConversationComponents is the
 * same run into a plain array. These pins keep it that way: the production
 * method must delegate, and the two entry points must draw the same chat for
 * the same transcript - including the row types the old test-only builder used
 * to drop (bashExecution, branchSummary, skill blocks, provider_fallback, the
 * in-turn notice).
 */

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

function mixedTranscript(): AgentMessage[] {
	const toolCall = assistant(T0 + 1_000, [
		{ type: "text", text: "先跑一步。" },
		{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "1" } },
	]);
	const toolResult: AgentMessage = {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: T0 + 2_000,
	};
	return [
		{ role: "user", content: "把这件事做完", timestamp: T0 },
		toolCall,
		toolResult,
		// A failure notice inside the turn's tool loop: a row of the turn, not a new one.
		createRlmChildFailureMessage({ childId: "a-id", sessionName: "A", error: "boom", kind: "error" }, T0 + 3_000),
		assistant(T0 + 4_000, [{ type: "text", text: "继续。" }], "stop"),
		// A provider fallback switch reads the same live and on replay.
		{
			role: "custom",
			customType: PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
			content: "已切到备用模型 openai/gpt-5",
			display: true,
			details: { kind: "switch" },
			timestamp: T0 + 5_000,
		} as AgentMessage,
		// A skill invocation prompt draws the card plus the rest of the words.
		{
			role: "user",
			content: '<skill name="review" location="skills/review.md">\n审查这个改动\n</skill>\n\n顺便跑下测试',
			timestamp: T0 + 6_000,
		},
		assistant(T0 + 7_000, [{ type: "text", text: "审查完了。" }], "stop"),
		// A side bash run and a branch summary keep their own rows.
		{
			role: "bashExecution",
			command: "npm test",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: T0 + 9_000,
		} as AgentMessage,
		{
			role: "branchSummary",
			summary: "另一条分支试了别的做法",
			fromId: "entry-1",
			timestamp: T0 + 10_000,
		} as AgentMessage,
		{ role: "user", content: "继续", timestamp: T0 + 11_000 },
		// A compaction between two turns (no turn open): the one faint line. Its
		// timestamp keeps it there after orderMessagesForTranscript re-pins it.
		{
			role: "compactionSummary",
			summary: "前半段做完了",
			tokensBefore: 10_000,
			timestamp: T0 + 11_500,
		} as AgentMessage,
		assistant(T0 + 12_000, [{ type: "text", text: "做完了。" }], "stop"),
	];
}

describe("the single replay implementation (R3-5)", () => {
	it("renderSessionContext delegates to replayConversation", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/interactive/interactive-mode.ts"), "utf8");
		const body = source.slice(source.indexOf("private async renderSessionContext"));
		expect(body).toContain("replayConversation(");
		// No second message loop beside the engine.
		expect(body).not.toContain("new QuietAssistantMessage(");
		expect(body).not.toContain("new ToolExecutionComponent(");
	});

	it("the mode's replay and the test builder draw the same chat for the same transcript", async () => {
		const messages = mixedTranscript();
		const replayed = await replay(messages);
		const rebuilt = built(messages);
		expect(screenLines(replayed.chatContainer.children)).toEqual(screenLines(rebuilt));
		expect(outline(replayed.chatContainer.children)).toEqual(outline(rebuilt));
	});

	it("every previously-dropped row type survives the replay", async () => {
		const replayed = await replay(mixedTranscript());
		const lines = screenLines(replayed.chatContainer.children).join("\n");
		expect(lines).toContain("已切到备用模型 openai/gpt-5");
		expect(lines).toContain("子代理 A 失败");
		expect(lines).toContain("review");
		expect(lines).toContain("npm test");
		// The branch summary and the compaction notice render collapsed: their cards
		// are on screen, their words behind a click.
		const branchCard = replayed.chatContainer.children.find(
			(c): c is BranchSummaryMessageComponent => c instanceof BranchSummaryMessageComponent,
		);
		expect(branchCard).toBeDefined();
		branchCard!.setExpanded(true);
		expect(branchCard!.render(100).join("\n")).toContain("另一条分支试了别的做法");
		expect(replayed.chatContainer.children.some((c) => c instanceof QuietCompactionNoticeComponent)).toBe(true);
	});
});
