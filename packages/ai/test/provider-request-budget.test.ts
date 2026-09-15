import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

/**
 * RC-3: the OpenAI/Anthropic SDKs retry on their own, with no event and no log line,
 * while the agent loop and the session retried on top of them. One failing turn could
 * spend a dozen full-context requests and nothing in the transcript said so. The budget
 * counted here is shared with the other layers: the attempt that spends the last request
 * of the chain is marked non-retryable for the SDK, and every attempt is reported.
 *
 * The budget and the attempt sink are passed as a shape (not as imported types) so this
 * file also compiles against the frozen revision, where neither exists: there the SDK
 * burns all four requests and reports nothing.
 */
interface BudgetShape {
	used: number;
	maxRequests?: number;
	readonly exhausted: boolean;
	record(): { attempt: number; allowRetry: boolean; used: number; maxRequests?: number };
}

function createBudgetShape(maxRequests: number): BudgetShape {
	let used = 0;
	return {
		get used() {
			return used;
		},
		maxRequests,
		get exhausted() {
			return used >= maxRequests;
		},
		record() {
			used += 1;
			return { attempt: used, allowRetry: used < maxRequests, used, maxRequests };
		},
	};
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
}

async function terminalEvent(stream: AsyncIterable<AssistantMessageEvent>) {
	let last: AssistantMessageEvent | undefined;
	for await (const event of stream) {
		last = event;
		if (event.type === "done" || event.type === "error") break;
	}
	return last;
}

/** Server that answers every request with 500 and no `retry-after` (the silent SDK retry path). */
async function startFailingServer() {
	let count = 0;
	const server = http.createServer((_req, res) => {
		count++;
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { type: "server_error", message: "boom" }, type: "error" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests: () => count,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function completionsModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "budget-model",
		name: "budget-model",
		api: "openai-completions",
		provider: "budget-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

interface AttemptNotice {
	attempt: number;
	used: number;
	maxRequests?: number;
	status?: number;
	retrySuppressedBy?: string;
}

describe("cross-layer provider request budget", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("stops the SDK from spending more than the chain ceiling, and reports every attempt", async () => {
		const server = await startFailingServer();
		try {
			const budget = createBudgetShape(2);
			const notices: AttemptNotice[] = [];
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					// The SDK's own budget (3 retries): without a shared ceiling it would
					// spend 4 requests for this one failing turn.
					maxRetries: 3,
					requestBudget: budget,
					onProviderRequestAttempt: (notice: AttemptNotice) => notices.push(notice),
				} as never),
			);

			expect(event?.type).toBe("error");
			expect(server.requests()).toBe(2);
			expect(notices.map((notice) => notice.attempt)).toEqual([1, 2]);
			expect(notices.at(-1)).toMatchObject({ status: 500, retrySuppressedBy: "request_budget" });
			expect(budget.exhausted).toBe(true);
		} finally {
			await server.close();
		}
	}, 20000);

	it("keeps the provider's own error classification when the budget stops the retry", async () => {
		const server = await startFailingServer();
		try {
			const budget = createBudgetShape(1);
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 3,
					requestBudget: budget,
				} as never),
			);

			expect(event?.type).toBe("error");
			expect(server.requests()).toBe(1);
			// A budget-cut retry must not read as a different failure than it is.
			const message = event?.type === "error" ? event.error : undefined;
			expect(message?.errorMessage ?? "").toMatch(/5\d\d|server error|boom/i);
		} finally {
			await server.close();
		}
	}, 20000);
});
