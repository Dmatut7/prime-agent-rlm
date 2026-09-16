import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("#19 compaction with late child usage", () => {
	const harnesses: Harness[] = [];
	const summary = "summary of the older turn";
	const summaryUsage = usage(33);

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function seededHarness(beforeCompact: (harness: Harness) => void | Promise<void>) {
		let firstKeptEntryId = "";
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						await beforeCompact(harness);
						return {
							compaction: {
								summary,
								firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								usage: summaryUsage,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("recent answer")]);
		await harness.session.prompt("old request");
		await harness.session.prompt("recent request");
		const users = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(users).toHaveLength(2);
		firstKeptEntryId = users[1].id;
		return harness;
	}

	function appendChildUsage(harness: Harness, targetId: string, count: number) {
		return Array.from({ length: count }, (_, index) =>
			harness.sessionManager.appendChildUsageAttribution(
				targetId,
				usage(10),
				usage(100 + (index + 1) * 10),
				"spawn_task",
			),
		);
	}

	it.each([0, 1, 3])("keeps compaction current across %i usage entries and reopen", async (count) => {
		let targetId = "";
		let attributionIds: string[] = [];
		const harness = await seededHarness((current) => {
			attributionIds = appendChildUsage(current, targetId, count);
		});
		targetId = harness.sessionManager.getLeafId()!;
		const originalUsage = harness.session.messages.filter((message) => message.role === "assistant").at(-1)!.usage;
		await harness.session.compact();

		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		const compaction = compactions[0];
		expect(compaction.parentId).toBe(attributionIds.at(-1) ?? targetId);
		expect(harness.sessionManager.getLeafId()).toBe(compaction.id);
		expect(harness.session.messages).toContainEqual(expect.objectContaining({ role: "compactionSummary", summary }));
		expect(harness.session.messages.map(getMessageText)).not.toContain("old request");
		expect(harness.session.messages.map(getMessageText)).not.toContain("old answer");
		expect(harness.session.messages.map(getMessageText)).toEqual(
			expect.arrayContaining(["recent request", "recent answer"]),
		);

		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		for (const manager of [harness.sessionManager, reopened]) {
			expect(manager.getLeafId()).toBe(compaction.id);
			expect(manager.getEntry(compaction.id)).toMatchObject({ usage: summaryUsage });
			const attributions = manager.getBranch().filter((entry) => entry.type === "child_usage_attributed");
			// Persisted usage may be coalesced; its total and latest state must survive.
			expect(attributions.reduce((total, entry) => total + entry.childUsage.totalTokens, 0)).toBe(count * 10);
			expect(attributions.at(-1)?.id).toBe(attributionIds.at(-1));
			if (count === 0) {
				expect(attributions).toHaveLength(0);
			} else {
				expect(attributions.length).toBeGreaterThan(0);
				for (const attribution of attributions) {
					expect(attribution).toMatchObject({ targetId, origin: "spawn_task" });
				}
				expect(attributions.at(-1)?.aggregateUsage).toEqual(usage(100 + count * 10));
			}
			const messages = manager.buildSessionContext().messages;
			expect(messages).toContainEqual(expect.objectContaining({ role: "compactionSummary", summary }));
			expect(messages.map(getMessageText)).not.toContain("old request");
			expect(messages.map(getMessageText)).not.toContain("old answer");
			expect(messages.map(getMessageText)).toEqual(expect.arrayContaining(["recent request", "recent answer"]));
			expect(messages).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					usage: count === 0 ? originalUsage : usage(100 + count * 10),
				}),
			);
		}
		let nextRequestTexts: string[] = [];
		harness.setResponses([
			(context) => {
				nextRequestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("continued after compaction");
			},
		]);
		await harness.session.prompt("follow up");
		expect(nextRequestTexts).toEqual(expect.arrayContaining(["recent request", "recent answer", "follow up"]));
		expect(nextRequestTexts.join("\n")).toContain(summary);
		expect(nextRequestTexts).not.toContain("old request");
		expect(nextRequestTexts).not.toContain("old answer");
	});

	it.each(["navigate", "reset", "user", "tool"] as const)(
		"does not pull the current leaf back after %s followed by child usage",
		async (change) => {
			let targetId = "";
			let changedLeafId = "";
			let appendedMessageId: string | undefined;
			const harness = await seededHarness(async (current) => {
				const manager = current.sessionManager;
				if (change === "navigate") {
					const users = manager
						.getBranch()
						.filter((entry) => entry.type === "message" && entry.message.role === "user");
					expect(users).toHaveLength(2);
					await current.session.navigateTree(users[1].id);
				} else if (change === "reset") {
					manager.resetLeaf();
				} else {
					appendedMessageId = manager.appendMessage(
						change === "user"
							? { role: "user", content: "arrived during compaction", timestamp: Date.now() }
							: {
									role: "toolResult",
									toolCallId: "late-tool",
									toolName: "test-tool",
									content: [{ type: "text", text: "arrived during compaction" }],
									isError: false,
									timestamp: Date.now(),
								},
					);
				}
				[changedLeafId] = appendChildUsage(current, targetId, 1);
			});
			targetId = harness.sessionManager.getLeafId()!;
			await harness.session.compact();

			const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(compactions).toHaveLength(1);
			expect(compactions[0].parentId).toBe(targetId);
			expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
			const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
			for (const manager of [harness.sessionManager, reopened]) {
				expect(manager.getLeafId()).toBe(changedLeafId);
				expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
				expect(manager.getEntry(changedLeafId)).toMatchObject({ type: "child_usage_attributed", targetId });
				if (appendedMessageId) {
					expect(manager.getBranch().map((entry) => entry.id)).toContain(appendedMessageId);
					expect(manager.buildSessionContext().messages.map(getMessageText)).toContain(
						"arrived during compaction",
					);
				}
			}
		},
	);
});
