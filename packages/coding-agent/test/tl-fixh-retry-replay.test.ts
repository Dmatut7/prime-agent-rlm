import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, replay, screenLines } from "./tl-fd-helpers.js";
import { assistant, T0 } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/** A retry the session made reads the same in the live box and in a replay of the transcript. */

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
	timelineShowAll.set(false);
});

const ASK = "对最近的改动做全面的审查";
const ERR = "upstream connect error or disconnect/reset before headers 503";
const DONE = "审查做完了。";

function failed(at: number, model: string): AssistantMessage {
	return { ...assistant(at, [{ type: "text", text: "" }], "error", model), errorMessage: ERR };
}

function transcript(retriedOn: string): AgentMessage[] {
	return [
		{ role: "user", content: ASK, timestamp: T0 },
		failed(T0 + 1_000, "glm-5.3-prime"),
		assistant(T0 + 4_000, [{ type: "text", text: DONE }], "stop", retriedOn),
	];
}

function retryLine(lines: readonly string[]): string {
	const line = lines.find((row) => row.includes("已自动重试"));
	expect(line, "a retry row").toBeDefined();
	return line ?? "";
}

/** Every turn's events opened, then the chat's lines. */
function opened(children: readonly Component[]): string[] {
	for (const child of children) {
		if (!(child instanceof TurnSummaryComponent)) continue;
		child.render(120);
		for (const key of child.getFocusOrder()) if (key.startsWith("ev:")) child.activate(key);
	}
	return screenLines(children, 120);
}

describe("a retry that moved to a backup model", () => {
	it("names the backup model in the replay as it does live", async () => {
		const chat = new LiveChat();
		chat.user(ASK);
		const bad = failed(T0 + 1_000, "glm-5.3-prime");
		chat.flow.assistantStart(bad);
		chat.flow.assistantEnd(bad);
		chat.flow.retryStart({
			delayMs: 0,
			attempt: 1,
			errorMessage: ERR,
			reason: "backup",
			backupModel: "test-provider/glm-5.3",
		});
		chat.flow.retryEnd({ success: true });
		chat.say(T0 + 4_000, { words: DONE });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		const live = retryLine(opened(chat.chat.children));
		expect(live).toContain("换到备用模型 glm-5.3，已自动重试");

		const messages = transcript("glm-5.3");
		const replayed = await replay(messages);
		expect(retryLine(opened(replayed.chatContainer.children))).toBe(live);
		expect(retryLine(opened(built(messages)))).toBe(live);
		chat.flow.dispose();
	});
});

describe("a retry on the same model", () => {
	it("says what the error says, as before", async () => {
		const messages = transcript("glm-5.3-prime");
		const replayed = await replay(messages);
		expect(retryLine(opened(replayed.chatContainer.children))).toContain("模型服务繁忙，已自动重试");
		expect(retryLine(opened(built(messages)))).toContain("模型服务繁忙，已自动重试");
	});

	it("still replays a transcript whose messages carry no model at all", async () => {
		const bare = transcript("glm-5.3-prime").map((message) =>
			message.role === "assistant" ? { ...message, model: "", provider: "" } : message,
		);
		const replayed = await replay(bare);
		expect(retryLine(opened(replayed.chatContainer.children))).toContain("已自动重试");
	});
});
