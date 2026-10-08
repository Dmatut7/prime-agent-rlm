import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentStatus } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	DaemonSessionSummarizer,
	isErrorRecap,
	parseAgentStatusResponse,
} from "../src/modes/daemon/daemon-session-summarizer.js";

/**
 * R4-M14: a recap is persisted (`appendAgentStatus` writes it into the session
 * journal) and replayed by every restart, attach and agents-view repaint, so an
 * escape sequence in it is not a one-frame glitch - it is a clipboard write or a
 * screen clear that fires again for as long as the session lives. The recap is one
 * row of the roster, and both of its sources are text the model or the upstream
 * produced: the classifier's `<recap>` body and the transcript's error message.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J";
const BEL = "\u0007";
const CR = "\r";
const ERROR_RECAP_PREFIX = "Model request failed: ";
/** The transcript error a recap carries is capped, and the cap still applies. */
const ERROR_RECAP_MAX_CHARS = 160;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantError(errorMessage: string): AgentMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	} as unknown as AgentMessage;
}

function makeState(options: {
	messages: AgentMessage[];
	isSessionActive?: boolean;
	summaryState?: AgentStatus;
	persisted?: AgentStatus | undefined;
}): { state: ActiveSessionState; appendAgentStatus: ReturnType<typeof vi.fn> } {
	const appendAgentStatus = vi.fn();
	const state = {
		activeSessionId: "active-sanitize",
		summaryState: options.summaryState,
		runtime: {
			session: {
				isSessionActive: options.isSessionActive ?? false,
				messages: options.messages,
				modelRegistry: {},
				state: { streamingMessage: undefined },
				sessionManager: {
					appendAgentStatus,
					getLatestAgentStatus: () => options.persisted,
				},
			},
		},
	} as unknown as ActiveSessionState;
	return { state, appendAgentStatus };
}

/** The public path to a persisted verdict: a finished turn, then the settle debounce. */
async function settle(state: ActiveSessionState, summarizer: DaemonSessionSummarizer): Promise<void> {
	vi.useFakeTimers();
	try {
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(2_000);
	} finally {
		vi.useRealTimers();
	}
}

function expectCleanRow(summary: string): void {
	expect(summary).not.toContain("\u001b]52");
	expect(summary).not.toContain("cGFzdGU=");
	expect(summary).not.toContain(CLEAR);
	expect(summary).not.toContain(BEL);
	expect(summary).not.toContain(CR);
	expect(summary).not.toContain("\n");
}

describe("daemon session summarizer recap sanitize", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("washes the classifier's recap, which the roster shows on one row", () => {
		expect(parseAgentStatusResponse(`<recap>Fixing the parser${OSC52}${CLEAR}</recap>`, true)).toEqual({
			summary: "Fixing the parser",
		});
	});

	test("keeps a recap one row when the classifier emits a newline", () => {
		expect(parseAgentStatusResponse("<recap>Fixing\nthe parser</recap>", true)).toEqual({
			summary: "Fixing the parser",
		});
	});

	test("washes the transcript error a failed turn persists as its recap", async () => {
		const errorMessage = `upstream ${OSC52} overloaded${CLEAR}${BEL}${CR}\nsecond line`;
		const { state, appendAgentStatus } = makeState({
			messages: [userMessage("deploy it"), assistantError(errorMessage)],
		});
		const summarizer = new DaemonSessionSummarizer(
			() => [state],
			undefined,
			async () => undefined,
		);

		await settle(state, summarizer);

		const persisted = appendAgentStatus.mock.calls[0]?.[0] as AgentStatus | undefined;
		expect(persisted).toBeDefined();
		expect(state.summaryState?.summary).toBe(persisted?.summary);
		const summary = persisted?.summary ?? "";
		expectCleanRow(summary);
		expect(summary.startsWith(ERROR_RECAP_PREFIX)).toBe(true);
		expect(isErrorRecap(summary)).toBe(true);
		expect(summary).toContain("upstream overloaded second line");
		expect(summary.length).toBeLessThanOrEqual(ERROR_RECAP_PREFIX.length + ERROR_RECAP_MAX_CHARS + 1);
	});

	test("spends the recap's character budget on visible text, not on escape bytes", async () => {
		const errorMessage = `${"A".repeat(100)}${OSC52}${"B".repeat(100)}`;
		const { state, appendAgentStatus } = makeState({
			messages: [userMessage("deploy it"), assistantError(errorMessage)],
		});
		const summarizer = new DaemonSessionSummarizer(
			() => [state],
			undefined,
			async () => undefined,
		);

		await settle(state, summarizer);

		const summary = (appendAgentStatus.mock.calls[0]?.[0] as AgentStatus).summary;
		expectCleanRow(summary);
		// Washed first, then capped: 100 A's and 60 of the 100 B's fit the budget.
		expect(summary.slice(ERROR_RECAP_PREFIX.length)).toBe(`${"A".repeat(100)}${"B".repeat(60)}…`);
	});

	test("washes a recap before it is persisted for an idle settle", async () => {
		const { state, appendAgentStatus } = makeState({
			messages: [userMessage("deploy it"), assistantMessage("on it")],
		});
		// Stands in for any upstream that hands back a recap still carrying escapes.
		const summarizer = new DaemonSessionSummarizer(
			() => [state],
			undefined,
			async () => ({
				summary: `Working on it${OSC52}`,
				taskState: "needs_input" as const,
			}),
		);

		await settle(state, summarizer);

		const persisted = appendAgentStatus.mock.calls[0]?.[0] as AgentStatus | undefined;
		expect(persisted?.summary).toBe("Working on it");
	});

	test("washes a recap a pre-fix build already persisted when a session is seeded", () => {
		const { state } = makeState({
			messages: [],
			persisted: { summary: `Old recap${OSC52}${CLEAR}`, taskState: "needs_input", basedOnMessageCount: 3 },
		});

		new DaemonSessionSummarizer(() => [state]).seed(state);

		expect(state.summaryState?.summary).toBe("Old recap");
		expect(state.summaryState?.taskState).toBe("needs_input");
		expect(state.summaryState?.basedOnMessageCount).toBe(3);
	});

	test("seeds a journal whose status entry lost its summary instead of throwing", () => {
		// A hand-edited or externally written journal can carry an agent_status
		// entry with no summary at all: the seed degrades to an empty recap, it
		// must not take the whole session down with a TypeError.
		const { state } = makeState({
			messages: [],
			persisted: { taskState: "needs_input", basedOnMessageCount: 3 } as unknown as AgentStatus,
		});

		expect(() => new DaemonSessionSummarizer(() => [state]).seed(state)).not.toThrow();
		expect(state.summaryState?.summary).toBe("");
		expect(state.summaryState?.taskState).toBe("needs_input");
	});
});
