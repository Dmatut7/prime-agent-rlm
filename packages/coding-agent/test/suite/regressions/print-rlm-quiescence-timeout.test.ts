/**
 * K3Q-1: the FR-4 quiescence give-up outcome must not be swallowed.
 *
 * print/json mode used to discard `waitForRlmQuiescence`'s
 * `{settled, timedOut}` outcome, so once the 5-minute deadline fired the run
 * completed "normally": no signal, exit code 0, and the dispose path cascaded
 * into aborting the still-running descendants - the exact thing the barrier
 * (print-mode.ts) was built to prevent. On give-up the run must say so
 * (stderr, non-clean exit code) and must not tear the session down.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import { runPrintModeWithConnection } from "../../../src/modes/print-mode.js";
import { createHarness, type Harness } from "../harness.js";

vi.mock("../../../src/core/output-guard.js", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
}));

describe("print mode RLM quiescence give-up", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		vi.useRealTimers();
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it.each(["text", "json"] as const)(
		"signals the give-up and skips the teardown cascade when descendants never settle",
		async (mode) => {
			let releaseChild!: () => void;
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			child = await createHarness({
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			});
			child.setResponses([
				async () => {
					await childGate;
					return fauxAssistantMessage("child finished");
				},
			]);
			parent = await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child!.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			});
			parent.setResponses([fauxAssistantMessage("parent consumed the child result")]);

			await parent.session.runRlmChild("deep work", { name: "deep-worker" });
			await expect.poll(() => parent!.session.hasRunningRlmChildren()).toBe(true);
			// The root turn is fully settled while the child is still running.
			await parent.session.waitForHeadlessIdle();

			const disposeSpy = vi.fn(async () => {});
			const runtimeHost = {
				session: parent.session,
				setRebindSession: vi.fn(),
				dispose: disposeSpy,
			};
			const connection = new InProcessAgentConnection(runtimeHost as never);
			const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

			vi.useFakeTimers();
			let exitCode: number | undefined;
			// Snapshot before the finally: mockRestore clears the call log.
			let stderrCalls: string[] = [];
			try {
				const printDone = runPrintModeWithConnection(connection, { mode });
				// FR-4's deadline: the give-up fires and the wait returns instead of hanging.
				await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
				exitCode = await printDone;
				stderrCalls = stderr.mock.calls.map((call) => String(call[0]));
			} finally {
				vi.useRealTimers();
				stderr.mockRestore();
			}

			// The run completed without hanging ...
			expect(exitCode).toBeDefined();
			// ... but not as a clean completion: the user hears that descendants were
			// still running when the wait gave up.
			expect(stderrCalls.some((text) => text.includes("still running"))).toBe(true);
			expect(exitCode).not.toBe(0);
			// The teardown cascade must not fire: still-running descendants are left
			// alone instead of being aborted through the session dispose path.
			expect(disposeSpy).not.toHaveBeenCalled();
			expect(parent.session.hasRunningRlmChildren()).toBe(true);

			releaseChild();
		},
	);
});
