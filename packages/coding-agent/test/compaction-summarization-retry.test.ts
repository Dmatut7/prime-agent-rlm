import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "../src/core/compaction/index.js";
import type { ProviderRetryPolicy } from "../src/core/provider-retry.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

/**
 * wave-40 secondary: a transient provider failure on the summarization wire call
 * used to fail the whole compaction on the spot - and for an overflow recovery
 * that ended the task. compact() already receives the session's shared provider
 * retry policy; the summarization request now honors it: the provider client
 * makes a single attempt per round and the module retries transient failures with
 * the policy's backoff, exactly like the branch summarizer. Permanent rejections,
 * input-length rejections and refusals keep their dedicated paths untouched.
 */

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function okResponse(text = "## Goal\nSummarized."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(20),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function errorResponse(errorMessage: string, details?: { kind: string; status?: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(0),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		...(details
			? {
					diagnostics: [{ type: "provider_stream_failure" as const, timestamp: Date.now(), details }],
				}
			: {}),
	};
}

function createModel(): Model<"openai-completions"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Test Model",
		api: "openai-completions",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	};
}

function createPreparation(): CompactionPreparation {
	const messages: AgentMessage[] = [
		{ role: "user", content: "summarize me", timestamp: Date.now() },
		{
			role: "assistant",
			content: [{ type: "text", text: "working on it" }],
			api: "openai-completions",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: createUsage(2),
			stopReason: "stop",
			timestamp: Date.now(),
		} as AgentMessage,
	];
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 0,
		fileOps: createFileOps(),
		settings: {
			...DEFAULT_COMPACTION_SETTINGS,
			enabled: true,
			reserveTokens: 512,
			keepRecentTokens: 20_000,
		},
	};
}

const POLICY: ProviderRetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxRetryDelayMs: 50 };

function compactWithPolicy(retry?: ProviderRetryPolicy, signal?: AbortSignal) {
	return compact(
		createPreparation(),
		createModel(),
		"test-key",
		undefined,
		undefined,
		signal,
		undefined,
		undefined,
		retry,
	);
}

describe("summarization transient provider retry", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("retries a transient failure with the shared policy and succeeds", async () => {
		completeSimpleMock
			.mockImplementationOnce(async () =>
				errorResponse("500 internal server error", { kind: "server_error", status: 500 }),
			)
			.mockImplementationOnce(async () => okResponse());

		const result = await compactWithPolicy(POLICY);

		expect(result.summary).toContain("Summarized.");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		// The module owns the retries, so each provider call is a single attempt.
		const secondCallOptions = completeSimpleMock.mock.calls[1]?.[2] as { maxRetries?: number };
		expect(secondCallOptions.maxRetries).toBe(0);
	});

	it("gives up after the policy's retries and reports the last failure", async () => {
		completeSimpleMock.mockImplementation(async () =>
			errorResponse("503 overloaded", { kind: "overloaded", status: 503 }),
		);

		await expect(compactWithPolicy(POLICY)).rejects.toThrow("Summarization failed: 503 overloaded");
		// 1 initial attempt + maxRetries retries.
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry a permanent rejection", async () => {
		completeSimpleMock.mockImplementation(async () =>
			errorResponse("400 bad request", { kind: "invalid_request", status: 400 }),
		);

		await expect(compactWithPolicy(POLICY)).rejects.toThrow("Summarization failed: 400 bad request");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the input-length shrink path single-stepped per shrink attempt", async () => {
		// The shrink loop owns input-length rejections; the transient retry must not
		// spend the policy on them first.
		completeSimpleMock
			.mockImplementationOnce(async () => errorResponse("maximum context length exceeded"))
			.mockImplementationOnce(async () => okResponse());

		const result = await compactWithPolicy(POLICY);

		expect(result.summary).toContain("Summarized.");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("without a policy the call keeps its single-shot behavior", async () => {
		completeSimpleMock.mockImplementation(async () =>
			errorResponse("500 internal server error", { kind: "server_error", status: 500 }),
		);

		await expect(compactWithPolicy(undefined)).rejects.toThrow("Summarization failed: 500 internal server error");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("an abort during the backoff settles as a cancellation", async () => {
		const controller = new AbortController();
		completeSimpleMock.mockImplementation(async () => {
			controller.abort();
			return errorResponse("500 internal server error", { kind: "server_error", status: 500 });
		});

		await expect(compactWithPolicy(POLICY, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});
});
