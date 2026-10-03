import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
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

let agentDir: string;
let savedAgentDir: string | undefined;

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	// The replay derivation reads the current retry settings from disk: pin them to
	// an empty directory so the machine's own settings never steer the text.
	savedAgentDir = process.env[ENV_AGENT_DIR];
	agentDir = mkdtempSync(join(tmpdir(), "tl-retry-replay-"));
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
	timelineShowAll.set(false);
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
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

/** Every retry row the chat draws, in order. */
function retryLines(lines: readonly string[]): string[] {
	const found = lines.filter((row) => row.includes("已自动重试"));
	expect(found.length, "retry rows").toBeGreaterThan(0);
	return found;
}

/** The structured failure the transcript persists with a failed message (recordStreamFailure). */
function streamFailure(details: Record<string, unknown>, at: number): AssistantMessage["diagnostics"] {
	return [{ type: "provider_stream_failure", timestamp: at, details }];
}

const QUOTA_ERR = "Provider rate limit exceeded (rate_limit_error, 429): slow down";
const SERVER_ERR = "Provider server error (api_error, 503): upstream connect error";

function quotaFailure(at: number, model: string): AssistantMessage {
	return {
		...assistant(at, [{ type: "text", text: "" }], "error", model),
		errorMessage: QUOTA_ERR,
		diagnostics: streamFailure({ kind: "rate_limit", status: 429 }, at),
	};
}

function serverFailure(at: number, model: string, retryAfterMs?: number): AssistantMessage {
	return {
		...assistant(at, [{ type: "text", text: "" }], "error", model),
		errorMessage: SERVER_ERR,
		diagnostics: streamFailure(
			{ kind: "server_error", status: 503, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
			at,
		),
	};
}

/** The same turn once live (the flow's own events) and once as its transcript. */
function liveAndReplay(failures: AssistantMessage[], retries: Array<Parameters<LiveChat["flow"]["retryStart"]>[0]>) {
	const chat = new LiveChat();
	chat.user(ASK);
	failures.forEach((bad, index) => {
		chat.flow.assistantStart(bad);
		chat.flow.assistantEnd(bad);
		const event = retries[index];
		if (event === undefined) throw new Error("every failure needs its retry event");
		chat.flow.retryStart(event);
		chat.flow.retryEnd({ success: true });
	});
	chat.say(T0 + 40_000, { words: DONE });
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	const messages: AgentMessage[] = [
		{ role: "user", content: ASK, timestamp: T0 },
		...failures,
		assistant(T0 + 40_000, [{ type: "text", text: DONE }], "stop", "glm-5.3-prime"),
	];
	return { chat, messages };
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

/** The same, with every event's full step list (a fourth retry hides behind `另外 N 步`). */
function openedFully(children: readonly Component[]): string[] {
	for (const child of children) {
		if (!(child instanceof TurnSummaryComponent)) continue;
		child.render(120);
		for (const key of child.getFocusOrder()) if (key.startsWith("ev:")) child.activate(key);
		// The `全部 ›` targets exist only once their event is open: a second pass.
		child.render(120);
		for (const key of child.getFocusOrder()) if (key.startsWith("all:")) child.activate(key);
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

describe("a quota failure retried on the same model (the usage wait)", () => {
	it("says 额度用完或被限流 in the replay as it does live", async () => {
		const bad = quotaFailure(T0 + 1_000, "glm-5.3-prime");
		const { chat, messages } = liveAndReplay(
			[bad],
			[{ delayMs: 30_000, attempt: 1, errorMessage: QUOTA_ERR, reason: "usage" }],
		);
		const live = retryLines(openedFully(chat.chat.children));
		expect(live[0]).toContain("额度用完或被限流，已自动重试");

		const replayed = await replay(messages);
		expect(retryLines(openedFully(replayed.chatContainer.children))).toEqual(live);
		expect(retryLines(openedFully(built(messages)))).toEqual(live);
		chat.flow.dispose();
	});
});

describe("a transient failure that outlasts the quick retries (the unavailability wait)", () => {
	it("turns to 模型暂时都不可用 on the same failure live and in the replay", async () => {
		const failures = [1, 2, 3, 4].map((n) => serverFailure(T0 + n * 1_000, "glm-5.3-prime"));
		const { chat, messages } = liveAndReplay(
			failures,
			failures.map((_, index) => ({
				delayMs: 2_000,
				attempt: index + 1,
				errorMessage: SERVER_ERR,
				// The quick ladder is three long (the default): the fourth failure waits.
				...(index === 3 ? { reason: "unavailable" as const } : {}),
			})),
		);
		const live = retryLines(openedFully(chat.chat.children));
		expect(live).toHaveLength(4);
		expect(live[0]).toContain("模型服务繁忙，已自动重试");
		expect(live[3]).toContain("模型暂时都不可用，已自动重试");

		const replayed = await replay(messages);
		expect(retryLines(openedFully(replayed.chatContainer.children))).toEqual(live);
		expect(retryLines(openedFully(built(messages)))).toEqual(live);
		chat.flow.dispose();
	});

	it("says 模型暂时都不可用 at once when the server-requested wait outgrows the cap", async () => {
		// retry.provider.maxRetryDelayMs defaults to 60s; the provider asked for 5m.
		const bad = serverFailure(T0 + 1_000, "glm-5.3-prime", 300_000);
		const { chat, messages } = liveAndReplay(
			[bad],
			[{ delayMs: 300_000, attempt: 1, errorMessage: SERVER_ERR, reason: "unavailable" }],
		);
		const live = retryLines(openedFully(chat.chat.children));
		expect(live[0]).toContain("模型暂时都不可用，已自动重试");

		const replayed = await replay(messages);
		expect(retryLines(openedFully(replayed.chatContainer.children))).toEqual(live);
		expect(retryLines(openedFully(built(messages)))).toEqual(live);
		chat.flow.dispose();
	});
});

describe("the settings the replay derives with", () => {
	it("honors a shorter retry.provider.maxRetries from the current settings", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { provider: { maxRetries: 1 } } }));
		const failures = [1, 2].map((n) => serverFailure(T0 + n * 1_000, "glm-5.3-prime"));
		const { chat, messages } = liveAndReplay(
			failures,
			failures.map((_, index) => ({
				delayMs: 2_000,
				attempt: index + 1,
				errorMessage: SERVER_ERR,
				...(index === 1 ? { reason: "unavailable" as const } : {}),
			})),
		);
		const live = retryLines(openedFully(chat.chat.children));
		expect(live).toHaveLength(2);
		expect(live[0]).toContain("模型服务繁忙，已自动重试");
		expect(live[1]).toContain("模型暂时都不可用，已自动重试");

		const replayed = await replay(messages);
		expect(retryLines(openedFully(replayed.chatContainer.children))).toEqual(live);
		expect(retryLines(openedFully(built(messages)))).toEqual(live);
		chat.flow.dispose();
	});

	it("keeps the error-text reason for a quota failure when the usage wait is off", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { provider: { waitForUsage: { enabled: false } } } }),
		);
		const bad = quotaFailure(T0 + 1_000, "glm-5.3-prime");
		const { chat, messages } = liveAndReplay([bad], [{ delayMs: 2_000, attempt: 1, errorMessage: QUOTA_ERR }]);
		const live = retryLines(openedFully(chat.chat.children));
		expect(live[0]).toContain("被限流，已自动重试");

		const replayed = await replay(messages);
		expect(retryLines(openedFully(replayed.chatContainer.children))).toEqual(live);
		expect(retryLines(openedFully(built(messages)))).toEqual(live);
		chat.flow.dispose();
	});
});

describe("the retry policy source", () => {
	const retriedQuotaTranscript = (): AgentMessage[] => [
		{ role: "user", content: ASK, timestamp: T0 },
		quotaFailure(T0 + 1_000, "glm-5.3-prime"),
		assistant(T0 + 4_000, [{ type: "text", text: DONE }], "stop", "glm-5.3-prime"),
	];

	it("reads the policy from the timeline host when it provides one, never touching the settings files", () => {
		const spy = vi.spyOn(SettingsManager, "create");
		const children = built(retriedQuotaTranscript());
		const summary = children.find((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
		expect(summary).toBeDefined();
		summary?.setTimelineHost({
			cwd: () => "/work/app",
			viewportRows: () => 40,
			openWhileWorking: () => true,
			autoFold: () => true,
			requestRender: () => {},
			// The wait channel is off here and on in the (empty) settings on disk: the
			// row proves whose policy was read.
			retryPolicy: () => ({ maxRetries: 3, maxRetryDelayMs: 60_000, waitForRecovery: false }),
		});
		spy.mockClear();

		expect(retryLine(opened(children))).toContain("被限流，已自动重试");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("falls back to the settings on disk when the host has no policy", () => {
		const spy = vi.spyOn(SettingsManager, "create");

		expect(retryLine(opened(built(retriedQuotaTranscript())))).toContain("额度用完或被限流，已自动重试");
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
