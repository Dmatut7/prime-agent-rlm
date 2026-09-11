import { describe, expect, it } from "vitest";
import { DAEMON_RECONNECT_TIMEOUT_MS } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { ADOPTION_WORKER_REQUEST_TIMEOUT_MS } from "../src/modes/daemon/daemon-supervisor.js";
import {
	DAEMON_ADOPTION_REQUEST_TIMEOUT_MS,
	DAEMON_BACKGROUND_RECONNECT_RETRY_MS,
	daemonReconnectBudgetMs,
	WORKER_REQUEST_TIMEOUT_TIERS,
	workerRequestTimeoutMs,
	workerRequestTimeoutTier,
} from "../src/modes/daemon/daemon-timeouts.js";

/**
 * P1-7b: one 24h constant served a user-explicit long command, an agent-message
 * delivery leg and a startup adoption create alike, so any of them could hold a
 * drain latch or a client for a day. The tiers are the fix, and the table below
 * is the contract: which command gets which budget, and which deliberately keeps
 * the long one.
 */

describe("P1-7b worker request timeout tiers", () => {
	it("assigns a tier per command type", () => {
		const cases: Array<{ command: DaemonCommand["type"]; tier: string; ms: number; why: string }> = [
			{
				command: "send_message",
				tier: "deliver",
				ms: 120_000,
				why: "bounds one retried delivery attempt; the first keeps the 24h budget (C20)",
			},
			{ command: "get_state", tier: "read", ms: 30_000, why: "in-memory read, fails fast" },
			{ command: "get_connection_state", tier: "read", ms: 30_000, why: "in-memory read" },
			{ command: "agent_messages_status", tier: "read", ms: 30_000, why: "in-memory read" },
			{ command: "get_queue", tier: "read", ms: 30_000, why: "in-memory read" },
			{ command: "prompt", tier: "long", ms: 24 * 60 * 60 * 1000, why: "a user turn is long by design" },
			{ command: "refine", tier: "long", ms: 24 * 60 * 60 * 1000, why: "explicit long command" },
			{ command: "compact", tier: "long", ms: 24 * 60 * 60 * 1000, why: "explicit long command" },
			{
				command: "wait_for_idle",
				tier: "long",
				ms: 24 * 60 * 60 * 1000,
				why: "a pure wait observes state until it settles",
			},
			{
				command: "wait_for_headless_completion",
				tier: "long",
				ms: 24 * 60 * 60 * 1000,
				why: "RLM quiescence can take a whole run",
			},
			{
				command: "list_saved_sessions",
				tier: "long",
				ms: 24 * 60 * 60 * 1000,
				why: "scans the session directory",
			},
			{
				command: "get_messages",
				tier: "long",
				ms: 24 * 60 * 60 * 1000,
				why: "reads a whole transcript",
			},
			{
				command: "attach",
				tier: "long",
				ms: 24 * 60 * 60 * 1000,
				why: "carries a snapshot; the client owns the 30s budget",
			},
			{ command: "kill", tier: "long", ms: 24 * 60 * 60 * 1000, why: "terminal commands must not be cut short" },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(workerRequestTimeoutTier(testCase.command), `${testCase.command}: ${testCase.why}`).toBe(testCase.tier);
			expect(workerRequestTimeoutMs(testCase.command), testCase.command).toBe(testCase.ms);
		}
	});

	it("keeps the adoption tier equal to the supervisor's own adoption budget", () => {
		// T3-3 and T4-2 are the same number (fix-plan appendix A); the reconnect
		// budget below is derived from it, so a drift here moves both.
		expect(WORKER_REQUEST_TIMEOUT_TIERS.adoption).toBe(300_000);
		expect(DAEMON_ADOPTION_REQUEST_TIMEOUT_MS).toBe(ADOPTION_WORKER_REQUEST_TIMEOUT_MS);
		expect(WORKER_REQUEST_TIMEOUT_TIERS.long).toBeGreaterThan(WORKER_REQUEST_TIMEOUT_TIERS.adoption);
		expect(WORKER_REQUEST_TIMEOUT_TIERS.adoption).toBeGreaterThan(WORKER_REQUEST_TIMEOUT_TIERS.deliver);
		expect(WORKER_REQUEST_TIMEOUT_TIERS.deliver).toBeGreaterThan(WORKER_REQUEST_TIMEOUT_TIERS.read);
	});

	it("derives the reconnect budget from the recovery ladder it waits for", () => {
		// 330s = the 300s adoption create budget plus a 30s margin, and never
		// shorter than the 60s it replaced.
		expect(daemonReconnectBudgetMs()).toBe(330_000);
		expect(daemonReconnectBudgetMs()).toBe(DAEMON_ADOPTION_REQUEST_TIMEOUT_MS + 30_000);
		expect(daemonReconnectBudgetMs(0)).toBe(60_000);
		expect(daemonReconnectBudgetMs(10_000)).toBe(60_000);
		expect(DAEMON_RECONNECT_TIMEOUT_MS).toBe(daemonReconnectBudgetMs());
		expect(DAEMON_RECONNECT_TIMEOUT_MS).toBeGreaterThan(60_000);
		expect(DAEMON_BACKGROUND_RECONNECT_RETRY_MS).toBe(30_000);
	});
});
