import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomMessageEntry } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

describe("r43 MC-3 thinking level intent", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps the requested level as intent and re-clamps it per model on switch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const base = harness.getModel();
		// Model A: low/high only (medium and minimal are disabled by null entries).
		const modelA: Model<string> = {
			...base,
			reasoning: true,
			thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high" },
		};
		// Model B: supports medium.
		const modelB: Model<string> = {
			...base,
			id: `${base.id}-b`,
			reasoning: true,
			thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
		};

		await harness.session.setModel(modelA);
		harness.session.setThinkingLevel("medium");

		// Clamped for A, but the request and the warning are visible.
		expect(harness.session.thinkingLevel).toBe("low");
		const clampedEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomMessageEntry =>
					entry.type === "custom_message" && entry.customType === "thinking_level_clamped",
			);
		expect(clampedEntries.length).toBeGreaterThanOrEqual(1);
		const lastClamp = clampedEntries[clampedEntries.length - 1];
		expect(String(lastClamp?.content)).toContain("medium");
		expect(String(lastClamp?.content)).toContain("low");
		expect(lastClamp?.display).toBe(true);
		// Settings keep the user's intent, not the clamped value.
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");

		await harness.session.setModel(modelB);
		// The switch re-clamps from the intent: medium is supported on B.
		expect(harness.session.thinkingLevel).toBe("medium");
		const levelChanges = harness.sessionManager.getBranch().filter((entry) => entry.type === "thinking_level_change");
		const last = levelChanges[levelChanges.length - 1] as { thinkingLevel?: string } | undefined;
		expect(last?.thinkingLevel).toBe("medium");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});
});
