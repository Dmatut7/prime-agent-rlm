import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import type { AgentStatus } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	type AgentStatusResult,
	buildStatusContext,
	DaemonSessionSummarizer,
	parseAgentStatusResponse,
	SUMMARY_RETRY_LIMIT,
	SWEEP_CONCURRENCY,
} from "../src/modes/daemon/daemon-session-summarizer.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantMessage(text: string, tools: string[] = []): AgentMessage {
	const content = [{ type: "text", text }, ...tools.map((name) => ({ type: "tool_use", name, id: name, input: {} }))];
	return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

function assistantError(errorMessage?: string): AgentMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: 0,
	} as unknown as AgentMessage;
}

describe("daemon session summarizer", () => {
	describe("parseAgentStatusResponse", () => {
		test("parses recap and completion verdict for an idle session", () => {
			const result = parseAgentStatusResponse(
				"<recap>Added the API reference page</recap>\n<status>COMPLETED</status>",
				false,
			);
			expect(result).toEqual({ summary: "Added the API reference page", taskState: "completed" });
		});

		test("maps NEEDS_INPUT for idle sessions", () => {
			const result = parseAgentStatusResponse(
				"<recap>Asked which database to target</recap>\n<status>NEEDS_INPUT</status>",
				false,
			);
			expect(result?.taskState).toBe("needs_input");
		});

		test("omits the verdict while working and ignores any status tag", () => {
			const result = parseAgentStatusResponse(
				"<recap>Refactoring token validation</recap>\n<status>COMPLETED</status>",
				true,
			);
			expect(result).toEqual({ summary: "Refactoring token validation" });
		});

		test("falls back to needs_input on a missing or unrecognized idle verdict", () => {
			expect(
				parseAgentStatusResponse("<recap>Doing something</recap>\n<status>MAYBE</status>", false)?.taskState,
			).toBe("needs_input");
			expect(parseAgentStatusResponse("<recap>Doing something</recap>", false)?.taskState).toBe("needs_input");
		});

		test("ignores narration outside the tags and never leaks free-form text", () => {
			// A chatty/reasoning model that narrates instead of using tags yields no recap.
			expect(parseAgentStatusResponse("Investigating the failing test.", true)).toBeUndefined();
			expect(
				parseAgentStatusResponse(
					"Recap: . So: <recap>Curating a niche list of Muon optimizer papers</recap>",
					true,
				),
			).toEqual({ summary: "Curating a niche list of Muon optimizer papers" });
		});

		test("ignores reasoning prose around the tags", () => {
			const text =
				"Let me decide. The agent finished editing.\n<recap>Updated the login handler</recap>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(text, false)).toEqual({
				summary: "Updated the login handler",
				taskState: "completed",
			});
		});

		test("rejects an echoed prompt template", () => {
			const echoed =
				"<recap>a present-tense clause, at most 12 words, no trailing period</recap>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(echoed, true)).toBeUndefined();
		});

		test("returns undefined when no recap tag is present", () => {
			expect(parseAgentStatusResponse("", false)).toBeUndefined();
			expect(parseAgentStatusResponse("<status>COMPLETED</status>", false)).toBeUndefined();
		});

		test("drops chain-of-thought that falls outside the closing recap tag", () => {
			const text =
				"<recap>Sending SSH auth retry to tcg-autoresearch-rl</recap> That's 5 words? Count: Sending(1) SSH(2) = 6 words.\n<status>NEEDS_INPUT</status>";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Sending SSH auth retry to tcg-autoresearch-rl",
			});
		});

		test("rejects a recap body that is nothing but counting artifacts", () => {
			expect(parseAgentStatusResponse("<recap>(1) word(2) count(3) = 3 words</recap>", true)).toBeUndefined();
		});

		test("rejects a rambling recap that blows past the word ceiling", () => {
			const text =
				"<recap>this is a very long rambling sentence that just keeps going and going well past any reasonable recap length</recap>";
			expect(parseAgentStatusResponse(text, true)).toBeUndefined();
		});

		test("strips wrapping quotes the model adds around the recap", () => {
			const text = '<recap>"Wiring the recap line"</recap>\n<status>COMPLETED</status>';
			expect(parseAgentStatusResponse(text, false)).toEqual({
				summary: "Wiring the recap line",
				taskState: "completed",
			});
		});

		test("ignores an open recap tag with no close", () => {
			expect(
				parseAgentStatusResponse("<recap>Editing the parser\n<status>NEEDS_INPUT</status>", true),
			).toBeUndefined();
		});

		test("takes the last recap tag when a draft is corrected", () => {
			const text = "<recap>Draft recap</recap>\n<recap>Final corrected recap</recap>";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Final corrected recap" });
		});

		test("takes the last status tag when a draft is corrected", () => {
			const text = "<recap>Editing the parser</recap>\n<status>NEEDS_INPUT</status>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(text, false)?.taskState).toBe("completed");
		});

		test("normalizes unicode angle-bracket lookalikes around the tags", () => {
			// The model sometimes emits › ‹ instead of > < ; normalize so the tag still parses.
			const text = "‹recap›Curating a niche list of Muon optimizer papers‹/recap›";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Curating a niche list of Muon optimizer papers",
			});
		});
	});

	describe("buildStatusContext", () => {
		test("includes the agent state and the trailing conversation with tool names", () => {
			const context = buildStatusContext(
				[userMessage("add a login endpoint"), assistantMessage("Editing the router", ["Edit", "Bash"])],
				true,
			);
			expect(context).toContain("<agent-state>working</agent-state>");
			expect(context).toContain("user: add a login endpoint");
			expect(context).toContain("assistant: Editing the router [tools: Edit, Bash]");
		});

		test("marks idle sessions as finished", () => {
			expect(buildStatusContext([userMessage("hi")], false)).toContain("idle (finished its turn)");
		});

		test("only keeps the most recent messages", () => {
			const messages = Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`));
			const context = buildStatusContext(messages, false);
			expect(context).toContain("message 19");
			expect(context).not.toContain("message 0\n");
		});
	});

	describe("status change notification", () => {
		function makeState(options: {
			messages: AgentMessage[];
			isSessionActive: boolean;
			summaryState?: AgentStatus;
		}): ActiveSessionState {
			return {
				activeSessionId: "active-1",
				summaryState: options.summaryState,
				runtime: {
					session: {
						isSessionActive: options.isSessionActive,
						messages: options.messages,
						modelRegistry: {},
						state: { streamingMessage: undefined },
						sessionManager: { appendAgentStatus: () => {} },
					},
				},
			} as unknown as ActiveSessionState;
		}

		async function settle(state: ActiveSessionState, generated: { summary: string; taskState?: "needs_input" }) {
			const onStatusChanged = vi.fn();
			const summarizer = new DaemonSessionSummarizer(
				() => [state],
				onStatusChanged,
				async () => generated,
			);
			await (summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> }).summarize(state);
			return onStatusChanged;
		}

		test("an idle settle with unchanged verdict text still notifies: its currency drives the roster", async () => {
			const previous: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 1 };
			const state = makeState({
				messages: [userMessage("hi"), userMessage("more")],
				isSessionActive: false,
				summaryState: previous,
			});

			const onStatusChanged = await settle(state, { summary: "Working on it", taskState: "needs_input" });

			expect(state.summaryState?.basedOnMessageCount).toBe(2);
			expect(onStatusChanged).toHaveBeenCalledOnce();
		});

		test("a working refresh with unchanged text stays quiet (control for the ladder below)", async () => {
			const previous: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 2 };
			const state = makeState({
				messages: [userMessage("hi"), userMessage("more")],
				isSessionActive: true,
				summaryState: previous,
			});

			const onStatusChanged = await settle(state, { summary: "Working on it" });

			expect(onStatusChanged).not.toHaveBeenCalled();
		});
	});

	describe("summary generation failure ladder", () => {
		function makeLadderState(index: number, appendAgentStatus = vi.fn()): ActiveSessionState {
			return {
				activeSessionId: `active-ladder-${index}`,
				summaryState: undefined,
				runtime: {
					session: {
						isSessionActive: false,
						messages: [userMessage("hi")],
						modelRegistry: {},
						state: { streamingMessage: undefined },
						sessionManager: { appendAgentStatus },
					},
				},
			} as unknown as ActiveSessionState;
		}

		function summarizerFor(
			states: readonly ActiveSessionState[],
			generate: () => Promise<{ summary: string; taskState?: "needs_input" } | undefined>,
		) {
			const summarizer = new DaemonSessionSummarizer(() => states, undefined, generate);
			return {
				summarizer,
				summarize: (state: ActiveSessionState) =>
					(summarizer as unknown as { summarize(target: ActiveSessionState): Promise<void> }).summarize(state),
			};
		}

		test("backs off a session whose summary model keeps failing instead of calling it every sweep", async () => {
			const state = makeLadderState(1);
			const generate = vi.fn(async () => undefined);
			const { summarizer, summarize } = summarizerFor([state], generate);
			try {
				await summarize(state);
				expect(generate).toHaveBeenCalledTimes(1);

				// Every later sweep inside the window owes the same summary and used to
				// re-call the model for unchanged content, forever, every 25s.
				await summarize(state);
				await summarize(state);
				expect(generate).toHaveBeenCalledTimes(1);

				// A finished turn is new information and re-arms the session at once.
				summarizer.notifyActivity(state);
				await summarize(state);
				expect(generate).toHaveBeenCalledTimes(2);
			} finally {
				summarizer.stop();
			}
		});

		test("gives up after the retry limit and stays given up until the next turn", async () => {
			vi.useFakeTimers();
			try {
				const state = makeLadderState(2);
				const generate = vi.fn(async () => undefined);
				const { summarizer, summarize } = summarizerFor([state], generate);
				try {
					for (let attempt = 0; attempt < SUMMARY_RETRY_LIMIT + 3; attempt++) {
						await summarize(state);
						// Past the longest rung of the ladder, so only the limit can stop it.
						await vi.advanceTimersByTimeAsync(60 * 60_000);
					}
					expect(generate).toHaveBeenCalledTimes(SUMMARY_RETRY_LIMIT);

					// Still given up an arbitrarily long time later...
					await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
					await summarize(state);
					expect(generate).toHaveBeenCalledTimes(SUMMARY_RETRY_LIMIT);

					// ...until the session actually does something.
					summarizer.notifyActivity(state);
					await summarize(state);
					expect(generate).toHaveBeenCalledTimes(SUMMARY_RETRY_LIMIT + 1);
				} finally {
					summarizer.stop();
				}
			} finally {
				vi.useRealTimers();
			}
		});

		test("settles an unjudged idle session in memory without persisting a verdict the model never gave", async () => {
			const appendAgentStatus = vi.fn();
			const state = makeLadderState(3, appendAgentStatus);
			const failing = summarizerFor([state], async () => undefined);
			try {
				await failing.summarize(state);

				// The roster's activity axis still gets its settle, so an unjudged idle
				// session does not spin at "working"...
				expect(state.summaryState?.taskState).toBe("needs_input");
				expect(state.summaryState?.summary).toBe("");
				// ...but the fabricated verdict is not written into the transcript, where
				// seed() would read it back after a restart as "this session needs input".
				expect(appendAgentStatus).not.toHaveBeenCalled();
			} finally {
				failing.summarizer.stop();
			}

			// Positive control: a verdict the model really gave is persisted.
			const persistedState = makeLadderState(4, appendAgentStatus);
			const answering = summarizerFor([persistedState], async () => ({
				summary: "Asked which database to target",
				taskState: "needs_input",
			}));
			try {
				await answering.summarize(persistedState);
				expect(appendAgentStatus).toHaveBeenCalledOnce();
				expect(persistedState.summaryState?.summary).toBe("Asked which database to target");
			} finally {
				answering.summarizer.stop();
			}
		});

		test("bounds how many sessions one sweep calls at once", async () => {
			vi.useFakeTimers();
			try {
				const states = Array.from({ length: SWEEP_CONCURRENCY * 2 + 1 }, (_, index) => makeLadderState(index));
				let inFlight = 0;
				let peak = 0;
				const generate = vi.fn(
					() =>
						new Promise<undefined>((resolveGenerate) => {
							inFlight++;
							peak = Math.max(peak, inFlight);
							setTimeout(() => {
								inFlight--;
								resolveGenerate(undefined);
							}, 5);
						}),
				);
				const summarizer = new DaemonSessionSummarizer(() => states, undefined, generate);
				summarizer.start();
				try {
					// One sweep interval, plus enough time for every rung to finish.
					await vi.advanceTimersByTimeAsync(25_000 + 10_000);
					expect(generate).toHaveBeenCalledTimes(states.length);
					expect(peak).toBeGreaterThan(1);
					expect(peak).toBeLessThanOrEqual(SWEEP_CONCURRENCY);
				} finally {
					summarizer.stop();
				}
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("errored turn verdicts", () => {
		const providerError = "400 enable_thinking is not supported for this model";

		function erroredTranscript(errorMessage?: string): AgentMessage[] {
			return [userMessage("write a session marker and verify the file content"), assistantError(errorMessage)];
		}

		// A journal-backed state: getLatestAgentStatus returns what appends recorded,
		// falling back to a verdict that predates this run (e.g. written before a
		// daemon restart).
		function erroredState(options: {
			messages: AgentMessage[];
			isSessionActive?: boolean;
			persistedStatus?: AgentStatus;
		}): {
			state: ActiveSessionState;
			appended: AgentStatus[];
		} {
			const appended: AgentStatus[] = [];
			const state = {
				activeSessionId: "active-error",
				summaryState: undefined,
				runtime: {
					session: {
						isSessionActive: options.isSessionActive ?? false,
						messages: options.messages,
						modelRegistry: {},
						state: { streamingMessage: undefined },
						sessionManager: {
							appendAgentStatus: (status: AgentStatus) => {
								appended.push(status);
							},
							getLatestAgentStatus: () => appended.at(-1) ?? options.persistedStatus,
						},
					},
				},
			} as unknown as ActiveSessionState;
			return { state, appended };
		}

		async function runSummarize(
			state: ActiveSessionState,
			generate: () => Promise<AgentStatusResult | undefined>,
		): Promise<ReturnType<typeof vi.fn>> {
			const onStatusChanged = vi.fn();
			const summarizer = new DaemonSessionSummarizer(() => [state], onStatusChanged, generate);
			await (summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> }).summarize(state);
			return onStatusChanged;
		}

		test("an errored session persists the real error as its verdict, never a completed one", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			// The classifier would only see the task text and invent completed work.
			const generate = vi.fn(async () => ({
				summary: "Writing session marker and verifying file content",
				taskState: "completed" as const,
			}));

			const onStatusChanged = await runSummarize(state, generate);

			expect(generate).not.toHaveBeenCalled();
			expect(state.summaryState).toEqual({
				summary: `Model request failed: ${providerError}`,
				taskState: "error",
				basedOnMessageCount: 2,
			});
			expect(appended).toEqual([
				{ summary: `Model request failed: ${providerError}`, taskState: "error", basedOnMessageCount: 2 },
			]);
			expect(onStatusChanged).toHaveBeenCalledOnce();
		});

		test("repeated sweeps over an unchanged errored transcript append nothing more", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, vi.fn());
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state);
			await internal.summarize(state);
			await internal.summarize(state);

			expect(appended).toHaveLength(1);
		});

		test("a restart-seeded completed verdict for an errored transcript is repaired by the sweep", async () => {
			// Pre-fix code fabricated a completed verdict for the errored transcript
			// and the journal kept it; a daemon restart seeds it back before the
			// first sweep. The unchanged-content fast path must not skip the repair.
			const persisted: AgentStatus = {
				summary: "Writing session marker and verifying file content",
				taskState: "completed",
				basedOnMessageCount: 2,
			};
			const { state, appended } = erroredState({
				messages: erroredTranscript(providerError),
				persistedStatus: persisted,
			});
			const generate = vi.fn(async () => ({ summary: "unreached", taskState: "completed" as const }));
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
			// Daemon-mode bind() restores the persisted verdict on restart.
			summarizer.seed(state);
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state);

			expect(generate).not.toHaveBeenCalled();
			expect(state.summaryState).toEqual({
				summary: `Model request failed: ${providerError}`,
				taskState: "error",
				basedOnMessageCount: 2,
			});
			expect(appended).toEqual([
				{ summary: `Model request failed: ${providerError}`, taskState: "error", basedOnMessageCount: 2 },
			]);

			// Repaired once: later sweeps append nothing more.
			await internal.summarize(state);
			await internal.summarize(state);
			expect(appended).toHaveLength(1);
		});

		test("an errored turn without an error message still settles to the error verdict", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(undefined) });

			await runSummarize(state, async () => undefined);

			expect(state.summaryState).toMatchObject({ summary: "Model request failed", taskState: "error" });
			expect(appended).toHaveLength(1);
		});

		test("a successful final answer after an error earns a normal model verdict", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			const generate = vi.fn(async () => ({ summary: "Wrote the marker file", taskState: "completed" as const }));
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state); // error verdict settles first
			expect(state.summaryState?.taskState).toBe("error");

			// The user retries and the turn succeeds: the classifier may judge again.
			(state.runtime.session as unknown as { messages: AgentMessage[] }).messages = [
				...erroredTranscript(providerError),
				userMessage("retry the marker task"),
				assistantMessage("Wrote .session-marker and verified its content"),
			];
			await internal.summarize(state);

			expect(generate).toHaveBeenCalledTimes(1);
			expect(state.summaryState).toMatchObject({ summary: "Wrote the marker file", taskState: "completed" });
			expect(appended.at(-1)).toMatchObject({ taskState: "completed" });
		});

		test("a working session is never error-settled, even with an errored trailing assistant message", async () => {
			// While working (e.g. mid-retry) the model refresh keeps recapping;
			// verdicts settle only when the session goes idle.
			const { state, appended } = erroredState({
				messages: erroredTranscript(providerError),
				isSessionActive: true,
			});
			const generate = vi.fn(async () => ({ summary: "Retrying the failed request" }));

			await runSummarize(state, generate);

			expect(generate).toHaveBeenCalledOnce();
			expect(state.summaryState).toEqual({
				summary: "Retrying the failed request",
				taskState: undefined,
				basedOnMessageCount: 2,
			});
			expect(appended).toHaveLength(0);
		});
	});
});
