import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

import { createHarness, type Harness } from "./harness.js";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Compaction and branch summarization run with their own prompt shapes, so issuing
 * them on the session model evicts the provider's prefix-cache entry for the session
 * and forces a full context re-read on the next session request - at the context peak,
 * no less. Both paths must route to the configured auxiliary model, like refinement
 * already does (upstream #2411).
 */
describe("AgentSession compaction auxiliary model", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(assistantText("aux-generated summary"));
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createCompactionHarness(settings?: { auxiliaryModel?: string }): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "session-model", name: "Session Model" },
				{ id: "aux-model", name: "Aux Model" },
			],
			settings: {
				auxiliaryModel: settings?.auxiliaryModel,
				compaction: { keepRecentTokens: 1 },
			},
			persistSession: true,
		});
		harnesses.push(harness);
		return harness;
	}

	async function promptTwoTurns(harness: Harness): Promise<void> {
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
	}

	it("routes the compaction summarizer to the configured auxiliary model", async () => {
		const harness = await createCompactionHarness({ auxiliaryModel: "faux/aux-model" });
		await promptTwoTurns(harness);

		const result = await harness.session.compact();

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			provider: "faux",
			id: "aux-model",
		});
		expect(result.summary).toContain("aux-generated summary");
	});

	it("falls back to the session model when no auxiliary model is configured", async () => {
		const harness = await createCompactionHarness();
		await promptTwoTurns(harness);

		await harness.session.compact();

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			provider: "faux",
			id: "session-model",
		});
	});

	it("routes branch summarization to the configured auxiliary model", async () => {
		const harness = await createCompactionHarness({ auxiliaryModel: "faux/aux-model" });
		await promptTwoTurns(harness);

		const branch = harness.sessionManager.getBranch();
		const userEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntries.length).toBe(2);
		// Navigating to a user message branches to its parent, abandoning the turn
		// it opened; that abandoned turn is what the branch summary summarizes.
		const result = await harness.session.navigateTree(userEntries[1]!.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			provider: "faux",
			id: "aux-model",
		});
		expect(result.summaryEntry?.summary).toContain("aux-generated summary");
	});
});
