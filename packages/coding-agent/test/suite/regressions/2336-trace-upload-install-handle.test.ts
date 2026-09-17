import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	type AgentTraceUploadCycleOutcome,
	type AgentTraceUploadDelay,
	installAgentTraceUpload,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../../../src/core/agent-traces.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../../../src/core/prime-inference-auth.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";

/**
 * Upstream #2336 bullet 3: the automatic trace-upload install returns a settle handle, and the
 * upload reports the wait it arms before its next request.
 *
 * A scheduled upload is not over when its response comes back - it writes the outbox cursor that
 * records what was sent - and the startup catch-up is a second writer the caller cannot see at
 * all. The handle is what lets a caller (a graceful exit, or a fixture about to delete the agent
 * directory) settle that work instead of racing it, and the delay notifications are what let it
 * be awaited without a wall-clock pump over a bounded fake-timer budget.
 *
 * This file installs first in its own module instance: the startup catch-up runs once per
 * process, so the handle's catch-up contract is pinned by the first test here.
 */

interface FetchCall {
	url: string;
	init: RequestInit;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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

function createUserMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function writeSession(cwd: string, sessionDir: string, id: string): SessionManager {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession({ id });
	sessionManager.appendMessage(createUserMessage(`user ${id}`));
	sessionManager.appendMessage(createAssistantMessage(`assistant ${id}`));
	return sessionManager;
}

function createFetchRecorder(calls: FetchCall[]): typeof fetch {
	return async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(JSON.stringify({ bytes_stored: 123 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

/** Mirrors the outbox on-disk format: one JSON entry per session file, named by path hash. */
function outboxEntryPath(agentDir: string, sessionFile: string): string {
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
	return join(agentDir, "agent-traces-outbox", `${key}.json`);
}

function writeOutboxEntry(agentDir: string, sessionFile: string): void {
	mkdirSync(join(agentDir, "agent-traces-outbox"), { recursive: true });
	writeFileSync(outboxEntryPath(agentDir, sessionFile), JSON.stringify({ sessionFile }));
}

function readOutboxEntry(
	agentDir: string,
	sessionFile: string,
): { sessionFile: string; size?: number; mtimeMs?: number } | undefined {
	if (!existsSync(outboxEntryPath(agentDir, sessionFile))) return undefined;
	return JSON.parse(readFileSync(outboxEntryPath(agentDir, sessionFile), "utf8")) as {
		sessionFile: string;
		size?: number;
		mtimeMs?: number;
	};
}

async function advanceTimersUntil(condition: () => boolean): Promise<void> {
	for (let step = 0; step < 200 && !condition(); step += 1) {
		await stat(new URL(import.meta.url));
		if (!condition() && vi.getTimerCount() > 0) {
			await vi.advanceTimersToNextTimerAsync();
		}
	}
	if (!condition()) {
		throw new Error("Timed out advancing fake timers to the expected condition");
	}
}

describe("automatic trace-upload install handle", () => {
	let tempDir: string;
	let previousEnvironment: Record<string, string | undefined>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-traces-handle-"));
		previousEnvironment = {
			[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
			DO_NOT_TRACK: process.env.DO_NOT_TRACK,
			PRIME_AGENT_TRACES_API_KEY: process.env.PRIME_AGENT_TRACES_API_KEY,
			PRIME_API_KEY: process.env.PRIME_API_KEY,
		};
		process.env[ENV_AGENT_DIR] = tempDir;
		process.env.DO_NOT_TRACK = "0";
		delete process.env.PRIME_AGENT_TRACES_API_KEY;
		delete process.env.PRIME_API_KEY;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	function installOptions(calls: FetchCall[], extra: Record<string, unknown> = {}) {
		return {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key" as const, key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			...extra,
		};
	}

	it("settles the shared startup catch-up before the handle resolves", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		// A session that persisted while nothing was installed: the catch-up owes it an upload.
		const missed = writeSession(cwd, sessionDir, "missed-session");
		const missedFile = missed.getSessionFile() as string;
		writeOutboxEntry(tempDir, missedFile);

		const live = SessionManager.create(cwd, sessionDir);
		live.newSession({ id: "live-session" });
		const calls: FetchCall[] = [];
		const installation = installAgentTraceUpload(live, installOptions(calls));

		await installation.whenIdle();

		// The cursor the catch-up writes is the proof it finished: the handle resolved after that
		// write, not before it.
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.example.test/api/v1/agent-traces/sessions/missed-session",
		]);
		const stats = await stat(missedFile);
		expect(readOutboxEntry(tempDir, missedFile)).toEqual({
			sessionFile: missedFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});
	}, 30_000);

	it("settles the automatic upload a caller would otherwise race, without moving the clock", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "handle-session" });
		const sessionFile = sessionManager.getSessionFile() as string;

		let releaseFetch: () => void = () => undefined;
		const fetchReleased = new Promise<void>((resolveReleased) => {
			releaseFetch = resolveReleased;
		});
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			await fetchReleased;
			return new Response(JSON.stringify({ bytes_stored: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const installation = installAgentTraceUpload(sessionManager, installOptions(calls, { fetchFn }));
		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		// The debounce is armed and has not fired: a caller that tore down now would drop the upload.
		expect(calls).toHaveLength(0);

		const idle = installation.whenIdle();
		await advanceTimersUntil(() => calls.length === 1);

		// The request is gated, so no amount of clock settles the handle while it is in flight.
		const settled: string[] = [];
		void installation.whenIdle().then(() => settled.push("settled"));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(settled).toEqual([]);

		releaseFetch();
		await advanceTimersUntil(() => settled.length === 1);
		await idle;

		const stats = await stat(sessionFile);
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({
			sessionFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});
	}, 30_000);

	it("reports the retry backoff it arms before the next attempt", async () => {
		vi.useFakeTimers();
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "backoff-session");
		const delays: AgentTraceUploadDelay[] = [];
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			if (calls.length === 1) {
				return new Response(JSON.stringify({ message: "try later" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ bytes_stored: 5 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const upload = uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			...installOptions(calls, { fetchFn }),
			reloadConfig: false,
			onUploadDelay: (delay) => delays.push(delay),
		});

		await advanceTimersUntil(() => calls.length === 1);
		// The notice lands before the wait it describes, which is what lets a caller await the
		// backoff instead of pumping the clock and hoping the attempt happened.
		await advanceTimersUntil(() => delays.length === 1);
		expect(delays.map((delay) => delay.reason)).toEqual(["retry-backoff"]);
		// 500ms base with ±20% jitter: the exponential backoff, not a wall-clock guess.
		expect(delays[0].delayMs).toBeGreaterThanOrEqual(400);
		expect(delays[0].delayMs).toBeLessThanOrEqual(600);
		await advanceTimersUntil(() => calls.length === 2);
		expect((await upload).status).toBe("uploaded");
	}, 30_000);

	it("reports the batch gate wait as a rate limit", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		writeSession(cwd, sessionDir, "batched-one");
		writeSession(cwd, sessionDir, "batched-two");

		const delays: AgentTraceUploadDelay[] = [];
		const calls: FetchCall[] = [];
		const batch = uploadAllAgentTraces({
			sessionDir,
			concurrency: 2,
			...installOptions(calls),
			reloadConfig: false,
			onUploadDelay: (delay) => delays.push(delay),
		});

		await advanceTimersUntil(() => calls.length === 1);
		await advanceTimersUntil(() => delays.some((delay) => delay.reason === "rate-limit"));
		const gateWait = delays.find((delay) => delay.reason === "rate-limit");
		// The batch gate paces requests over the platform's rate-limit window.
		expect(gateWait?.delayMs).toBeGreaterThan(0);

		await advanceTimersUntil(() => calls.length === 2);
		expect((await batch).uploaded).toBe(2);
	}, 30_000);

	it("does not flush an armed retry past the server's Retry-After", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "retry-after-session" });

		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			if (calls.length === 1) {
				return new Response(JSON.stringify({ message: "slow down" }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "30" },
				});
			}
			return new Response(JSON.stringify({ bytes_stored: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const installation = installAgentTraceUpload(sessionManager, installOptions(calls, { fetchFn }));
		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => calls.length === 1);

		// The upload came back rate limited, so the retry is armed for the server's window. A
		// settle must not flush it early: the durable outbox replays it on the next catch-up.
		await installation.whenIdle();
		await vi.advanceTimersByTimeAsync(29_000);
		expect(calls).toHaveLength(1);

		// Once that window is over the armed retry runs and reports itself.
		await advanceTimersUntil(() => calls.length === 2);
	}, 30_000);

	it("reports every scheduled cycle it settles, including one folded into an in-flight upload", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "settled-cycles-session" });

		let releaseFetch: () => void = () => undefined;
		const fetchReleased = new Promise<void>((resolveReleased) => {
			releaseFetch = resolveReleased;
		});
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			if (calls.length === 1) {
				await fetchReleased;
			}
			return new Response(JSON.stringify({ bytes_stored: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const outcomes: AgentTraceUploadCycleOutcome[] = [];
		installAgentTraceUpload(
			sessionManager,
			installOptions(calls, {
				fetchFn,
				// The gated request must outlive the throttle window this test advances through.
				requestTimeoutMs: 300_000,
				onUploadSettled: (outcome: AgentTraceUploadCycleOutcome) => outcomes.push(outcome),
			}),
		);

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => calls.length === 1);
		expect(outcomes).toEqual([]);

		// New content lands while the first upload is still in flight: the follow-up folds into it
		// and says so, so an observer sees this cycle end instead of waiting on a counter.
		sessionManager.appendMessage(createUserMessage("more"));
		sessionManager.appendMessage(createAssistantMessage("content"));
		// The follow-up is armed for the rest of the throttle window, and the gated request is
		// still in flight (its own timeout is out of the way), so that cycle must coalesce.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(outcomes).toEqual([{ status: "coalesced" }]);

		releaseFetch();
		// The coalesced cycle left a guaranteed follow-up behind it: once the in-flight leg lands,
		// the content that arrived during it is uploaded, and both cycles are reported.
		await advanceTimersUntil(() => calls.length === 2);
		// Two requests were made - the second is the follow-up the coalesced cycle kept pending -
		// and every cycle reported its own end: the fold, and the two uploads.
		expect(outcomes).toEqual([
			{ status: "coalesced" },
			expect.objectContaining({ status: "uploaded" }),
			expect.objectContaining({ status: "uploaded" }),
		]);
	}, 30_000);
});
