import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { AgentsViewMode, buildAgentsViewUsageLayout } from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	formatAgentsViewDurationMs,
	formatAgentsViewSettledCell,
	resolveAgentsViewSessionDurationMs,
	resolveAgentsViewSettled,
} from "../src/modes/agents-view/agents-view-state.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { type SessionSummary, summaryForActiveSession } from "../src/modes/daemon/daemon-session-list.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "col-active",
		activeSessionId: "col-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "col-session",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function createUiServices() {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

describe("agents view settled/duration/answer columns (U3)", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));

	it("renders the settled and duration columns ahead of the usage columns", () => {
		const settledRow = summary({
			id: "done-agent",
			activeSessionId: "done-agent",
			sessionId: "done-session",
			sessionName: "done-agent",
			usage: { inputTokens: 12437, outputTokens: 1234, cost: 0.42 },
			settled: true,
			durationMs: 4_212_000, // 1h10m12s -> 1h10m
			answerPreview: "All three landing checks passed; the ledger row is written.",
		});
		const busyRow = summary({
			id: "busy-agent",
			activeSessionId: "busy-agent",
			sessionId: "busy-session",
			sessionName: "busy-agent",
			activity: "working",
			isStreaming: true,
			isSessionActive: true,
			usage: { inputTokens: 500, outputTokens: 50, cost: 0.68 },
			settled: false,
			durationMs: 7_200_000, // 2h
		});
		const rows = buildAgentsViewRows([settledRow, busyRow]);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			const layout = buildAgentsViewUsageLayout(rows);
			const render = (row: AgentsViewRow) =>
				stripAnsi(invoke("renderRow", view, row, 200, layout.details) as string);

			const doneLine = render(rows.find((row) => row.summary.sessionId === "done-session")!);
			// Three new facts per row: settled, duration, and the answer line below.
			expect(doneLine).toContain("✓");
			expect(doneLine).toContain("1h10m");
			// The usage columns keep landing where they always did.
			expect(doneLine).toContain("↑12k ↓1.2k ·  $0.42 ·    0 ·  $0.42 ·");
			const busyLine = render(rows.find((row) => row.summary.sessionId === "busy-session")!);
			// Explicitly not settled reads as in flight, never as a settled check.
			expect(busyLine).toContain("…");
			expect(busyLine).toContain("2h");
			expect(busyLine).not.toContain("✓");
			// The legend names both new columns, leading the block it always had.
			const legend = stripAnsi(layout.legends.get("idle")!);
			expect(legend).toMatch(/^set · +dur · +↑in +↓out · +\$agent · +#sub · +\$total · +age$/);
			// The ` · ` separators sit in the same terminal columns for the legend
			// and every row of its section, new columns included.
			const dotColumns = (text: string) => [...text].flatMap((ch, index) => (ch === "·" ? [index] : []));
			for (const [section, sessionId] of [
				["idle", "done-session"],
				["running", "busy-session"],
			] as const) {
				const row = rows.find((candidate) => candidate.summary.sessionId === sessionId)!;
				const detail = layout.details.get(row.identity)!;
				expect(dotColumns(detail)).toEqual(dotColumns(layout.legends.get(section)!));
			}
		} finally {
			stopThemeWatcher();
		}
	});

	it("renders the answer preview as its own muted line under the row", () => {
		const parent = summary({
			id: "answered",
			activeSessionId: "answered",
			sessionId: "answered-session",
			sessionName: "answered",
			answerPreview: "Finished the migration; 43 tests green, ledger written.",
		});
		const rows = buildAgentsViewRows([parent]);
		const answerRow = rows.find((row) => row.kind === "answer");
		expect(answerRow).toMatchObject({
			kind: "answer",
			title: "Finished the migration; 43 tests green, ledger written.",
			selectable: false,
			depth: 0,
			identity: `answer:${rows[0]!.identity}`,
			parentIdentity: rows[0]!.identity,
		});
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			const line = stripAnsi(invoke("renderRow", view, answerRow!, 200) as string);
			expect(line).toContain("↳ Finished the migration; 43 tests green, ledger written.");
			// A subagent's answer nests under its row, still one preview line.
			const child = summary({
				id: "child",
				activeSessionId: "child",
				sessionId: "child-session",
				sessionName: "child",
				sessionFile: "/tmp/child.jsonl",
				runtimeKind: "subagent",
				parentActiveSessionId: "answered",
				answerPreview: "Subagent answer line.",
			});
			const nested = buildAgentsViewRows([parent, child], new Set([rows[0]!.identity]));
			const nestedAnswer = nested.find((row) => row.kind === "answer" && row.summary.sessionId === "child-session");
			expect(nestedAnswer).toBeDefined();
			expect(nestedAnswer!.depth).toBe(1);
		} finally {
			stopThemeWatcher();
		}
	});

	it("degrades without the new roster fields like an old daemon: local derivation, no answer line, no crash", () => {
		// Old-daemon summaries carry none of the U3 fields.
		const oldIdle = summary({
			id: "old-idle",
			activeSessionId: "old-idle",
			sessionId: "old-idle-session",
			sessionName: "old-idle",
			activity: "idle",
			created: "2026-09-01T00:00:00.000Z",
			lastActivityAt: "2026-09-01T00:40:00.000Z",
			taskState: "completed",
		});
		const oldRunning = summary({
			id: "old-running",
			activeSessionId: "old-running",
			sessionId: "old-running-session",
			sessionName: "old-running",
			activity: "working",
			isStreaming: true,
			created: "2026-09-01T00:00:00.000Z",
			lastActivityAt: "2026-09-01T00:10:00.000Z",
		});
		const oldBare = summary({
			id: "old-bare",
			activeSessionId: "old-bare",
			sessionId: "old-bare-session",
			sessionName: "old-bare",
			activity: "idle",
			created: "2026-09-01T00:00:00.000Z",
			lastActivityAt: "2026-09-01T00:05:00.000Z",
		});
		// A needs_input verdict is an open loop: known-unsettled, never ✓.
		const oldWaiting = summary({
			id: "old-waiting",
			activeSessionId: "old-waiting",
			sessionId: "old-waiting-session",
			sessionName: "old-waiting",
			activity: "idle",
			created: "2026-09-01T00:00:00.000Z",
			lastActivityAt: "2026-09-01T00:05:00.000Z",
			taskState: "needs_input",
		});

		// The local rule degrades from the fields every daemon already carries:
		// quiescent plus a terminal outcome on record.
		expect(resolveAgentsViewSettled(oldIdle)).toBe(true);
		expect(resolveAgentsViewSettled(oldRunning)).toBe(false);
		expect(resolveAgentsViewSettled(oldWaiting)).toBe(false);
		expect(resolveAgentsViewSettled(oldBare)).toBeUndefined();
		expect(formatAgentsViewSettledCell(resolveAgentsViewSettled(oldIdle))).toBe("✓");
		expect(formatAgentsViewSettledCell(resolveAgentsViewSettled(oldRunning))).toBe("…");
		expect(formatAgentsViewSettledCell(resolveAgentsViewSettled(oldWaiting))).toBe("…");
		expect(formatAgentsViewSettledCell(resolveAgentsViewSettled(oldBare))).toBe("");
		expect(resolveAgentsViewSessionDurationMs(oldIdle, Date.parse("2026-09-01T01:00:00.000Z"))).toBe(40 * 60_000);
		// Without a created timestamp there is no span to derive: blank, not zero.
		expect(resolveAgentsViewSessionDurationMs(summary({ id: "no-clock" }))).toBeUndefined();

		const rows = buildAgentsViewRows([oldIdle, oldRunning, oldBare, oldWaiting]);
		// No answer rows without the daemon field: the preview is hidden, not faked.
		expect(rows.filter((row) => row.kind === "answer")).toHaveLength(0);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			Reflect.set(view, "rows", rows);
			Reflect.set(view, "selectedIndex", 0);
			Reflect.set(view, "ui", { terminal: { rows: 24 }, requestRender: () => {} });
			// The full row pipeline renders without the fields: degradation, not a crash.
			const rendered = (invoke("renderSessionRows", view, 120, 20) as string[]).map(stripAnsi);
			expect(rendered.length).toBeGreaterThan(0);
			const idleLine = rendered.find((line) => line.includes("old-idle"))!;
			expect(idleLine).toContain("✓");
			expect(idleLine).toContain("40m");
			const runningLine = rendered.find((line) => line.includes("old-running"))!;
			expect(runningLine).toContain("…");
			const bareLine = rendered.find((line) => line.includes("old-bare"))!;
			expect(bareLine).not.toContain("✓");
			expect(bareLine).not.toContain("…");
			const waitingLine = rendered.find((line) => line.includes("old-waiting"))!;
			expect(waitingLine).not.toContain("✓");
			expect(waitingLine).toContain("…");
			// The answer-line kind never renders for these rows.
			expect(rendered.some((line) => line.includes("↳"))).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("truncates the answer preview line to the terminal width", () => {
		const preview = `${"A".repeat(300)}TAILMARKER`;
		const rows = buildAgentsViewRows([
			summary({
				id: "long-answer",
				activeSessionId: "long-answer",
				sessionId: "long-answer-session",
				sessionName: "long-answer",
				answerPreview: preview,
			}),
		]);
		const answerRow = rows.find((row) => row.kind === "answer")!;
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			const width = 60;
			const raw = invoke("renderRow", view, answerRow, 500) as string;
			// Unfinalized, the preview line carries the whole capped preview...
			expect(stripAnsi(raw)).toContain(`↳ ${preview}`);
			// ...and the finalizer cuts it to exactly one terminal row of `width`.
			const finalized = invoke("finalizeRenderedLine", view, raw, width) as string;
			expect(finalized.includes("\n")).toBe(false);
			expect(visibleWidth(finalized)).toBe(width);
			expect(stripAnsi(finalized).startsWith("↳")).toBe(true);
			const shownRun = stripAnsi(finalized).match(/A+/)![0]!;
			expect(shownRun.length).toBeGreaterThan(50);
			// The tail of the long reply never reaches the screen.
			expect(stripAnsi(finalized)).not.toContain(preview.slice(-20));
		} finally {
			stopThemeWatcher();
		}
	});

	it("derives the roster facts on the daemon side and keeps the compose memo honest", () => {
		const assistantReply = {
			role: "assistant",
			content: [{ type: "text", text: "First line of the reply.\nSecond line stays off the wire preview." }],
			timestamp: Date.parse("2026-05-02T00:00:00.000Z"),
		} as AgentMessage;
		const state = makeState({
			activeSessionId: "answered",
			sessionFile: "/tmp/answered.jsonl",
			messages: [{ role: "user", content: "hi" } as AgentMessage, assistantReply],
			summaryState: { summary: "completed the task", basedOnMessageCount: 2, taskState: "completed" },
		});

		const composed = summaryForActiveSession(state);
		// The preview is the reply's first line only.
		expect(composed.answerPreview).toBe("First line of the reply.");
		// A current verdict with no work in flight settles the row.
		expect(composed.settled).toBe(true);
		// created (session header) to last activity (reply timestamp): one day.
		expect(composed.durationMs).toBe(24 * 60 * 60 * 1000);
		// The memo must not serve a stale preview after the transcript grows:
		// append another reply and recompose.
		const secondReply = {
			role: "assistant",
			content: [{ type: "text", text: "The follow-up answer." }],
			timestamp: Date.parse("2026-05-03T00:00:00.000Z"),
		} as AgentMessage;
		state.runtime.session.messages.push(secondReply);
		const recomposed = summaryForActiveSession(state);
		expect(recomposed.answerPreview).toBe("The follow-up answer.");
		expect(recomposed.durationMs).toBe(2 * 24 * 60 * 60 * 1000);
		// A needs_input verdict is an open loop, not a conclusion.
		const waiting = summaryForActiveSession(
			makeState({
				activeSessionId: "waiting",
				sessionFile: "/tmp/waiting.jsonl",
				messages: [{ role: "user", content: "hi" } as AgentMessage],
				summaryState: { summary: "waiting for the user", basedOnMessageCount: 1, taskState: "needs_input" },
			}),
		);
		expect(waiting.settled).toBe(false);
		// A busy session never reports settled and has no answer yet.
		const busy = summaryForActiveSession(
			makeState({ activeSessionId: "busy", sessionFile: "/tmp/busy.jsonl", isStreaming: true }),
		);
		expect(busy.settled).toBe(false);
		expect(busy.answerPreview).toBeUndefined();
	});

	it("keeps a long reply capped on the wire and settles a subagent by its reply", () => {
		const longReply = {
			role: "assistant",
			content: [{ type: "text", text: `${"L".repeat(400)}\n${"tail-line-never-shipped"}` }],
			timestamp: Date.parse("2026-05-02T00:00:00.000Z"),
		} as AgentMessage;
		const capped = summaryForActiveSession(
			makeState({ activeSessionId: "long", sessionFile: "/tmp/long.jsonl", messages: [longReply] }),
		);
		// The 200-char cap with the compact ellipsis; the second line never ships.
		expect(capped.answerPreview).toHaveLength(200);
		expect(capped.answerPreview!.endsWith("...")).toBe(true);
		expect(capped.answerPreview).not.toContain("tail-line-never-shipped");

		// A subagent without a verdict settles through its reply to the parent.
		const subagent = summaryForActiveSession(
			makeState({
				activeSessionId: "child",
				sessionFile: "/tmp/child.jsonl",
				metadata: { kind: "subagent", createdAt: 1, rlmChildId: "7" },
				repliedToParentSinceTask: true,
			}),
		);
		expect(subagent.settled).toBe(true);
		// Without the reply it is known-unsettled, not unknown.
		const silentSubagent = summaryForActiveSession(
			makeState({
				activeSessionId: "silent",
				sessionFile: "/tmp/silent.jsonl",
				metadata: { kind: "subagent", createdAt: 1, rlmChildId: "8" },
				repliedToParentSinceTask: false,
			}),
		);
		expect(silentSubagent.settled).toBe(false);
	});

	it("formats the duration cell across unit boundaries", () => {
		expect(formatAgentsViewDurationMs(undefined)).toBe("");
		expect(formatAgentsViewDurationMs(45_000)).toBe("45s");
		expect(formatAgentsViewDurationMs(90_000)).toBe("1m");
		expect(formatAgentsViewDurationMs(4_200_000)).toBe("1h10m");
		expect(formatAgentsViewDurationMs(3_600_000)).toBe("1h");
		expect(formatAgentsViewDurationMs((24 + 4) * 3_600_000)).toBe("1d4h");
		expect(formatAgentsViewDurationMs(3 * 24 * 3_600_000)).toBe("3d");
	});
});

interface StateOptions {
	activeSessionId: string;
	sessionFile?: string;
	sessionId?: string;
	messages?: AgentMessage[];
	summaryState?: ActiveSessionState["summaryState"];
	metadata?: ActiveSessionState["runtime"]["metadata"];
	isStreaming?: boolean;
	repliedToParentSinceTask?: boolean;
}

/**
 * Minimal ActiveSessionState fixture for the roster compose, mirroring the shape
 * daemon-session-list.test.ts builds. Public fields only; the cast is for the
 * parts of the runtime this fixture intentionally leaves out.
 */
function makeState(options: StateOptions): ActiveSessionState {
	return {
		activeSessionId: options.activeSessionId,
		clients: new Set(),
		lastEventSequence: 0,
		summaryState: options.summaryState,
		runtime: {
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				rlmDepth: 0,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-05-01T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => true,
				},
				messages: options.messages ?? [],
				getRlmChildSnapshots: () => [],
				getOwnUsageSummary: () => undefined,
				hasRunningRlmChildren: () => false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 0,
				isSessionActive: options.isStreaming === true,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				state: { streamingMessage: undefined, pendingToolCalls: new Set<string>() },
				// The subagent settled rule reads the reply flag directly.
				repliedToParentSinceTask: options.repliedToParentSinceTask,
			},
		},
	} as unknown as ActiveSessionState;
}
