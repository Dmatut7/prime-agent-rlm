import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { consecutiveToolErrorsFromMessages } from "../src/core/session-stats.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { FooterComponent, TOOL_ERROR_WARN_THRESHOLD } from "../src/modes/interactive/components/footer.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { createTestResourceLoader } from "./utilities.js";

function toolResultMessage(isError: boolean, toolCallId = "t") {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text: "out" }],
		isError,
		timestamp: 1,
	};
}

describe("consecutiveToolErrorsFromMessages (U2)", () => {
	it("counts the trailing errored tool results and resets on the first success", () => {
		expect(consecutiveToolErrorsFromMessages([])).toBe(0);
		expect(consecutiveToolErrorsFromMessages([toolResultMessage(true)])).toBe(1);
		expect(
			consecutiveToolErrorsFromMessages([
				toolResultMessage(false),
				toolResultMessage(true),
				toolResultMessage(true),
			]),
		).toBe(2);
		expect(
			consecutiveToolErrorsFromMessages([
				toolResultMessage(true),
				toolResultMessage(true),
				toolResultMessage(false),
			]),
		).toBe(0);
	});

	it("skips non-tool-result messages inside the streak", () => {
		const messages = [
			toolResultMessage(true, "a"),
			{ role: "assistant", content: [], timestamp: 1 },
			toolResultMessage(true, "b"),
		];
		expect(consecutiveToolErrorsFromMessages(messages)).toBe(2);
	});
});

describe("footer tool-error badge (U2)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("hides below the threshold, shows ⚠ 工具错误×N at and above it, and clears on reset", () => {
		const footer = new FooterComponent({ getGitBranch: () => null } as never);
		expect(TOOL_ERROR_WARN_THRESHOLD).toBe(3);

		for (let count = 0; count < TOOL_ERROR_WARN_THRESHOLD; count++) {
			footer.setToolErrorCount(count);
			expect(footer.render(120)).toEqual([]);
		}

		footer.setToolErrorCount(4);
		const line = stripAnsi(footer.render(120).join("\n"));
		expect(line).toContain("⚠ 工具错误×4");

		footer.setToolErrorCount(0);
		expect(footer.render(120)).toEqual([]);
	});

	it("rides on the telemetry line when both are present", () => {
		const footer = new FooterComponent({ getGitBranch: () => null } as never);
		footer.setTelemetrySource(() => ({
			mode: "on",
			snapshot: {
				modelName: "bailian/glm-5.3-prime",
				contextTokens: 10_000,
				contextWindow: 100_000,
				compactionTriggerRatio: 0.8,
			},
		}));
		footer.setToolErrorCount(3);
		const line = stripAnsi(footer.render(120).join("\n"));
		expect(footer.render(120)).toHaveLength(1);
		expect(line).toContain("10k/100k · 10%");
		expect(line).toContain("⚠ 工具错误×3");
	});
});

describe("interactive-mode tool-error streak counting (U2)", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => vi.restoreAllMocks());

	function makeMode() {
		const footer = { setToolErrorCount: vi.fn(), invalidate: vi.fn() };
		const mode = {
			isInitialized: true,
			settingsManager: { getShowTerminalProgress: () => false },
			subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
			subagentSummaryLine: new SubagentSummaryLine(),
			connectionState: { isStreaming: false },
			toolOutputExpanded: false,
			footer,
			activityTracker: new AgentActivityTracker(),
			ui: { requestRender: vi.fn() },
			chatContainer: new Container(),
			recapContainer: new Container(),
			sessionRecap: "Updated files",
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
			pendingTools: new Map([["tool-1", { updateResult: vi.fn() }]]),
			agentRunFileChanges: new Map(),
			startedToolCalls: new Set(["tool-1"]),
			currentTurnState: undefined,
			consecutiveToolErrors: 0,
			updateConnectionStateFromEvent: vi.fn(),
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getOrCreatePendingToolComponent: vi.fn(async () => undefined),
			getRetryAttempt: () => 0,
			getCurrentCwd: () => "/tmp",
			stopWorkingLoader: vi.fn(),
			resetPendingToolState: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			applyOptimisticContextUsage: vi.fn(),
			refreshConnectionContextUsage: vi.fn(async () => {}),
			clearShortcutGuide: vi.fn(),
			addMessageToChat: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return { mode, footer };
	}

	const endEvent = (isError: boolean): AgentConnectionSessionEvent =>
		({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			result: { content: [] },
			isError,
		}) as unknown as AgentConnectionSessionEvent;

	it("increments on errored tool results and resets on a success", async () => {
		const { mode, footer } = makeMode();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: unknown, event: AgentConnectionSessionEvent): Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(mode, endEvent(true));
		await handleEvent.call(mode, endEvent(true));
		expect(mode.consecutiveToolErrors).toBe(2);
		expect(footer.setToolErrorCount).toHaveBeenLastCalledWith(2);
		// Below the threshold the footer still receives the count; the badge hides itself.

		await handleEvent.call(mode, endEvent(true));
		expect(mode.consecutiveToolErrors).toBe(3);

		await handleEvent.call(mode, endEvent(false));
		expect(mode.consecutiveToolErrors).toBe(0);
		expect(footer.setToolErrorCount).toHaveBeenLastCalledWith(0);
	});
});

describe("AgentSession stats carry the streak (U2)", () => {
	it("derives consecutiveToolErrors from the session transcript", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "tool-error-streak-"));
		let session: AgentSession | undefined;
		try {
			mkdirSync(join(tempDir, "sessions"), { recursive: true });
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			const agent = new Agent({
				convertToLlm,
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: "",
					tools: [],
					thinkingLevel: "off",
					messages: [toolResultMessage(true, "a"), toolResultMessage(true, "b"), toolResultMessage(true, "c")],
				},
				streamFn: async () => {
					throw new Error("not used");
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
				settingsManager: SettingsManager.create(tempDir, tempDir),
				cwd: tempDir,
				modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
				resourceLoader: createTestResourceLoader({}),
			});
			const stats = session.getSessionStats();
			expect(stats.consecutiveToolErrors).toBe(3);
		} finally {
			session?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
