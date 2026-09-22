import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TOOL_TIMEOUT_CAUSE_PREFIX } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * r4 recovery, mechanism ② at the session wiring level: the per-tool-call deadline
 * resolves from `tools.timeout` settings, and a fired deadline asks the stall
 * watchdog for the exemption verdict - the single arbiter, whose budget the
 * extension consumes. Progress evidence defers, liveness defers, no evidence or no
 * watchdog cancels the call while the turn continues, and the two rollback handles
 * disarm the deadline everywhere (per-tool budgets included).
 */

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		// Live clock: the aggregate judges staleness against Date.now().
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

/** A kernel running a command that is producing output: the progress tier. */
function workingKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10, streamBytes: 100 }),
		latest: sample({ tick: 40, streamBytes: 4_000, bashHandles: 1, bashCellHandles: 1 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

/** Frames arrive but the tick never moves: the liveness (existence-only) tier. */
function wedgedKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10 }),
		latest: sample({ tick: 10 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

/** A tool with no deadline budget of its own: only the loop-level policy applies. */
function unbudgetedTool(settleMs: number): AgentTool {
	return {
		name: "plain_cell",
		label: "Plain Cell",
		description: "Settles after a while",
		parameters: Type.Object({}),
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			return { content: [{ type: "text", text: "plain tool completed" }], details: {} };
		},
	};
}

/** A tool that asks for a 30ms deadline and settles after a slow real delay. */
function slowVouchedTool(settleMs: number): AgentTool {
	return {
		name: "slow_cell",
		label: "Slow Cell",
		description: "Settles after a while",
		parameters: Type.Object({}),
		executionTimeoutMs: 30,
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			return { content: [{ type: "text", text: "slow tool completed" }], details: {} };
		},
	};
}

function textOfLastToolResult(harness: Harness): string {
	const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
	const last = toolResults.at(-1) as { content: Array<{ type: string; text?: string }> } | undefined;
	expect(last).toBeDefined();
	return (last?.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

async function runSlowToolTurn(harness: Harness, toolName = "slow_cell"): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("changed approach after the tool result"),
	]);
	await harness.session.promptAndWait(`run the ${toolName}`);
}

describe("per-tool-call deadline vouch wiring", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("progress evidence defers the deadline: the vouched tool completes", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(800)],
			stallKernelLivenessFacts: () => workingKernelFacts(),
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		expect(textOfLastToolResult(harness)).toContain("slow tool completed");
		expect(textOfLastToolResult(harness)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		// The turn continued: the model answered the tool result.
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("liveness-only evidence also defers: existence still buys the short budget", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(800)],
			stallKernelLivenessFacts: () => wedgedKernelFacts(),
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		// The wedged-kernel vouch is liveness tier: the deadline defers in half
		// windows instead of firing, so the call completes within the test window.
		expect(textOfLastToolResult(harness)).toContain("slow tool completed");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("no evidence cancels the call and the turn continues", async () => {
		const harness = await createHarness({ tools: [slowVouchedTool(3_000)] });
		harnesses.push(harness);

		// The turn must settle (via the deadline) while the tool itself is still slow:
		// a finished prompt here is the receipt that the deadline, not the tool, ended it.
		const turn = runSlowToolTurn(harness);
		await turn;

		const resultText = textOfLastToolResult(harness);
		expect(resultText).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(resultText).toContain("slow_cell");
		expect(resultText).toContain("the turn was not");
		// The model saw the cancellation and answered in a second request.
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("a disabled watchdog is a disabled arbiter: no exemption, the deadline stands", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(3_000)],
			settings: { stallWatchdog: { enabled: false } },
			stallKernelLivenessFacts: () => workingKernelFacts(),
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		// The watchdog is the single arbiter (r4 ruling): turning it off turns off the
		// exemption channel with it, even when the facts would vouch.
		expect(textOfLastToolResult(harness)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("tools.timeout.enabled false disarms the deadline everywhere (rollback handle)", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(3_000)],
			settings: { tools: { timeout: { enabled: false } } },
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		// Even the per-tool executionTimeoutMs is disarmed: the handles are the master switch.
		expect(textOfLastToolResult(harness)).toContain("slow tool completed");
		expect(textOfLastToolResult(harness)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});

	it("an operator perTool budget from settings arms one tool past the shared default", async () => {
		const harness = await createHarness({
			tools: [unbudgetedTool(3_000)],
			// The shared default (180s) would never fire in the test window; only the
			// operator's per-tool budget can cancel this call.
			settings: { tools: { timeout: { perTool: { plain_cell: 25 } } } },
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness, "plain_cell");

		const resultText = textOfLastToolResult(harness);
		expect(resultText).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(resultText).toContain("per-call budget 25ms");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("an operator perTool 0 from settings exempts one tool", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(3_000)],
			// The tool's own 30ms budget is overridden by the operator's exemption.
			settings: { tools: { timeout: { perTool: { slow_cell: 0 } } } },
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		expect(textOfLastToolResult(harness)).toContain("slow tool completed");
		expect(textOfLastToolResult(harness)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});

	it("tools.timeout.afterMs 0 disarms the deadline (second rollback handle)", async () => {
		const harness = await createHarness({
			tools: [slowVouchedTool(3_000)],
			settings: { tools: { timeout: { afterMs: 0 } } },
		});
		harnesses.push(harness);

		await runSlowToolTurn(harness);

		expect(textOfLastToolResult(harness)).toContain("slow tool completed");
		expect(textOfLastToolResult(harness)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});
});
