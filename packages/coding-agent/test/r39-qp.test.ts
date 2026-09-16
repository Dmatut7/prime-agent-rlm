import { fauxAssistantMessage, fauxToolCall, type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRosterResult,
	type AgentSessionMessagePayload,
	createAgentMessageHostHandlers,
	createAgentSessionMessage,
	isRetryableAgentMessageSendError,
} from "../src/core/agent-messages.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";
import { createDeferred, createWaitingHarness } from "./suite/scheduling.js";

/**
 * r39 QP-1/2/3: input-queue fence and refusal semantics.
 *
 * QP-1: the update-restart fence must survive the resume paths that queue
 * mutation and compaction drive (mutateQueuedMessage, compact's preempted-auto
 * finally), mirroring the existing refusal precedent in
 * resumeQueuedWorkFromConnection/wakeSuspendedSessionInput.
 *
 * QP-2: the admission-pause refusal must be a typed retryable error for
 * agent-message senders (the id stays unspent, a resend is guided to retry
 * later), and abortForUpdateRestart must pause admission so a late child reply
 * is refused instead of queue-and-lose during teardown.
 *
 * QP-3: a coalesce hit must leave a visible ticket trace, and a same-key
 * follow-up arriving while the owner is committing must be refused as
 * retryable instead of double-queued and double-delivered.
 */

function createPayload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "Child" },
		target: { activeSessionId: "parent-active", sessionId: "parent-session" },
	};
}

describe("r39 QP-1: the update-restart fence survives queue mutation and compaction resumes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("mutateQueuedMessage during teardown keeps the fence up and does not deliver the parked steer", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const h = waiting.harness;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after abort"),
		]);
		await waiting.waitForToolStart;
		await h.session.steer("A");
		await h.session.steer("B");
		expect(h.session.queuedActionCount).toBe(2);

		h.session.abortForUpdateRestart();
		waiting.releaseToolExecution();
		await waiting.promptPromise.catch(() => undefined);
		await h.session.agent.waitForIdle();
		await h.session.waitForSessionInputIdle();
		expect(h.session.isQueuedWorkSuspended).toBe(true);
		expect(h.session.queuedActionCount).toBe(2);

		// The queue-mutation path (TUI Alt+Up / Enter / delete) must not revive the
		// pump during teardown.
		expect(h.session.mutateQueuedMessage("steering", 1, "B", { type: "delete" })).toBe("applied");
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(h.session.isQueuedWorkSuspended).toBe(true);
		expect(h.session.queuedActionCount).toBe(1);
		expect(getUserTexts(h)).not.toContain("A");
	});

	it("a manual compact finishing during teardown keeps the fence up (preempted-auto finally)", async () => {
		let extensionCalls = 0;
		const manualGate = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 185_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						extensionCalls += 1;
						if (extensionCalls === 1) {
							// The auto compaction parks until its scope is aborted.
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						await manualGate.promise;
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		const prompted = harness.session.prompt(`summarize this: ${"x".repeat(120_000)}`);
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason !== "manual").length)
			.toBe(1);

		const manual = harness.session.compact("manual instructions");
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason === "manual").length, {
				timeout: 5_000,
			})
			.toBe(1);

		// Teardown lands while the manual compaction is still in flight; its
		// finally-block resume must not lift the fence.
		harness.session.abortForUpdateRestart();
		manualGate.resolve();
		await manual;
		await prompted.catch(() => undefined);

		expect(harness.session.isQueuedWorkSuspended).toBe(true);
	});

	it("positive control: queue mutation after an ordinary abort still resumes and delivers the parked steer", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const h = waiting.harness;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after abort"),
		]);
		await waiting.waitForToolStart;
		await h.session.steer("A");
		await h.session.steer("B");

		h.session.requestAbort();
		waiting.releaseToolExecution();
		await waiting.promptPromise.catch(() => undefined);
		await h.session.agent.waitForIdle();
		await h.session.waitForSessionInputIdle();
		expect(h.session.isQueuedWorkSuspended).toBe(true);

		expect(h.session.mutateQueuedMessage("steering", 1, "B", { type: "delete" })).toBe("applied");
		await vi.waitFor(() => expect(h.session.isQueuedWorkSuspended).toBe(false));
		await h.session.waitForIdle();
		expect(getUserTexts(h)).toContain("A");
	});
});

describe("r39 QP-2: the admission-pause refusal is retryable for agent-message senders", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const ROSTER: AgentFamilyRosterResult = {
		current: { name: "parent", id: "parent-1", depth: 0 },
		entries: [{ relationship: "child", name: "worker", id: "child-1", depth: 1, status: "running" }],
	};
	const sendPayload = {
		type: "agent_message.send",
		message: "the answer is 42",
		receiver_role: "child",
		receiver_name: "worker",
	};
	const pausedText = "Cannot admit a session action while session input admission is paused.";

	function handlerHarness(errorText: string) {
		let deliveries = 0;
		const handlers = createAgentMessageHostHandlers({
			roster: async () => ROSTER,
			sendAgentMessage: async () => {
				deliveries += 1;
				throw new Error(errorText);
			},
		});
		return { handlers, deliveries: () => deliveries };
	}

	it("classifies the admission-pause refusal as retryable", () => {
		expect(isRetryableAgentMessageSendError(pausedText)).toBe(true);
	});

	it("an admission-pause refusal leaves the message id unspent so the resend reaches the delivery leg", async () => {
		const { handlers, deliveries } = handlerHarness(pausedText);
		await handlers["agent_message.send"]!({ ...sendPayload, message_id: "id-p" }).then(
			() => undefined,
			() => undefined,
		);
		const second = await handlers["agent_message.send"]!({ ...sendPayload, message_id: "id-p" }).then(
			() => "fulfilled",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expect(deliveries()).toBe(2);
		expect(String(second)).not.toContain("Refusing to resend");
	});

	it("a bare prompt during an admission pause throws a typed retryable error", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const pause = harness.session.acquireSessionInputPause();
		const error = await harness.session.prompt("paused prompt").then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(Error);
		const err = error as { name?: string; message?: string; retryable?: boolean };
		expect(err.name).toBe("SessionInputAdmissionPausedError");
		expect(err.message).toContain("session input admission is paused");
		expect(err.retryable).toBe(true);
		expect(isRetryableAgentMessageSendError(err.message ?? "")).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
		pause.release();
	});

	it("abortForUpdateRestart refuses late child replies with a retryable error instead of queue-and-lose", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		harness.session.abortForUpdateRestart();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		const message = createAgentSessionMessage(createPayload("agentmsg_qp2_late", "behind the fence"));
		const error = await harness.session
			.acceptAgentMessagePrompt(message.content, {
				expandPromptTemplates: false,
				streamingBehavior: "steer",
				queueIfBusy: true,
				customMessage: message,
			})
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
		const err = error as { name?: string; message?: string; retryable?: boolean };
		expect(err.name).toBe("SessionInputAdmissionPausedError");
		expect(err.retryable).toBe(true);
		expect(isRetryableAgentMessageSendError(err.message ?? "")).toBe(true);
		// The reply was refused, not parked: nothing runs during teardown.
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});
});

describe("r39 QP-3: coalesce tickets and the committing window", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		setLogSink(undefined);
	});

	it("a coalesce hit leaves a ticket trace without touching the queue snapshot", async () => {
		const entries: LogEntry[] = [];
		setLogSink((entry) => entries.push(entry));
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.steer("heartbeat owner", undefined, { queueKey: "heartbeat" });
		const snapshotBefore = JSON.stringify(harness.session.getSessionActionSnapshot());
		expect(await harness.session.followUp("duplicate heartbeat", undefined, { queueKey: "heartbeat" })).toBe(false);

		// Positive control: the queue projection is byte-identical across the hit.
		expect(JSON.stringify(harness.session.getSessionActionSnapshot())).toBe(snapshotBefore);
		// The hit is visible: a coalesced-into trace names the running owner key.
		const trace = entries
			.map((entry) => String(entry.msg))
			.find((msg) => /coalesced into running heartbeat/.test(msg));
		expect(trace).toBeDefined();
	});

	it("a same-key follow-up while the owner is committing is refused as retryable instead of double-queued", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done")]);
		const dispatchGate = createDeferred();
		const promptCalled = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				promptCalled.resolve();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("first heartbeat", undefined, { queueKey: "heartbeat", resumeIfIdle: true });
		pause.release();
		await promptCalled.promise;

		const error = await harness.session.followUp("second heartbeat", undefined, { queueKey: "heartbeat" }).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		const err = error as { name?: string; message?: string; retryable?: boolean };
		expect(err.name).toBe("SessionInputCoalescingError");
		expect(err.retryable).toBe(true);
		expect(isRetryableAgentMessageSendError(err.message ?? "")).toBe(true);
		expect(harness.session.unfinishedActionCount).toBe(1);

		dispatchGate.resolve();
		await harness.session.waitForSessionInputIdle();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["first heartbeat"]);
	});

	it("positive control: a different-key follow-up still queues while the owner is committing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const dispatchGate = createDeferred();
		const promptCalled = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				promptCalled.resolve();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("first heartbeat", undefined, { queueKey: "heartbeat", resumeIfIdle: true });
		pause.release();
		await promptCalled.promise;

		expect(await harness.session.followUp("other work", undefined, { queueKey: "other" })).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["other work"]);

		dispatchGate.resolve();
		await harness.session.waitForSessionInputIdle();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["first heartbeat", "other work"]);
	});
});
