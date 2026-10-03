import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

/**
 * wave-40 must-2: a retry chain that is still open when overflow compaction takes
 * over the turn used to deadlock the session. agent_end returned early on
 * `compactionWillRetry && _retryAttempt > 0` without closing the retry chain, and
 * the post-compaction continuation waits on waitForRetry() before it may continue -
 * so the continuation never ran, isRetrying stuck true, and only Esc could unwedge
 * the session. The chain must be closed (failure ledger + _resolveRetry) before the
 * compaction continuation is scheduled.
 *
 * Same file, second fix: the user-configured backup model is only useful when its
 * context window holds the current context; routing an oversized context onto a
 * small-window backup just failed again, this time on the backup. The backup check
 * now prices the context (measured usage, content estimate when usage is unknown)
 * against the backup's window before switching.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** 250k chars measure ~62.5k estimated tokens: over a 0.5 trigger on a 100k window. */
const FILL_OUTPUT = `FILL-MARKER-retry-deadlock${"x".repeat(250_000)}`;

function fillTool(): AgentTool {
	return {
		name: "fill",
		label: "fill",
		description: "returns a large body",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: FILL_OUTPUT }], details: {} }),
	};
}

const retryableError = (): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

const overflowError = (): AssistantMessage =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "prompt is too long: 200000 tokens > 100000 maximum",
	});

describe("retry chain vs overflow compaction at agent_end", () => {
	it("closes the retry chain so the post-compaction continuation can run", async () => {
		const harness = await createHarness({
			tools: [fillTool()],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
				compaction: {
					enabled: false,
					reserveTokens: 500,
					keepRecentTokens: 1,
					triggerRatio: 0.5,
				},
			},
			models: [{ id: "faux-1", contextWindow: 100_000 }],
		});
		harnesses.push(harness);

		const summarizationMarker = "context summarization assistant";
		const mainScript: AssistantMessage[] = [
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fill noted"),
			retryableError(),
			overflowError(),
			fauxAssistantMessage("finally done"),
		];
		// One factory per expected call; summarization calls never consume the script,
		// so a split-turn second summary call cannot eat the continuation's answer.
		// Responses are stamped at serve time: a prebuilt message carries its
		// construction time, which would read as "before the compaction" and skip
		// the overflow check.
		const step = (context: Context) => {
			if (context.systemPrompt?.includes(summarizationMarker)) {
				return fauxAssistantMessage("## Goal\nEarlier work summarized.");
			}
			const next = mainScript.shift();
			if (!next) throw new Error("no scripted answer left");
			return { ...next, timestamp: Date.now() };
		};
		harness.setResponses([step, step, step, step, step, step, step, step]);

		await harness.session.prompt("fill the context");
		harness.session.setAutoCompactionEnabled(true);

		await harness.session.prompt("keep going");

		// Red state: the continuation is wedged behind the never-resolved retry
		// promise and this wait times out.
		await vi.waitFor(
			() => {
				expect(getAssistantTexts(harness)).toContain("finally done");
			},
			{ timeout: 5_000, interval: 20 },
		);
		expect(harness.session.isRetrying).toBe(false);
		const retryEnds = harness.eventsOfType("auto_retry_end");
		expect(retryEnds.some((event) => event.success === false)).toBe(true);
		expect(harness.eventsOfType("compaction_end").some((event) => event.reason === "overflow")).toBe(true);
	});
});

describe("backup model retry vs context window", () => {
	const transientServerError = (): AssistantMessage => ({
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal server error" }),
		diagnostics: [
			{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "server_error", status: 500 } },
		],
	});

	function mediumTool(): AgentTool {
		return {
			name: "fill",
			label: "fill",
			description: "returns a body too large for the backup's window",
			parameters: Type.Object({}),
			execute: async () => ({
				// ~5k estimated tokens: far over the backup's 4k window, far under the
				// primary's 100k one (and under any compaction trigger).
				content: [{ type: "text", text: `MEDIUM-MARKER${"x".repeat(20_000)}` }],
				details: {},
			}),
		};
	}

	const SETTINGS: Partial<Settings> = {
		providerBackupModel: "faux/faux-small",
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
		compaction: { enabled: false },
	};

	it("skips the backup model when the measured context does not fit its window", async () => {
		const harness = await createHarness({
			tools: [mediumTool()],
			settings: SETTINGS,
			models: [
				{ id: "faux-1", contextWindow: 100_000 },
				{ id: "faux-small", contextWindow: 4_000 },
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fill noted"),
		]);
		await harness.session.prompt("fill the context");

		harness.setResponses([transientServerError(), fauxAssistantMessage("recovered on the primary")]);
		await harness.session.prompt("keep going");

		await vi.waitFor(
			() => {
				expect(getAssistantTexts(harness)).toContain("recovered on the primary");
			},
			{ timeout: 5_000, interval: 20 },
		);
		// The retry stayed on the primary: no backup switch, no model change record.
		expect(harness.session.model?.id).toBe("faux-1");
		const backupStarts = harness.eventsOfType("auto_retry_start").filter((event) => event.reason === "backup");
		expect(backupStarts).toHaveLength(0);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "model_change" && entry.modelId === "faux-small"),
		).toBe(false);
	});

	it("still routes to the backup when its window holds the context", async () => {
		const harness = await createHarness({
			settings: {
				providerBackupModel: "faux/faux-big",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
				compaction: { enabled: false },
			},
			models: [
				{ id: "faux-1", contextWindow: 100_000 },
				{ id: "faux-big", contextWindow: 500_000 },
			],
		});
		harnesses.push(harness);

		harness.setResponses([transientServerError(), fauxAssistantMessage("recovered on the backup")]);

		await harness.session.prompt("small prompt");

		await vi.waitFor(
			() => {
				expect(getAssistantTexts(harness)).toContain("recovered on the backup");
			},
			{ timeout: 5_000, interval: 20 },
		);
		const backupStarts = harness.eventsOfType("auto_retry_start").filter((event) => event.reason === "backup");
		expect(backupStarts).toHaveLength(1);
	});
});
