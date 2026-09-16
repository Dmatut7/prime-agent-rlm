/**
 * JIT-1 (round-44, K3 plan A + B), session wiring: the watchdog's default exemption sink logs
 * without a session identity, and a daemon worker hosts many sessions per process through one
 * shared stall-evidence file - an exemption line that cannot be attributed to the session it
 * vouched for is a line a post-mortem cannot use. The session must route exemption events
 * through its own sink with the session id, and the tool-boundary flutter a short-cell loop
 * produces must arrive folded, not one pair per cell.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.js";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, type Harness } from "./harness.js";

const quickTool: AgentTool = {
	name: "quick_cell",
	label: "Quick Cell",
	description: "A tool that completes immediately",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	// Live clock: the aggregate judges staleness against Date.now(), so a fixed epoch here
	// would make every fixture look like a heartbeat that stopped long ago.
	return {
		receivedAt: Date.now(),
		tick: 10,
		intervalMs: 5_000,
		cellId: "cell-1",
		cpuMs: 1_000,
		streamBytes: 0,
		cellsDone: 0,
		hostRequests: 0,
		bashHandles: 0,
		bashCellHandles: 0,
		bashBufferedBytes: 0,
		bashPipePending: 0,
		...overrides,
	};
}

/** A kernel a journaled degraded read would vouch for: live handles under a live loop. */
function degradedJournalKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 3,
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: false,
	};
}

describe("JIT-1 exemption event attribution and flutter folding", () => {
	const harnesses: Harness[] = [];
	let entries: LogEntry[] = [];

	beforeEach(() => {
		entries = [];
		setLogSink((entry) => {
			entries.push(entry);
		});
	});

	afterEach(() => {
		setLogSink(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	async function waitForEvent(
		harness: Harness,
		predicate: (event: AgentSessionEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<AgentSessionEvent> {
		return vi.waitFor(
			() => {
				const found = harness.events.find(predicate);
				expect(found, "session never emitted the expected event").toBeDefined();
				if (!found) throw new Error("unreachable");
				return found;
			},
			{ timeout: timeoutMs, interval: 10 },
		);
	}

	it("folds the flutter and attributes every exemption line to the session", async () => {
		const harness = track(
			await createHarness({
				tools: [quickTool],
				settings: {
					// Thresholds far past the turn's lifetime: no stage may fire here, so the
					// only exemption traffic is what the tool boundaries themselves produce.
					stallWatchdog: { enabled: true, warnAfterSeconds: 60, abortAfterSeconds: 120 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => degradedJournalKernelFacts(),
				stallJournaledBashHandles: () => ({ liveBashHandles: 9 }),
			}),
		);
		const sessionId = harness.sessionManager.getSessionId();

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("quick_cell", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("quick_cell", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("quick_cell", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run three quick cells");
		await waitForEvent(harness, (event) => event.type === "agent_end");

		const exemptionLines = entries.filter((entry) => entry.msg.startsWith("stall watchdog: exemption"));
		expect(exemptionLines.length, "the turn produced no exemption traffic at all").toBeGreaterThan(0);

		// A: the three tool start/end pairs must not reach the log as six per-event lines.
		const perEvent = exemptionLines.filter(
			(entry) => !entry.msg.startsWith("stall watchdog: exemption micro_segments"),
		);
		expect(perEvent, "tool-boundary flutter must be folded, not logged pair by pair").toHaveLength(0);

		const summaries = exemptionLines.filter((entry) =>
			entry.msg.startsWith("stall watchdog: exemption micro_segments"),
		);
		expect(summaries.length).toBe(1);
		expect(summaries[0]?.count).toBe(6);

		// B: every line a post-mortem reads from the shared file names the session it vouched for.
		for (const line of exemptionLines) {
			expect(line.sessionId).toBe(sessionId);
		}
	});
});
