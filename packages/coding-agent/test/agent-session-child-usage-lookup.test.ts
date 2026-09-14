import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

/**
 * Regression: attributing a child's usage must not rescan the parent transcript per child message.
 *
 * The parent resolves the assistant entry that child usage is attributed to by scanning the whole
 * transcript (`SessionManager.getEntries()` copies and filters every entry the session has written).
 * That lookup used to run once per child assistant message even though its input — the parent's
 * current assistant message — is a run-level constant. A child that emitted N assistant messages
 * therefore paid N full-transcript scans, which for long sessions is minutes of blocking work.
 *
 * The test is behavioural: it counts calls to the public `SessionManager.getEntries` entry point
 * while a child runs, and asserts the count does not grow with the number of child assistant
 * messages. It deliberately does not reach into the private lookup helper.
 */

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * A child stream that answers with one assistant message per tool-loop turn: `toolTurns` turns that
 * request the `echo` tool, then a final answer. The child therefore ends with `toolTurns + 1`
 * assistant messages, each of which the parent attributes child usage to.
 */
function toolLoopStream(toolTurns: () => number): StreamFn {
	return (_model, context) => {
		const budget = toolTurns();
		const assistantTurns = context.messages.filter((message) => message.role === "assistant").length;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const wantsTool = assistantTurns < budget;
			const stopReason = wantsTool ? ("toolUse" as const) : ("stop" as const);
			const message = wantsTool
				? {
						...assistantMessage("", usage(1, 1)),
						content: [
							{
								type: "toolCall" as const,
								id: `echo-${assistantTurns}`,
								name: "echo",
								arguments: { value: `turn ${assistantTurns}` },
							},
						],
						stopReason,
					}
				: assistantMessage("done", usage(2, 2));
			stream.push({ type: "done", reason: stopReason, message });
		});
		return stream;
	};
}

describe("AgentSession child usage attribution cost", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-usage-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function createSession(streamFn: StreamFn): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const tool = {
			name: "echo",
			description: "Echo a value",
			label: "echo",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId: string, params: { value: string }) => ({
				content: [{ type: "text" as const, text: params.value }],
				details: {},
			}),
		};
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({}),
			customTools: [tool],
		});
		return session;
	}

	/**
	 * Runs one child task that emits `toolTurns + 1` assistant messages and reports how many times
	 * the parent session manager produced a full transcript snapshot while it ran.
	 */
	async function runChildAndCountTranscriptSnapshots(
		root: AgentSession,
	): Promise<{ snapshots: number; attributed: number }> {
		const countAttributions = () =>
			root.sessionManager.getEntries().filter((entry) => entry.type === "child_usage_attributed").length;
		const attributedBefore = countAttributions();
		const snapshotSpy = vi.spyOn(root.sessionManager, "getEntries");
		const statuses: string[] = [];
		const unsubscribe = root.subscribe((event) => {
			if (event.type === "rlm_child_update") statuses.push(event.child.status);
		});
		try {
			await root.runRlmChild("use a tool");
			await vi.waitFor(() => expect(statuses).toContain("done"), { timeout: 20000 });
			const snapshots = snapshotSpy.mock.calls.length;
			return { snapshots, attributed: countAttributions() - attributedBefore };
		} finally {
			unsubscribe();
			snapshotSpy.mockRestore();
		}
	}

	it("does not rescan the parent transcript for every child assistant message", async () => {
		let toolTurns = 1;
		const root = createSession(toolLoopStream(() => toolTurns));
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);

		const small = await runChildAndCountTranscriptSnapshots(root);
		toolTurns = 7;
		const large = await runChildAndCountTranscriptSnapshots(root);

		// The two phases really do differ: 2 vs 8 attributions, i.e. 6 extra child assistant
		// messages flowed through the same attribution path.
		expect(small.attributed).toBe(2);
		expect(large.attributed).toBe(8);

		// The regression: six extra child messages must not buy six extra full-transcript scans.
		expect(large.snapshots - small.snapshots).toBeLessThanOrEqual(1);
		// And the absolute shape: a run with N attributed child messages must not spend N scans.
		expect(large.snapshots).toBeLessThan(large.attributed);
	});

	it("still attributes every child assistant message to the parent entry", async () => {
		const root = createSession(toolLoopStream(() => 3));
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);

		const { attributed } = await runChildAndCountTranscriptSnapshots(root);

		expect(attributed).toBe(4);
		const entries = root.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "child_usage_attributed").map((entry) => entry.origin)).toEqual([
			"spawn_task",
			"spawn_task",
			"spawn_task",
			"spawn_task",
		]);
		const parentEntry = entries.find((entry) => entry.type === "message" && entry.message === parentAssistant);
		if (!parentEntry || parentEntry.type !== "message" || parentEntry.message.role !== "assistant") {
			throw new Error("parent assistant entry was not recorded");
		}
		// 3 tool turns at usage(1, 1) plus the final answer at usage(2, 2).
		expect(parentEntry.message.usage.cost.total).toBe(3 * 2 + 4);
	});
});
