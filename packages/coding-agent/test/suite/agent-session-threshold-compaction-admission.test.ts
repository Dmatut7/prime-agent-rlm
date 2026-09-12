import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const BIG_OUTPUT = "x".repeat(40_000);

describe("threshold compaction continuation under an admission pause", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createAutonomousHarness(onToolRun: () => void): Promise<Harness> {
		const bigTool: AgentTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => {
				onToolRun();
				return { content: [{ type: "text", text: BIG_OUTPUT }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [bigTool],
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
			autonomous: { enabled: true, maxContinuations: 5, continuationPrompt: "keep working" },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("keeps the admission failure out of the agent loop and rolls the continuation back", async () => {
		let pause: { release(): void } | undefined;
		const harness = await createAutonomousHarness(() => {
			// The ACP release path holds a pause while it waits for the agent to go
			// idle, and shouldStopAfterTurn runs before idle: admission is closed at
			// exactly the moment the threshold compaction queues its continuation.
			pause ??= harness.session.acquireSessionInputPause();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed after compaction"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("third turn"),
		]);

		await harness.session.prompt("run the big tool");

		// The turn must not end on the unrelated admission error: it used to escape
		// shouldStopAfterTurn into agent-core and land as an errored assistant turn.
		const errored = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
		);
		expect(errored.map((message) => message.errorMessage)).toEqual([]);
		// The continuation that never got admitted must not stay on the books.
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
		// The threshold compaction itself still runs.
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");

		pause?.release();
		await harness.session.waitForIdle();
	});

	it("control: the same turn queues its continuation when admission is open", async () => {
		const harness = await createAutonomousHarness(() => {});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed after compaction"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("third turn"),
		]);

		await harness.session.prompt("run the big tool");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBeGreaterThan(0);
	});
});
