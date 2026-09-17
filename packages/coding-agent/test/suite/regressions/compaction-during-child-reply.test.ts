/**
 * Symptom B (boss's field observation, 2026-09-17): with the parent's context already
 * over the compaction threshold, a child's reply was admitted first - it opened a turn
 * on the oversized context - and the parent's own auto compaction only ran after that
 * turn ended. Manually killing agent-message admission was what let the compaction
 * through, so the ranking then was "child reply > compaction". This file pins the
 * opposite ranking - compaction first, child reply second - plus the two valves that
 * keep a repeatedly failing compaction from wedging the session.
 *
 * Status: pins 1 and 3 were RED at HEAD=06260455d (measured 23:09 - the reply's
 * `message_start` came at timeline index 1, `compaction_end` at index 3) and went green
 * once `_incomingAgentMessageCompactionGate` landed. They stay here as regression pins;
 * the flag-off control below still reproduces the old ordering on demand.
 *
 * ## Coordinates
 * Symbol names are authoritative. The line numbers were read off the working tree at
 * 2026-09-17 23:52 (HEAD=236faf357, other lanes' src edits in flight) and src keeps
 * moving under this file: quote the symbol, not the number.
 *
 * ## The bug that was (still visible through the escape hatch)
 *   - `DaemonMode.acceptAgentSessionMessage` (daemon-mode.ts:6567) is the child-reply
 *     call: streamingBehavior "steer", queueIfBusy true, customMessage.
 *   - `AgentSession.acceptAgentMessagePrompt` (agent-session.ts:6381) forwards to
 *     `_prompt` (agent-session.ts:7622) with skipInputHandlers + skipPrePromptWork +
 *     returnAfterAccepted.
 *   - On a session that is neither streaming nor compacting, `_prompt` takes the direct
 *     branch: `queueForBusy` is false because `_isBusyForSessionInput("preflight")`
 *     (agent-session.ts:8794) only reports compaction/retry/bash/pending work, so
 *     `visibleQueued` is false and the action is admitted with `immediatelyEligible`.
 *   - The asymmetry is in `_turnExecutionPolicy` (agent-session.ts:8171):
 *     `preTurnCompaction: options.skipPrePromptWork ? "skip" : "afterModelSelection"`
 *     (agent-session.ts:8201). A child reply therefore never reached
 *     `_runPreTurnCompaction` (agent-session.ts:6259) through `_prepareForCommit`
 *     (agent-session.ts:6279/6284), while a plain user prompt does - pin 0 pins that
 *     path, so a gate that fixed agent messages by breaking directPrompt goes red.
 *     Without pre-turn compaction the reply's compaction was deferred to that turn's
 *     agent_end (`_checkCompaction`, agent-session.ts:5383): one request closer to the
 *     provider's input wall per reply.
 *
 * ## The gate now in the tree
 *   - `_incomingAgentMessageCompactionGate` (agent-session.ts:6522) answers
 *     "compaction_in_flight" (a compaction is running: do not interrupt it),
 *     "compaction_pending" (over the trigger and nothing running: start one now) or
 *     undefined (admit normally). It stands down for human input, system fences, a
 *     suspended pump, a streaming turn, disabled compaction and inside
 *     `_isThresholdCompactionCoolingDown` (agent-session.ts:12200) - the anti-starvation
 *     case, so a family is not blocked by a compaction that will not run.
 *   - `acceptAgentMessagePrompt` (agent-session.ts:6407-6438) then starts the compaction
 *     BEFORE queueing (`_startThresholdCompactionForIncomingInput`, agent-session.ts:6565,
 *     fire-and-forget so admission never blocks on a summarization call), queues the
 *     reply with reason "compaction_pending", and re-schedules the pump so a compaction
 *     that settled mid-queue cannot strand the message.
 *   - The in-flight half was already correct before the gate: once `_runAutoCompaction`
 *     (agent-session.ts:12385) has armed `_autoCompactionAbortController`
 *     (agent-session.ts:12417), `isCompacting` is true, `_isBusyForSessionInput` queues
 *     the reply, and `_pumpSessionInputs` (agent-session.ts:8578) refuses to select it
 *     while compacting. Pin 2 documents that half.
 *
 * ## Valves
 *   - `_registerCompactionFailure` (agent-session.ts:12228) counts consecutive failures;
 *     `shrunkKeepRecentTokens` (compaction.ts:749, wired at agent-session.ts:10848)
 *     halves the retained tail from COMPACTION_KEEP_RECENT_SHRINK_START (1) down to
 *     MIN_SHRUNK_KEEP_RECENT_TOKENS (4096) - pin 4.
 *   - `_runEmergencyContextShrink` (agent-session.ts:12315) is the lossy last resort at
 *     COMPACTION_EMERGENCY_SHRINK_FAILURES (4): `planEmergencyShrink` (compaction.ts:882)
 *     picks the cut, `buildEmergencyShrinkSummary` (compaction.ts:953) writes the summary
 *     the model reads, `buildEmergencyShrinkNotice` (compaction.ts:995) the persisted
 *     compaction-outcome notice - pin 5.
 *
 * ## Controls (this repo requires both directions)
 *   - pin 0 proves the direct-prompt path compacts first, so pins 1/3 are not asserting
 *     something every path already does;
 *   - pin 2's `queued === true` is checked against a control that admits the very same
 *     steer immediately when nothing is in flight;
 *   - pins 1/3's ordering is checked against `compaction.priorityOverAgentMessages:
 *     false`, the documented escape hatch back to the old ranking;
 *   - pin 5's "the oldest context is what gets dropped" is checked against the same
 *     fill being verifiably in the model's view before the valve runs.
 *
 * ## Calibers
 * Context size is measured as transcript characters plus a fill marker, not as
 * `estimateContextTokens`: that estimate anchors on the last assistant usage, and a
 * compaction keeps recent assistant messages whose usage still reports the
 * pre-compaction context (`_getThresholdContextTokens`, agent-session.ts:12042, exists
 * precisely to ignore those). The marker is what says "the oversized turn was really
 * summarized away". Where a token number is needed anyway (pins 4/5), it is compared
 * against src's own `compactionThresholdTokens`, not a hardcoded figure.
 *
 * A compaction is failed by making the SUMMARIZATION REQUEST fail, not by throwing from
 * the `session_before_compact` hook: a throwing hook now fails the compaction outright
 * (`ExtensionRunner.callHandler` rethrows for that hook), which would test the hook's
 * error path instead of the summarizer's. Failing the summarization call itself is what
 * keeps the summarizer and the valve under test here.
 */

import { writeFileSync } from "node:fs";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import {
	COMPACTION_EMERGENCY_SHRINK_FAILURES,
	compactionThresholdTokens,
	EMERGENCY_SHRINK_TARGET_RATIO,
	estimateContextTokens,
	SUMMARIZATION_SYSTEM_PROMPT,
	shouldCompact,
} from "../../../src/core/compaction/index.js";
import { isCompactionOutcomeMessage } from "../../../src/core/messages.js";
import type { CompactionEntry } from "../../../src/core/session-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

/** Marker so "the giant fill is still in context" is decidable without token maths. */
const BIG_MARKER = "FILL-MARKER-9c1f";
/** ~10k estimated tokens for ASCII (chars/4), well over the 4_800-token trigger below. */
const BIG_OUTPUT = `${BIG_MARKER}${"x".repeat(40_000)}`;
const SMALL_OUTPUT = "ok";

/** Pins 0-3 and the two ranking controls: a tiny window so one fill trips the trigger. */
const CONTEXT_WINDOW = 6_000;
/** Trigger = min(window * triggerRatio, window - reserveTokens) = min(4800, 5500). */
const TRIGGER_RATIO = 0.8;
const RESERVE_TOKENS = 500;
const KEEP_RECENT_TOKENS = 1;

/**
 * Pins 4/5 need a window whose trigger stays above the configured keepRecentTokens, or
 * `capKeepRecentTokens` clamps the budget first and the halving has nothing to show.
 * Trigger = min(200_000 * 0.8, 200_000 - 1_000) = 160_000 > 20_000.
 */
const VALVE_CONTEXT_WINDOW = 200_000;
const VALVE_RESERVE_TOKENS = 1_000;
const VALVE_KEEP_RECENT_TOKENS = 20_000;
/** MIN_SHRUNK_KEEP_RECENT_TOKENS, written out so the floor is a pin and not an echo. */
const EXPECTED_KEEP_RECENT_FLOOR = 4_096;
/**
 * shrunkKeepRecentTokens(20_000, failures) for the four attempts of pin 4: attempt N
 * runs with N-1 failures on the counter, and COMPACTION_KEEP_RECENT_SHRINK_START is 1,
 * so attempt 2 already halves. The fourth halving lands on the 4_096 floor. Written out
 * on purpose - deriving it from the same function src calls would prove nothing.
 */
const EXPECTED_KEEP_RECENT_SEQUENCE = [20_000, 10_000, 5_000, EXPECTED_KEEP_RECENT_FLOOR];
/** Read from src so a retuned valve moves the pin instead of silently missing it. */
const EMERGENCY_SHRINK_FAILURES = COMPACTION_EMERGENCY_SHRINK_FAILURES;
const EMERGENCY_SHRINK_HEADLINE = "EMERGENCY CONTEXT SHRINK";

interface CompactionGate {
	/** Resolves once the compaction hook parked on the gate (compaction is in flight). */
	entered: Promise<void>;
	/** Resolves when the gate is released; the hook also bails out on an abort. */
	open: Promise<void>;
	enteredCount(): number;
	/** Called by the `session_before_compact` hook when it parks. */
	markEntered(): void;
	release(): void;
	isReleased(): boolean;
}

/** Holds a compaction open inside `session_before_compact` so the window can be probed. */
function createCompactionGate(): CompactionGate {
	let resolveEntered = (): void => {};
	const enteredPromise = new Promise<void>((resolve) => {
		resolveEntered = resolve;
	});
	let resolveOpen = (): void => {};
	const openPromise = new Promise<void>((resolve) => {
		resolveOpen = resolve;
	});
	let entered = 0;
	let released = false;
	return {
		entered: enteredPromise,
		open: openPromise,
		enteredCount: () => entered,
		markEntered: () => {
			entered += 1;
			resolveEntered();
		},
		release: () => {
			released = true;
			resolveOpen();
		},
		isReleased: () => released,
	};
}

/**
 * What the `session_before_compact` hook saw. `calls` is the honest failure counter for
 * the valve pins: `_consecutiveCompactionFailures` is private, and a hook that was
 * reached and then threw is exactly one failed compaction.
 */
interface HookRecorder {
	calls: number;
	keepRecentTokens: Array<number | undefined>;
}

function createHookRecorder(): HookRecorder {
	return { calls: 0, keepRecentTokens: [] };
}

type TimelineMark = "compaction_start" | "compaction_end" | "input_delivered" | "turn_start";

interface TimelineSample {
	mark: TimelineMark;
	contextChars: number;
	bigFillInContext: boolean;
	contextTokens: number;
}

interface Timeline {
	samples: ReadonlyArray<TimelineSample>;
	indexOf(mark: TimelineMark): number;
	count(mark: TimelineMark): number;
	sampleAt(mark: TimelineSample["mark"]): TimelineSample | undefined;
}

function contextChars(harness: Harness): number {
	return harness.session.messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function bigFillInContext(harness: Harness): boolean {
	return harness.session.messages.some((message) => JSON.stringify(message).includes(BIG_MARKER));
}

function messageText(message: AgentMessage): string {
	// BashExecutionMessage carries command/output, not content.
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

/**
 * Ordered observation of the session's own event stream (public `subscribe`), with the
 * context state captured at each mark. Event order is the evidence for "compaction ran
 * before this input opened a turn"; the captured context is the evidence for "the turn
 * carrying it saw a compacted context".
 */
function recordTimeline(harness: Harness, isInputUnderTest: (message: AgentMessage) => boolean): Timeline {
	const samples: TimelineSample[] = [];
	const sample = (mark: TimelineMark) => {
		samples.push({
			mark,
			contextChars: contextChars(harness),
			bigFillInContext: bigFillInContext(harness),
			contextTokens: estimateContextTokens(harness.session.messages).tokens,
		});
	};
	harness.session.subscribe((event) => {
		if (event.type === "compaction_start") sample("compaction_start");
		else if (event.type === "compaction_end") sample("compaction_end");
		else if (event.type === "turn_start") sample("turn_start");
		else if (event.type === "message_start" && isInputUnderTest(event.message)) sample("input_delivered");
	});
	return {
		samples,
		indexOf: (mark) => samples.findIndex((entry) => entry.mark === mark),
		count: (mark) => samples.filter((entry) => entry.mark === mark).length,
		sampleAt: (mark) => samples.find((entry) => entry.mark === mark),
	};
}

function isChildReply(message: AgentMessage, childReplyId: string): boolean {
	return isAgentSessionMessage(message) && message.details.id === childReplyId;
}

function assistantCount(harness: Harness): number {
	return harness.session.messages.filter((message) => message.role === "assistant").length;
}

/** The session's own trigger predicate on the session's own live settings and window. */
function overThreshold(harness: Harness): boolean {
	return shouldCompact(
		estimateContextTokens(harness.session.messages).tokens,
		harness.getModel().contextWindow ?? 0,
		harness.settingsManager.getCompactionSettings(),
	);
}

function thresholdTokens(harness: Harness): number {
	return compactionThresholdTokens(
		harness.getModel().contextWindow ?? 0,
		harness.settingsManager.getCompactionSettings(),
	);
}

function createChildReplyPayload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: {
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionName: "Child",
		},
		fromRelationship: "child",
		target: {
			activeSessionId: "parent-active",
			sessionId: "parent-session",
		},
	};
}

/** The failure the valve pins need, and why it is not a throwing extension hook. */
const SUMMARIZER_FAILURE = "summarizer exploded";

/**
 * A faux responder that fails every summarization request and answers every ordinary
 * turn. The hook cannot stand in for this: a throwing `session_before_compact` handler
 * now fails the compaction before the summarizer is ever called, so the counted failure
 * these valve pins need has to come from the summarization call itself. Matching on the
 * summarization system prompt keeps the turn responses intact however the requests
 * interleave.
 */
function summarizerFailsResponder(answer = "answer") {
	return (context: Context) =>
		context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: SUMMARIZER_FAILURE })
			: fauxAssistantMessage(answer);
}

interface PreflightRecord {
	calls: number;
	success: boolean | undefined;
	queued: boolean | undefined;
	reason: string | undefined;
}

function createPreflightRecord(): PreflightRecord {
	return { calls: 0, success: undefined, queued: undefined, reason: undefined };
}

function capturePreflight(record: PreflightRecord) {
	return (success: boolean, didQueue?: boolean, reason?: string) => {
		record.calls += 1;
		record.success = success;
		record.queued = didQueue === true;
		record.reason = reason;
	};
}

describe("compaction vs. a child reply racing for the parent (symptom B)", () => {
	const harnesses: Harness[] = [];
	const gates: CompactionGate[] = [];
	const floating: Array<Promise<unknown>> = [];

	afterEach(async () => {
		// 防假阳: never leave a gate closed. A held gate would make the floating prompt
		// (and every later assertion) time out, which reads as a failure of the wrong thing.
		while (gates.length > 0) {
			gates.pop()?.release();
		}
		const pending = floating.splice(0, floating.length);
		if (pending.length > 0) {
			await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	interface ParentHarnessOptions {
		/** Park the compaction inside `session_before_compact` (undefined = run through). */
		gate?: CompactionGate;
		/** Fill the context with the big tool result instead of a small one. */
		bigContext: boolean;
		/** Threshold compaction on from the start (pin 2 trips it during the fill turn). */
		compactionEnabled?: boolean;
		priorityOverAgentMessages?: boolean;
		contextWindow?: number;
		reserveTokens?: number;
		keepRecentTokens?: number;
		/**
		 * Size of the fill tool's output. The keepRecent-halving pin needs a transcript
		 * whose estimate is far above its configured keepRecentTokens, or `findCutPoint`
		 * never accumulates enough to cut and `prepareCompaction` returns undefined -
		 * which surfaces as a "too short to compact" skip, and a skip is not a failure.
		 */
		fillChars?: number;
		/**
		 * Whether the `session_before_compact` hook hands back a ready-made summary. The
		 * valve pins must set this false: a hook-supplied compaction never reaches the real
		 * summarizer call, so a failing summarizer response could not fail the compaction.
		 */
		hookSuppliesSummary?: boolean;
		recorder?: HookRecorder;
	}

	async function createParentHarness(options: ParentHarnessOptions): Promise<Harness> {
		const output = options.bigContext
			? `${BIG_MARKER}${"x".repeat(options.fillChars ?? BIG_OUTPUT.length - BIG_MARKER.length)}`
			: SMALL_OUTPUT;
		const fillTool: AgentTool = {
			name: "fill",
			label: "fill",
			description: "returns text",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
		};
		const harness = await createHarness({
			tools: [fillTool],
			settings: {
				compaction: {
					enabled: options.compactionEnabled ?? false,
					reserveTokens: options.reserveTokens ?? RESERVE_TOKENS,
					keepRecentTokens: options.keepRecentTokens ?? KEEP_RECENT_TOKENS,
					triggerRatio: TRIGGER_RATIO,
					...(options.priorityOverAgentMessages === undefined
						? {}
						: { priorityOverAgentMessages: options.priorityOverAgentMessages }),
				},
			},
			models: [{ id: "faux-1", contextWindow: options.contextWindow ?? CONTEXT_WINDOW }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						const recorder = options.recorder;
						if (recorder) {
							recorder.calls += 1;
							recorder.keepRecentTokens.push(event.preparation.keepRecentTokens);
						}
						const gate = options.gate;
						if (gate) {
							gate.markEntered();
							// Bail out on an abort too, so an aborted compaction surfaces as a
							// failed assertion instead of a hung test.
							await Promise.race([
								gate.open,
								new Promise<void>((resolve) => {
									const onAbort = () => resolve();
									if (event.signal.aborted) onAbort();
									else event.signal.addEventListener("abort", onAbort, { once: true });
								}),
							]);
						}
						if (options.hookSuppliesSummary === false) return undefined;
						return {
							compaction: {
								summary: "auto compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	/**
	 * Grow the transcript past the trigger with compaction switched off, then switch it
	 * on: the session lands idle and over threshold, which is the state the boss saw the
	 * red context warning in. The second (small) turn matters - `findCutPoint` will not
	 * summarize away a trailing oversized turn, so without a boundary after the giant
	 * result the first compaction would keep it and shrink nothing.
	 */
	async function fillOverThreshold(harness: Harness, bigContext: boolean): Promise<void> {
		await harness.session.prompt("run the fill tool");
		await harness.session.waitForIdle();
		await harness.session.prompt("note it and move on");
		await harness.session.waitForIdle();
		harness.session.setAutoCompactionEnabled(true);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(bigFillInContext(harness)).toBe(bigContext);
	}

	/** Drive a turn in the background; the caller decides when it may settle. */
	function trackFloating(promise: Promise<unknown>): void {
		floating.push(promise.catch(() => undefined));
	}

	const FILL_RESPONSES = [
		fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("fill noted"),
		fauxAssistantMessage("more noted"),
	];

	it("pin 0: a plain user prompt on the same over-threshold session compacts before its turn", async () => {
		// Positive control for pins 1/3 and the guard the admission gate needs: the
		// direct-prompt path already runs `_runPreTurnCompaction` before it commits the
		// turn, because its policy asks for preTurnCompaction "afterModelSelection". A gate
		// that made agent messages queue behind compaction by breaking THIS path would
		// turn this case red.
		const harness = await createParentHarness({ bigContext: true });
		harness.setResponses([
			...FILL_RESPONSES,
			fauxAssistantMessage("prompt turn answer"),
			fauxAssistantMessage("spare turn"),
		]);
		await fillOverThreshold(harness, true);
		expect(overThreshold(harness)).toBe(true);

		const promptText = "next please";
		const timeline = recordTimeline(
			harness,
			(message) => message.role === "user" && messageText(message) === promptText,
		);
		await harness.session.prompt(promptText);
		await harness.session.waitForIdle();

		const compactionEnd = timeline.indexOf("compaction_end");
		const inputDelivered = timeline.indexOf("input_delivered");
		expect(timeline.count("compaction_start")).toBeGreaterThan(0);
		expect(inputDelivered).toBeGreaterThan(-1);
		expect(compactionEnd).toBeGreaterThan(-1);
		expect(compactionEnd).toBeLessThan(inputDelivered);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.length).toBeGreaterThan(0);
		for (const end of ends) {
			expect(end.aborted).not.toBe(true);
			expect(end.errorMessage).toBeUndefined();
		}
		expect(getAssistantTexts(harness)).toContain("prompt turn answer");
		expect(bigFillInContext(harness)).toBe(false);
	});

	it("pin 1: an idle over-threshold parent compacts before a child steer opens a turn", async () => {
		const harness = await createParentHarness({ bigContext: true });
		harness.setResponses([
			...FILL_RESPONSES,
			fauxAssistantMessage("child reply handled"),
			fauxAssistantMessage("spare turn"),
		]);
		await fillOverThreshold(harness, true);
		expect(overThreshold(harness)).toBe(true);

		const charsBeforeReply = contextChars(harness);
		const childReplyId = "agentmsg_pin1_idle_over_threshold";
		const timeline = recordTimeline(harness, (message) => isChildReply(message, childReplyId));
		const message = createAgentSessionMessage(
			createChildReplyPayload(childReplyId, "child report while you are over threshold"),
		);
		const preflight = createPreflightRecord();

		// No admission pause, no abort, no /compact: exactly the daemon's child-reply call.
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: capturePreflight(preflight),
		});
		await harness.session.waitForIdle();

		expect(preflight.calls).toBe(1);
		expect(preflight.success).toBe(true);
		// Queued because a compaction is owed, not because the session looked busy: the
		// reason is what the sender's receipt prints, so a generic "target_busy" here would
		// tell a child to retry into the same wall.
		expect(preflight.queued).toBe(true);
		expect(preflight.reason).toBe("compaction_pending");

		// Symptom B, first half: the compaction must settle before the reply's turn.
		const compactionEnd = timeline.indexOf("compaction_end");
		const replyDelivered = timeline.indexOf("input_delivered");
		expect(timeline.count("compaction_start")).toBeGreaterThan(0);
		expect(replyDelivered).toBeGreaterThan(-1);
		expect(compactionEnd).toBeGreaterThan(-1);
		expect(compactionEnd).toBeLessThan(replyDelivered);

		// Symptom B, second half: the reply is not lost and not duplicated by the wait.
		expect(timeline.count("input_delivered")).toBe(1);
		expect(harness.session.messages.filter((item) => isChildReply(item, childReplyId))).toHaveLength(1);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(getAssistantTexts(harness)).toContain("child reply handled");

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds.length).toBeGreaterThan(0);
		for (const end of compactionEnds) {
			expect(end.aborted).not.toBe(true);
			expect(end.errorMessage).toBeUndefined();
		}
		// The compaction really restructured the context: the giant fill is gone.
		expect(bigFillInContext(harness)).toBe(false);
		expect(contextChars(harness)).toBeLessThan(charsBeforeReply);
	});

	it("pin 2: a child steer arriving while the compaction is in flight only queues", async () => {
		const gate = createCompactionGate();
		gates.push(gate);
		// Compaction is on from the start here, so the fill turn's own agent_end trips the
		// threshold and the gate holds that compaction open: this is the in-flight window
		// the child reply lands in. It is deliberately not a prompt-triggered compaction,
		// which would hold the direct-turn admission fence and block the reply's admission
		// instead of queueing it.
		const harness = await createParentHarness({ bigContext: true, gate, compactionEnabled: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed after compaction"),
			fauxAssistantMessage("second turn after compaction"),
			fauxAssistantMessage("child reply handled"),
			fauxAssistantMessage("spare turn"),
		]);

		// prompt() only settles after the compaction (and its continuation), so it is
		// driven in the background and awaited once the gate is open again.
		const promptRun = harness.session.prompt("run the fill tool");
		trackFloating(promptRun);

		await vi.waitFor(() => expect(gate.enteredCount()).toBe(1), { timeout: 20_000, interval: 10 });
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		// 防假阳: the in-flight window really is open - the compaction has not ended.
		expect(harness.eventsOfType("compaction_end")).toEqual([]);
		expect(overThreshold(harness)).toBe(true);

		const assistantsBeforeReply = assistantCount(harness);
		const childReplyId = "agentmsg_pin2_in_flight";
		const message = createAgentSessionMessage(
			createChildReplyPayload(childReplyId, "child report while you compact"),
		);
		const preflight = createPreflightRecord();
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: capturePreflight(preflight),
		});

		// The reply queues; it opens no turn and does not touch the compaction.
		await vi.waitFor(() => expect(preflight.calls).toBe(1), { timeout: 5_000, interval: 10 });
		expect(preflight.success).toBe(true);
		expect(preflight.queued).toBe(true);
		expect(harness.session.isStreaming).toBe(false);
		expect(assistantCount(harness)).toBe(assistantsBeforeReply);
		expect(harness.session.getSteeringMessages()).toEqual([message.content]);
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.eventsOfType("compaction_end")).toEqual([]);

		gate.release();
		await promptRun;
		await harness.session.waitForIdle();

		// The compaction survived the reply: not aborted, and it produced its summary.
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.length).toBeGreaterThan(0);
		for (const end of ends) {
			expect(end.aborted).not.toBe(true);
			expect(end.errorMessage).toBeUndefined();
			expect(end.result?.summary).toBe("auto compacted");
		}
		// The compaction committed, and the event agrees with the persisted entry about
		// what was kept. Deliberately NOT asserted here: that the context got smaller.
		// `findCutPoint` cannot cut inside a tool pair, so the first cut keeps the
		// oversized trailing turn and a "tokensBefore > final estimate" comparison does not
		// hold for this fixture (measured 12421 vs 12622 - the tail turns added more than
		// the cut removed). Shrinking is pinned where the fill really leaves the context:
		// pin 3 (summarized away) and pin 5 (dropped by the valve).
		const compactionEntries = harness.sessionManager
			.getBranch()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactionEntries.length).toBeGreaterThan(0);
		expect(compactionEntries[0]?.summary).toBe("auto compacted");
		expect(ends[0]?.result?.firstKeptEntryId).toBe(compactionEntries[0]?.firstKeptEntryId);

		// ...and the queued reply was delivered once the compaction settled.
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.messages.filter((item) => isChildReply(item, childReplyId))).toHaveLength(1);
		expect(assistantCount(harness)).toBeGreaterThan(assistantsBeforeReply);
		// The reply reached the model: an assistant message follows it in the transcript.
		// Which response text landed there is NOT asserted, because the post-compaction
		// continuation and the delivered reply can share one run - `agent.continue()` sends
		// the whole transcript, the child message included, so the next queued answer
		// replies to both (observed: one run, the reply committed before its answer).
		const messagesAfterSettle = harness.session.messages;
		const replyIndex = messagesAfterSettle.findIndex((item) => isChildReply(item, childReplyId));
		expect(replyIndex).toBeGreaterThan(-1);
		expect(messagesAfterSettle.slice(replyIndex + 1).some((item) => item.role === "assistant")).toBe(true);
		expect(harness.getPendingResponseCount()).toBeGreaterThan(0);
	});

	it("pin 3: the compaction runs on its own (no admission pause) and the reply's turn sees the compacted context", async () => {
		// Deliberately no acquireSessionInputPause / no agent-message pause anywhere in
		// this case: the boss had to kill agent-message admission by hand to get the
		// compaction to run. Under the old ranking this case is red twice over - the
		// reply opens its turn first, and the model request carrying it still sees the
		// oversized context.
		const harness = await createParentHarness({ bigContext: true });
		harness.setResponses([
			...FILL_RESPONSES,
			fauxAssistantMessage("child reply handled"),
			fauxAssistantMessage("spare turn"),
		]);
		await fillOverThreshold(harness, true);
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
		expect(overThreshold(harness)).toBe(true);
		const charsBeforeReply = contextChars(harness);

		const childReplyId = "agentmsg_pin3_no_pause";
		const timeline = recordTimeline(harness, (message) => isChildReply(message, childReplyId));
		const message = createAgentSessionMessage(
			createChildReplyPayload(childReplyId, "child report, no pause in sight"),
		);
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
		});
		await harness.session.waitForIdle();

		// Nothing was paused by the test, so the compaction had to come from the session.
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
		expect(timeline.count("compaction_start")).toBeGreaterThan(0);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.length).toBeGreaterThan(0);
		for (const end of ends) {
			expect(end.aborted).not.toBe(true);
			expect(end.errorMessage).toBeUndefined();
		}

		// The point of the pin: the turn that carried the child's reply ran on a context
		// whose oversized fill was already summarized away.
		const atReply = timeline.sampleAt("input_delivered");
		expect(atReply).toBeDefined();
		expect(atReply?.bigFillInContext).toBe(false);
		expect(atReply?.contextChars ?? Number.MAX_SAFE_INTEGER).toBeLessThan(charsBeforeReply);
		expect(harness.session.messages.filter((item) => isChildReply(item, childReplyId))).toHaveLength(1);
		expect(bigFillInContext(harness)).toBe(false);
	});

	it("pin 4: from the first retry on, every failed compaction halves keepRecentTokens down to the floor", async () => {
		// The retry valve: a summarization request that keeps failing is usually too big
		// for the provider's input limit, so each retry carries a smaller retained tail
		// (`shrunkKeepRecentTokens`, counted by `_registerCompactionFailure`). Driven
		// through the manual path on purpose - it shares `_performCompaction` and the same
		// consecutive-failure counter, and it keeps the threshold loop (and its cooldown)
		// out of the sequence, so attempt N runs with N-1 failures on the counter.
		//
		// The fill has to be far larger than the configured keepRecentTokens: on a
		// transcript whose estimate never reaches the budget, `findCutPoint` accumulates
		// nothing, `prepareCompaction` returns undefined and the attempt ends as a "too
		// short to compact" skip - which by design does not count as a failure.
		const recorder = createHookRecorder();
		const harness = await createParentHarness({
			bigContext: true,
			fillChars: 400_000,
			contextWindow: VALVE_CONTEXT_WINDOW,
			reserveTokens: VALVE_RESERVE_TOKENS,
			keepRecentTokens: VALVE_KEEP_RECENT_TOKENS,
			hookSuppliesSummary: false,
			recorder,
		});
		const responder4 = summarizerFailsResponder("answer");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 23 }, () => responder4),
		]);
		// Compaction stays disabled: every attempt below is an explicit compact(), so the
		// recorded sequence cannot be polluted by a threshold compaction.
		await harness.session.prompt("run the fill tool");
		await harness.session.waitForIdle();
		await harness.session.prompt("note it and move on");
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(recorder.calls).toBe(0);
		// 防假阳 for the whole pin: the transcript really is bigger than the retained-tail
		// budget, so a skip cannot masquerade as a failure and the sequence below cannot
		// pass on a session that never reached the hook.
		expect(estimateContextTokens(harness.session.messages).tokens).toBeGreaterThan(VALVE_KEEP_RECENT_TOKENS);

		for (let attempt = 0; attempt < EXPECTED_KEEP_RECENT_SEQUENCE.length; attempt++) {
			// A failed manual compact throws; the throw is the expected outcome here, and
			// the compaction_end event below is what says it failed for the right reason.
			await harness.session.compact().then(
				() => undefined,
				() => undefined,
			);
		}

		expect(recorder.calls).toBe(EXPECTED_KEEP_RECENT_SEQUENCE.length);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(EXPECTED_KEEP_RECENT_SEQUENCE.length);
		for (const end of ends) {
			expect(end.reason).toBe("manual");
			expect(end.aborted).not.toBe(true);
			expect(end.result).toBeUndefined();
			expect(end.errorMessage).toContain(SUMMARIZER_FAILURE);
		}
		// The window is big enough for the configured budget to survive the cap, so the
		// sequence is about the halving and not about `capKeepRecentTokens`.
		expect(recorder.keepRecentTokens[0]).toBe(VALVE_KEEP_RECENT_TOKENS);
		expect(recorder.keepRecentTokens).toEqual(EXPECTED_KEEP_RECENT_SEQUENCE);
		// These four attempts summarized nothing themselves. The fourth failure may hand the
		// session to the lossy valve - that is pin 5's subject - so the only claim here is
		// that no ordinary summary was committed behind the failures.
		const committed = harness.sessionManager
			.getBranch()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(committed.every((entry) => (entry.summary ?? "").startsWith(EMERGENCY_SHRINK_HEADLINE))).toBe(true);
	});

	it(`pin 5: after ${EMERGENCY_SHRINK_FAILURES} consecutive failures the lossy valve drops the oldest context and says so loudly`, async () => {
		// The last-resort valve: the context is over the trigger, every summarization
		// fails, so every further request is headed for the provider's input wall and the
		// session cannot recover by itself. `_runEmergencyContextShrink` drops the oldest
		// NON-summary context and must name the loss in the summary the model reads and in
		// a persisted compaction-outcome notice - never silently. Driven through the
		// threshold path because that is the field shape (the valve is also reachable from
		// `_compact`'s catch, which pins nothing new).
		const recorder = createHookRecorder();
		const harness = await createParentHarness({
			bigContext: true,
			compactionEnabled: true,
			hookSuppliesSummary: false,
			recorder,
		});
		// Request 1 is the fill turn; every later request goes through the responder, which
		// fails summarization and answers turns, so the interleaving of pre-turn and
		// agent_end compaction attempts cannot desynchronize the queue.
		const responder = summarizerFailsResponder("answer");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			// Generous: each turn can spend up to three requests (pre-turn compaction,
			// the turn itself, agent_end compaction), and the loop below is bounded at 40.
			...Array.from({ length: 239 }, () => responder),
		]);

		const diag: string[] = ["turn\tbranch\tstarts\tends\thookCalls\tpending\tfillInCtx\tends detail"];
		const row = (turn: string) => {
			const ends = harness.eventsOfType("compaction_end");
			diag.push(
				[
					turn,
					harness.sessionManager.getBranch().length,
					harness.eventsOfType("compaction_start").length,
					ends.length,
					recorder.calls,
					harness.getPendingResponseCount(),
					bigFillInContext(harness),
					ends
						.map((end) =>
							[
								end.reason,
								end.aborted
									? "aborted"
									: end.result
										? "ok"
										: end.errorMessage
											? `err(${end.errorMessage.slice(0, 70)})`
											: "no-result",
							].join(":"),
						)
						.join(" | "),
				].join("\t"),
			);
		};

		// Turn 0 carries the fill. Compaction is enabled, but the context is still small
		// when the turn is admitted, so the first failing attempt lands at its agent_end.
		await harness.session.prompt("run the fill tool");
		await harness.session.waitForIdle();
		row("fill");
		// The valve's precondition, and the positive control for claim (3) below: the
		// oldest context is in the model's view now, and over the trigger.
		expect(bigFillInContext(harness)).toBe(true);
		expect(overThreshold(harness)).toBe(true);

		const turns = ["fill"];
		// 40 turns of headroom: a failure arms a cooldown that only lifts once the branch
		// grows by THRESHOLD_COMPACTION_RETRY_MIN_NEW_ENTRIES (5), and a turn adds ~2-3
		// entries, so four failures cost roughly a dozen turns. The turn count actually
		// used lands in the diagnostic table.
		for (let turn = 1; turn < 40 && recorder.calls < EMERGENCY_SHRINK_FAILURES; turn++) {
			const text = `keep going ${turn}`;
			turns.push(text);
			await harness.session.prompt(text);
			await harness.session.waitForIdle();
			row(String(turn));
		}
		// Diagnostic table on demand (COMPACTION_PIN5_DIAG=1): turns used, branch growth,
		// compaction starts/ends with their outcome, hook calls, pending responses.
		if (process.env.COMPACTION_PIN5_DIAG) writeFileSync("/tmp/pin5-diag.tsv", `${diag.join("\n")}\n`);

		// The loop stopped on the failure count, not on its 40-turn bound. Observed: four
		// failures inside three turns - an overflow-recovery attempt counts as a failure
		// too, so the threshold cooldown does not space them out as much as it looks.
		expect(turns.length).toBeGreaterThan(1);
		expect(turns.length).toBeLessThan(40);
		// 防假阳: the failures really accumulated, counted at the hook (a skip never reaches
		// it and never counts). Without this the claims below could pass on a session that
		// never compacted at all.
		expect(recorder.calls).toBeGreaterThanOrEqual(EMERGENCY_SHRINK_FAILURES);
		const failedEnds = harness
			.eventsOfType("compaction_end")
			.filter((end) => !end.aborted && end.errorMessage !== undefined);
		expect(failedEnds.length).toBeGreaterThan(0);

		// (1) The replacement summary is a real compaction entry and leads with the loss.
		const emergencyEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CompactionEntry =>
					entry.type === "compaction" && (entry.summary ?? "").startsWith(EMERGENCY_SHRINK_HEADLINE),
			);
		expect(emergencyEntries).toHaveLength(1);
		const summary = emergencyEntries[0]?.summary ?? "";
		expect(summary).toContain("NOT deleted");
		expect(summary).toMatch(/dropped the oldest \d+ context entries \(~\d+ tokens/);

		// (2) The persisted notice says the same thing where the user reads it.
		const notices = harness.session.messages.filter(isCompactionOutcomeMessage);
		const emergencyNotice = notices.find((notice) => notice.content.startsWith(EMERGENCY_SHRINK_HEADLINE));
		expect(emergencyNotice).toBeDefined();
		expect(emergencyNotice?.content).toContain(SUMMARIZER_FAILURE);
		expect(emergencyNotice?.content).toMatch(/oldest \d+ context entries \(~\d+ tokens/);
		expect(emergencyNotice?.content).toContain("Nothing was deleted");

		// (3) The core positive control: what the valve drops is the OLDEST context - the
		// fill from turn 0, which was in the model's view above. It leaves the context but
		// stays on disk, reachable by /export, /tree and /fork.
		expect(bigFillInContext(harness)).toBe(false);
		const onDisk = JSON.stringify(harness.sessionManager.getEntries());
		expect(onDisk).toContain(BIG_MARKER);
		expect(onDisk).toContain("run the fill tool");

		// (4) The shrink lands under the emergency target - or the notice says it could not.
		const target = thresholdTokens(harness) * EMERGENCY_SHRINK_TARGET_RATIO;
		const estimate = estimateContextTokens(harness.session.messages).tokens;
		const noticeAdmitsMiss = /could not reach/i.test(emergencyNotice?.content ?? "");
		expect(estimate < target || noticeAdmitsMiss).toBe(true);
		// A shrink that reached its target must also take the session back under the
		// trigger, or the next turn re-fires the same failing compaction. When the notice
		// admits the miss, staying over the trigger is the documented outcome.
		expect(overThreshold(harness)).toBe(noticeAdmitsMiss);
	});

	it("control: the same child steer is admitted at once when nothing is in flight (pin 2's queued=true is not vacuous)", async () => {
		// 防假阴 for pin 2: same session shape, same call, same customMessage shape, same
		// gate wired in - only the oversized context (and with it the in-flight
		// compaction) is missing. If this case also reported queued === true, pin 2's
		// central assertion would be true by construction.
		const gate = createCompactionGate();
		gates.push(gate);
		const harness = await createParentHarness({ bigContext: false, gate, compactionEnabled: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fill noted"),
			fauxAssistantMessage("child reply handled"),
		]);
		await harness.session.prompt("run the fill tool");
		await harness.session.waitForIdle();

		// Under threshold, so nothing ever armed the gate or started a compaction.
		expect(gate.enteredCount()).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(overThreshold(harness)).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isStreaming).toBe(false);

		const childReplyId = "agentmsg_control_idle";
		const timeline = recordTimeline(harness, (message) => isChildReply(message, childReplyId));
		const message = createAgentSessionMessage(
			createChildReplyPayload(childReplyId, "child report to an idle parent"),
		);
		const preflight = createPreflightRecord();
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: capturePreflight(preflight),
		});
		await vi.waitFor(() => expect(preflight.calls).toBe(1), { timeout: 5_000, interval: 10 });
		expect(preflight.success).toBe(true);
		expect(preflight.queued).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual([]);

		await harness.session.waitForIdle();
		expect(timeline.count("input_delivered")).toBe(1);
		expect(getAssistantTexts(harness)).toContain("child reply handled");
		expect(timeline.count("compaction_start")).toBe(0);
	});

	it("control: priorityOverAgentMessages=false restores the old ranking (pins 1/3 are not vacuous)", async () => {
		// 防假阴 for pins 1 and 3: with the documented escape hatch set to the old
		// behaviour, the very same steer must open its turn BEFORE any compaction and
		// must see the oversized context. Without a case that can produce the opposite
		// ordering, "compaction_end before input_delivered" would be a tautology.
		const harness = await createParentHarness({ bigContext: true, priorityOverAgentMessages: false });
		harness.setResponses([
			...FILL_RESPONSES,
			fauxAssistantMessage("child reply handled"),
			fauxAssistantMessage("spare turn"),
		]);
		await fillOverThreshold(harness, true);
		expect(overThreshold(harness)).toBe(true);
		expect(harness.settingsManager.getCompactionPriorityOverAgentMessages()).toBe(false);

		const childReplyId = "agentmsg_control_flag_off";
		const timeline = recordTimeline(harness, (message) => isChildReply(message, childReplyId));
		const message = createAgentSessionMessage(
			createChildReplyPayload(childReplyId, "child report with the old ranking"),
		);
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
		});
		await harness.session.waitForIdle();

		const replyDelivered = timeline.indexOf("input_delivered");
		const compactionStart = timeline.indexOf("compaction_start");
		expect(replyDelivered).toBeGreaterThan(-1);
		expect(compactionStart).toBeGreaterThan(replyDelivered);
		expect(timeline.sampleAt("input_delivered")?.bigFillInContext).toBe(true);
		expect(getAssistantTexts(harness)).toContain("child reply handled");
	});
});
