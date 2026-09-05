/**
 * Print/json mode used to wait only for root idle before completing the owned
 * session, so the worker shutdown cascaded into aborting RLM subagents that
 * were still running. The completion barrier must wait for full RLM
 * quiescence instead, matching the ACP terminal settlement path.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import { runPrintModeWithConnection } from "../../../src/modes/print-mode.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

vi.mock("../../../src/core/output-guard.js", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
}));

describe("print mode RLM quiescence barrier", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it.each(["text", "json"] as const)(
		"does not complete a %s mode run until in-flight RLM children settle",
		async (mode) => {
			const sendAgentMessage = vi.fn(async () => {
				throw new Error("synthesized terminal notices must not use agent_message");
			});
			let releaseChild!: () => void;
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			child = await createHarness({
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage,
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

			await parent.session.runRlmChild("work quietly", { name: "print-worker" });
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

			let completed = false;
			const printDone = runPrintModeWithConnection(connection, { mode }).then((exitCode) => {
				completed = true;
				return exitCode;
			});

			// An idle-only barrier would complete and dispose immediately here.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(completed).toBe(false);
			expect(disposeSpy).not.toHaveBeenCalled();
			expect(parent.session.hasRunningRlmChildren()).toBe(true);

			releaseChild();
			await expect(printDone).resolves.toBe(0);
			expect(completed).toBe(true);
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(parent.session.hasRunningRlmChildren()).toBe(false);
			expect(sendAgentMessage).not.toHaveBeenCalled();
			expect(getAssistantTexts(parent)).toEqual(["parent consumed the child result"]);
		},
	);
});
