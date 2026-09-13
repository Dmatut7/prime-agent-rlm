import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACTION_RECOVERY_HINT_THRESHOLD } from "../../src/core/compaction/index.js";
import { isCompactionOutcomeMessage } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * The production failure this covers: a session above its compaction threshold
 * whose summarization request the provider rejects for input length. It repeats
 * every turn, so the notice has to end in something the user can do.
 */
const DASHSCOPE_INPUT_LENGTH_400 =
	"400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]";
const OVERFLOW_ERROR = "prompt is too long: 270128 tokens > 262144 maximum";

function summarizationFailure() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: DASHSCOPE_INPUT_LENGTH_400 });
}

/** One summarization attempt plus its bounded input-length retries. */
function summarizationFailures() {
	return [summarizationFailure(), summarizationFailure(), summarizationFailure()];
}

function outcomeContents(harness: Harness): string[] {
	return harness.session.messages.filter(isCompactionOutcomeMessage).map((message) => message.content);
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
	return promise.then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

describe("compaction failure recovery hint", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			models: [{ id: "budget-fixture", contextWindow: 262144, maxTokens: 8192 }],
			settings: {
				autoRefine: { enabled: false },
				compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 50 },
				retry: { enabled: false },
			},
		});
		harnesses.push(harness);
		// Two turns of real size, so a cut that keeps only the newest ~50 estimated
		// tokens still leaves history to summarize.
		harness.setResponses([
			fauxAssistantMessage("Earlier findings recorded."),
			fauxAssistantMessage("Second turn recorded."),
		]);
		await harness.session.prompt("Earlier context. ".repeat(100));
		await harness.session.prompt("Second turn context. ".repeat(20));
		return harness;
	}

	it("escalates a repeating auto-compaction failure into recovery options", async () => {
		const harness = await setup();

		for (let attempt = 1; attempt <= COMPACTION_RECOVERY_HINT_THRESHOLD; attempt++) {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
				...summarizationFailures(),
			]);
			await harness.session.prompt(`Continue the task, attempt ${attempt}.`);

			const outcomes = outcomeContents(harness);
			expect(outcomes).toHaveLength(attempt);
			const latest = outcomes.at(-1) ?? "";
			expect(latest).toContain("Summarization failed");
			expect(latest).toContain(DASHSCOPE_INPUT_LENGTH_400);
			if (attempt < COMPACTION_RECOVERY_HINT_THRESHOLD) {
				expect(latest).not.toContain("times in a row");
				continue;
			}
			expect(latest).toContain(`${COMPACTION_RECOVERY_HINT_THRESHOLD} times in a row`);
			for (const command of ["/compact", "/tree", "/model", "/new"]) {
				expect(latest).toContain(command);
			}
			// The same guidance reaches the UI through the event, not only the transcript.
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("times in a row");
		}
	});

	it("counts manual failures and clears the streak once a compaction succeeds", async () => {
		const harness = await setup();
		const rejections: string[] = [];

		for (let attempt = 1; attempt <= COMPACTION_RECOVERY_HINT_THRESHOLD; attempt++) {
			harness.setResponses(summarizationFailures());
			rejections.push(await rejectionOf(harness.session.compact()));
		}

		expect(rejections).toHaveLength(COMPACTION_RECOVERY_HINT_THRESHOLD);
		for (const rejection of rejections) expect(rejection).toContain("Summarization failed");
		expect(rejections[0]).not.toContain("times in a row");
		expect(rejections.at(-1)).toContain(`${COMPACTION_RECOVERY_HINT_THRESHOLD} times in a row`);
		expect(rejections.at(-1)).toContain("/new");

		// A compaction that produces a summary ends the streak.
		harness.setResponses([
			fauxAssistantMessage("More material for the next summary."),
			fauxAssistantMessage("model-generated summary"),
		]);
		await harness.session.prompt("More material for the next summary. ".repeat(20));
		const result = await harness.session.compact();
		expect(result.summary).toContain("model-generated summary");

		harness.setResponses([fauxAssistantMessage("Even more material."), ...summarizationFailures()]);
		await harness.session.prompt("Even more material for another summary. ".repeat(20));
		const afterSuccess = await rejectionOf(harness.session.compact());
		expect(afterSuccess).toContain("Summarization failed");
		expect(afterSuccess).not.toContain("times in a row");
	});

	it("does not count a skipped compaction toward the failure streak", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("model-generated summary")]);
		await harness.session.compact();
		// Immediately after a compaction there is nothing left to summarize.
		expect(await rejectionOf(harness.session.compact())).toContain("Already compacted");

		// Two failures after a skip stay below the threshold: had the skip counted as
		// a failure, the second one would already carry the recovery options.
		expect(COMPACTION_RECOVERY_HINT_THRESHOLD).toBeGreaterThan(2);
		for (let attempt = 1; attempt <= 2; attempt++) {
			harness.setResponses([fauxAssistantMessage(`Material for turn ${attempt}.`), ...summarizationFailures()]);
			await harness.session.prompt(`Material for turn ${attempt}. `.repeat(20));
			const rejection = await rejectionOf(harness.session.compact());
			expect(rejection).toContain("Summarization failed");
			expect(rejection).not.toContain("times in a row");
		}
	});
});
