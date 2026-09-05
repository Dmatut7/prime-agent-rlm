/**
 * FIX-Q8 regression: RLM child terminal notices dispatch as
 * `queueVisible: false` turns. The R1 settle predicate only matched
 * `queueVisible === true`, the abort cancellation predicate spares durable
 * notices, and the pump's deferred-error path does not roll delivered work
 * back, so a notice whose turn was dispatched when an abort arrived stayed
 * committing/running forever: `unfinishedActionCount` pinned above zero,
 * breaking eviction, wait_for_idle, and RLM quiescence.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createRlmChildTerminalNoticeMessage } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

describe("FIX-Q8 abort settles a dispatched terminal-notice turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("drops unfinishedActionCount to zero for a dispatched terminal notice", { timeout: 20000 }, async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// The notice turn streams until the abort releases the response gate.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
				await Promise.race([
					gate,
					new Promise<void>((resolve) => {
						const signal = options?.signal;
						if (!signal) return;
						if (signal.aborted) {
							resolve();
							return;
						}
						signal.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				return fauxAssistantMessage("notice turn done");
			},
		]);

		const internals = harness.session as unknown as {
			_actionStore: {
				actions(): Array<{ id: string; lifecycle: { state: string }; payload: { queueVisible?: boolean } }>;
			};
			_durableRlmTerminalNoticeActionIds: Set<string>;
		};
		const runningNotice = () =>
			internals._actionStore
				.actions()
				.find(
					(action) =>
						action.lifecycle.state === "running" && internals._durableRlmTerminalNoticeActionIds.has(action.id),
				);

		const notice = createRlmChildTerminalNoticeMessage({
			kind: "completed_without_reply",
			childId: "child-fix-q8",
			sessionName: "worker",
		});
		harness.session.restorePendingNextTurnMessages([notice]);

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !runningNotice()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runningNotice()).toBeDefined();
		expect(harness.session.unfinishedActionCount).toBe(1);

		// Abort while the terminal-notice turn is running: requestAbort must
		// settle it synchronously even though it is queue-invisible.
		harness.session.requestAbort();
		expect(harness.session.unfinishedActionCount).toBe(0);

		release();
		await harness.session.abort();
		const idle = await Promise.race([
			harness.session.waitForIdle().then(() => ({ ok: true as const })),
			new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 2000)),
		]);
		expect(idle).toEqual({ ok: true });
		expect(harness.session.unfinishedActionCount).toBe(0);
	});
});
