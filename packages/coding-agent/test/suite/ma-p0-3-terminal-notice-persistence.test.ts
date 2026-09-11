/**
 * P0-3c: an undeliverable child terminal report must not vanish.
 *
 * Red at HEAD: `maybeAbandonStaleDeferredRlmTerminalNotices` filtered the notice
 * out of the next-turn queue after five minutes and recorded only a counter - no
 * event, no log, no persistence. A child that was killed while its parent sat
 * behind a suspended pump therefore produced exactly nothing, anywhere.
 *
 * The abandonment threshold is injectable (AgentSessionConfig
 * .rlmTerminalNoticeAbandonAfterMs) and `maybeAbandon...` takes an explicit `now`,
 * so none of this waits five real minutes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
} from "../../src/core/agent-messages.js";
import {
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

const STALE_MS = 6 * 60_000;

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang",
		description: "never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function failureNotice(childId: string, error = "killed by the stall watchdog"): CustomMessage {
	return createRlmChildFailureMessage({ childId, sessionName: `worker-${childId}`, error, kind: "stall_killed" });
}

function payload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "Child" },
		target: { activeSessionId: "parent-active", sessionId: "parent-session" },
	};
}

function customMessages(session: { messages: readonly unknown[] }, customType: string): CustomMessage[] {
	return session.messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === customType,
	);
}

interface SidecarRow {
	key: string;
	message: CustomMessage;
	writtenAt: number;
}

function readSidecar(path: string | undefined): SidecarRow[] {
	if (!path || !existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SidecarRow);
}

describe("P0-3c terminal notice persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	it("writes an undeliverable failure notice into the parent transcript and reports it", async () => {
		const harness = track(await createHarness());
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		harness.session.restorePendingNextTurnMessages([failureNotice("child-a")]);

		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);

		// The notice is in the transcript (display:true), not silently filtered away.
		const landed = customMessages(harness.session, RLM_CHILD_FAILURE_CUSTOM_TYPE);
		expect(landed).toHaveLength(1);
		expect(landed[0]?.display).toBe(true);
		expect(landed[0]?.content).toContain("killed by the stall watchdog");
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);

		// Three observable exits: the public record, the event, and the transcript.
		expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
		const events = harness.eventsOfType("rlm_terminal_notice_abandoned");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ abandoned: 0, persistedToTranscript: 1 });
		// A persisted failure is not also abandoned: the session must stay evictable
		// without losing the report.
		expect(harness.session.isSessionActive).toBe(false);
	});

	it("lands the notice even while the parent is still streaming", async () => {
		// The direct-land path must be unconditional: sendCustomMessage's else branch
		// turns into a steer/follow-up queue entry while streaming, which is the very
		// "wait for the pump" path an undeliverable notice must not take (amend ②).
		const harness = track(await createHarness({ tools: [hangTool()] }));
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("hang in a tool").catch(() => undefined);
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true), { timeout: 10_000, interval: 20 });

		const pause = harness.session.acquireSessionInputPause();
		try {
			harness.session.restorePendingNextTurnMessages([failureNotice("child-streaming")]);
			expect(harness.session.isStreaming).toBe(true);

			harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);

			expect(harness.session.isStreaming).toBe(true);
			expect(customMessages(harness.session, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toHaveLength(1);
			expect(harness.eventsOfType("rlm_terminal_notice_abandoned")).toHaveLength(1);
		} finally {
			pause.release();
			harness.session.requestAbort();
		}
	});

	it("abandons a routine notice without persisting it", async () => {
		const harness = track(await createHarness({ persistSession: true }));
		harness.session.requestAbort();
		const notice = createRlmChildTerminalNoticeMessage({
			kind: "completed_without_reply",
			childId: "child-quiet",
			sessionName: "worker-quiet",
		});
		harness.session.restorePendingNextTurnMessages([notice]);
		const sidecarPath = harness.session.undeliveredRlmNoticeSidecarPath;
		expect(sidecarPath).toBeTypeOf("string");

		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);

		// Positive control against "persist everything": the routine fourth state is
		// still abandoned so the session can passivate/evict.
		expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
		expect(harness.eventsOfType("rlm_terminal_notice_abandoned")[0]).toMatchObject({
			abandoned: 1,
			persistedToTranscript: 0,
		});
		expect(customMessages(harness.session, "rlm_child_terminal_notice")).toEqual([]);
		harness.session.dispose();
		expect(readSidecar(sidecarPath)).toEqual([]);
	});

	it("persists undelivered work at dispose and reflows it on the next resume", async () => {
		const harness = track(await createHarness({ persistSession: true }));
		harness.session.requestAbort();
		harness.session.restorePendingNextTurnMessages([failureNotice("child-disposed")]);
		const sidecarPath = harness.session.undeliveredRlmNoticeSidecarPath;

		harness.session.dispose();

		const rows = readSidecar(sidecarPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.message.customType).toBe(RLM_CHILD_FAILURE_CUSTOM_TYPE);
		expect(rows[0]?.message.content).toContain("worker-child-disposed");
		expect(rows[0]?.key).toContain("child-disposed:stall_killed");

		// Reflow: the same code path the constructor uses on a restart of this
		// session, driven here through a resume.
		const restored = track(await createHarness({ persistSession: true }));
		restored.setResponses([fauxAssistantMessage("read the restored notice")]);
		restored.session.requestAbort();
		const restoredPath = restored.session.undeliveredRlmNoticeSidecarPath;
		expect(restoredPath).toBeDefined();
		expect(restoredPath).not.toBe(sidecarPath);
		// Put the row where this session will look for it, then resume.
		writeFileSync(restoredPath!, `${JSON.stringify(rows[0])}\n`, { mode: 0o600 });
		restored.session.resumeQueuedWork();

		// The reflowed notice is delivered, not merely re-queued: the resume flushes it
		// into a turn, which is the whole point of persisting it.
		await vi.waitFor(() => expect(customMessages(restored.session, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toHaveLength(1), {
			timeout: 10_000,
			interval: 20,
		});
		expect(customMessages(restored.session, RLM_CHILD_FAILURE_CUSTOM_TYPE)[0]?.content).toContain(
			"worker-child-disposed",
		);
		// Consumed: the sidecar is gone, so a second resume cannot re-inject it.
		expect(existsSync(restoredPath!)).toBe(false);
		restored.session.requestAbort();
		restored.session.resumeQueuedWork();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(customMessages(restored.session, RLM_CHILD_FAILURE_CUSTOM_TYPE)).toHaveLength(1);
	});

	it("persists a queued ordinary reply at dispose instead of dropping it", async () => {
		const harness = track(await createHarness({ persistSession: true }));
		harness.setResponses([fauxAssistantMessage("not consumed")]);
		harness.session.requestAbort();
		const message = createAgentSessionMessage(payload("agentmsg_b1_dispose", "ordinary child reply"));
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
			customMessage: message,
		});
		expect(harness.session.isSessionActive).toBe(false);
		const sidecarPath = harness.session.undeliveredRlmNoticeSidecarPath;

		harness.session.dispose();

		// B1 后半: without this, "queued" would be blinder than the hard error it
		// replaced - the reply would be dropped by the dispose queue clear.
		const rows = readSidecar(sidecarPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.message.content).toContain("ordinary child reply");
	});

	it("de-duplicates the same notice written twice", async () => {
		const harness = track(await createHarness({ persistSession: true }));
		harness.session.requestAbort();
		const notice = failureNotice("child-dup");
		// Same child, same kind, same timestamp: one identity, however often it is
		// offered (sidecar plus queue is the double-delivery shape this prevents).
		harness.session.restorePendingNextTurnMessages([notice, { ...notice }]);
		const sidecarPath = harness.session.undeliveredRlmNoticeSidecarPath;

		harness.session.dispose();

		const rows = readSidecar(sidecarPath);
		expect(rows).toHaveLength(1);
	});
});
