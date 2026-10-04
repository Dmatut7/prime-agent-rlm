import { type AssistantMessage, fauxAssistantMessage, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * The compaction trigger must size the session against the model the session is
 * currently on, and a mid-session model switch must rebind that window at once
 * (CC 2.1.285 set_model rebind). 90k tokens sit between the two triggers below:
 * under 0.8 * 1M on the wide model, over 0.8 * 100k on the narrow one, so the
 * same context is quiet on one and over threshold on the other.
 */
const WIDE_WINDOW = 1_000_000;
const NARROW_WINDOW = 100_000;
const SEEDED_TOKENS = 90_000;

function seededUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seededAssistant(totalTokens = SEEDED_TOKENS): AssistantMessage {
	return {
		...fauxAssistantMessage("seeded reply"),
		usage: seededUsage(totalTokens),
	};
}

describe("compaction window follows the session model", () => {
	let harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses) harness.cleanup();
		harnesses = [];
	});

	async function createWindowHarness(): Promise<Harness> {
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100, triggerRatio: 0.8 },
			},
			models: [
				{ id: "faux-wide", contextWindow: WIDE_WINDOW, maxTokens: 1000 },
				{ id: "faux-narrow", contextWindow: NARROW_WINDOW, maxTokens: 1000 },
			],
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

	/**
	 * A 90k-token transcript, in both the live context and the persisted branch.
	 * The filler rounds give the compaction something to summarize: without them the
	 * 100-token kept tail covers the whole branch and the run skips instead.
	 */
	function seedContext(harness: Harness, totalTokens = SEEDED_TOKENS): void {
		const seeded: (UserMessage | AssistantMessage)[] = [];
		for (let round = 0; round < 4; round++) {
			seeded.push({
				role: "user",
				content: [{ type: "text", text: `round ${round} ${"q".repeat(2000)}` }],
				timestamp: Date.now() - 10_000 + round * 2,
			});
			seeded.push({
				...fauxAssistantMessage(`round ${round} ${"a".repeat(2000)}`),
				timestamp: Date.now() - 10_000 + round * 2 + 1,
			});
		}
		const user = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "seed" }],
			timestamp: Date.now() - 1000,
		};
		const assistant = seededAssistant(totalTokens);
		for (const message of [...seeded, user, assistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [...seeded, user, assistant];
	}

	it("sizes the reported context usage against the current model's window", async () => {
		const harness = await createWindowHarness();
		seedContext(harness);
		expect(harness.session.getContextUsage()?.contextWindow).toBe(WIDE_WINDOW);

		const narrow = harness.getModel("faux-narrow");
		expect(narrow).toBeDefined();
		await harness.session.setModel(narrow!);

		expect(harness.session.getContextUsage()?.contextWindow).toBe(NARROW_WINDOW);
	});

	it("a mid-session switch to a smaller-window model triggers threshold compaction on the next turn", async () => {
		const harness = await createWindowHarness();
		seedContext(harness);
		harness.setResponses([fauxAssistantMessage("answer after compaction")]);

		const narrow = harness.getModel("faux-narrow");
		expect(narrow).toBeDefined();
		await harness.session.setModel(narrow!);

		await harness.session.prompt("next question");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
	});

	it("a mid-session switch to a larger-window model lifts the threshold (no compaction)", async () => {
		const harness = await createWindowHarness();
		seedContext(harness);
		harness.setResponses([fauxAssistantMessage("plain answer")]);

		const narrow = harness.getModel("faux-narrow");
		const wide = harness.getModel("faux-wide");
		expect(narrow).toBeDefined();
		expect(wide).toBeDefined();
		// The same 90k context is over the narrow model's trigger...
		await harness.session.setModel(narrow!);
		// ...and under the wide one's after the switch back.
		await harness.session.setModel(wide!);

		await harness.session.prompt("next question");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});

	it("a per-model off entry suppresses the trigger while the bare enabled switch stays on", async () => {
		const harness = await createWindowHarness();
		seedContext(harness);
		const narrow = harness.getModel("faux-narrow");
		await harness.session.setModel(narrow!);
		// Over the narrow model's trigger, but this model's own entry says off.
		harness.session.settingsManager.setCompactionEnabledForModel("faux/faux-narrow", false);
		harness.setResponses([fauxAssistantMessage("plain answer")]);

		await harness.session.prompt("next question");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start")).toEqual([]);

		// Flipping the entry back on re-arms the trigger on the next turn.
		harness.session.settingsManager.setCompactionEnabledForModel("faux/faux-narrow", true);
		// Turn 1's small reply moved the usage anchor; re-seed so the next
		// admission reads an over-threshold context again.
		seedContext(harness);
		harness.setResponses([seededAssistant()]);
		await harness.session.prompt("again");
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
	});

	it("follows the registry when the provider re-reports a smaller window mid-session", async () => {
		const harness = await createWindowHarness();
		seedContext(harness);
		harness.setResponses([fauxAssistantMessage("answer after compaction")]);

		// The gateway re-reports the serving model with a capped window (a live
		// catalog landing after startup, a models.json edit + reload): the registry
		// entry now says 100k while the session's captured model object still says
		// 1M, and 90k only trips the registry's trigger (0.8 * 100k = 80k).
		const wide = harness.getModel("faux-wide");
		expect(wide).toBeDefined();
		harness.modelRegistry.registerProvider(wide!.provider, {
			baseUrl: wide!.baseUrl,
			apiKey: "faux-key",
			api: harness.faux.api,
			models: [
				{
					id: "faux-wide",
					name: wide!.name,
					api: wide!.api,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: NARROW_WINDOW,
					maxTokens: 1000,
				},
			],
		});
		expect(harness.session.model?.contextWindow).toBe(WIDE_WINDOW);
		expect(harness.session.getContextUsage()?.contextWindow).toBe(NARROW_WINDOW);

		await harness.session.prompt("next question");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
	});

	it("fires against the provider's measured input limit when the catalog over-declares the window", async () => {
		// bailian/qwen3.8-max-0902 declares 1M but DashScope rejects input past
		// 983616 (model-input-limits.ts). 790k sits between the measured trigger
		// (floor(min(983616*0.8, 983616-1000)) = 786892) and the declared one
		// (800000), so it must only compact when the trigger reads the measured cap.
		const harness = await createHarness({
			provider: "bailian",
			settings: {
				compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100, triggerRatio: 0.8 },
			},
			models: [{ id: "qwen3.8-max-0902", contextWindow: 1_000_000, maxTokens: 1000 }],
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
		seedContext(harness, 790_000);
		harness.setResponses([fauxAssistantMessage("answer after compaction")]);

		await harness.session.prompt("next question");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
	});
});
