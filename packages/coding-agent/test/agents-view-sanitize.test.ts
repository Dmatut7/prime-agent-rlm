import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	AgentsViewMode,
	createAgentsViewReplyHeadline,
	formatAgentsViewStatusLine,
} from "../src/modes/agents-view/agents-view-mode.js";
import { agentsViewRowRecap } from "../src/modes/agents-view/agents-view-state.js";
import { buildAgentsViewRows, type SessionSummary } from "../src/modes/index.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

function createUiServices() {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

/**
 * The agents view paints its own rows: `renderRow`, `renderAnswerRow` and
 * `renderCodeRow` interpolate the row fields into `theme.fg` strings instead of
 * handing them to `Text`, whose render is the central wash. So the state layer
 * that builds those fields is the last point where model-controlled text can be
 * cleaned. These are the vectors a model (or a page it read) puts into a session
 * name, a last answer or a queued task prompt: a clipboard write, a screen clear,
 * a bell, a carriage return that rewinds the row, a newline that turns one row
 * into two, a hyperlink that invents a click target, and the color codes that
 * would let the text paint over the row.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J\u001b[H";
const SGR = "\u001b[31m";
const RESET = "\u001b[0m";
const HYPERLINK = "\u001b]8;;http://evil.example\u0007";

/** Byte-level: no escape sequence, no payload of one, no control character. */
function expectByteClean(value: string): void {
	expect(value).not.toContain("\u001b");
	expect(value).not.toContain("\u001b]52");
	expect(value).not.toContain("\u001b[2J");
	expect(value).not.toContain("cGFzdGU=");
	expect(value).not.toContain("evil.example");
	expect(value).not.toContain("\u0007");
	expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
}

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

describe("agents view row sanitization", () => {
	test("washes the session name the row title shows", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				sessionName: `worker${OSC52} ${CLEAR}\u0007report\r ready ${SGR}red${RESET} ${HYPERLINK}click\u001b]8;;\u0007\nsecond line`,
			}),
		]);
		const title = rows[0]?.title ?? "";
		expectByteClean(title);
		expect(title).toBe("worker report ready red click second line");
	});

	test("keeps a name whose visible text contains a colon", () => {
		const rows = buildAgentsViewRows([makeSummary({ sessionName: `lane-c: 交回${OSC52}` })]);
		const title = rows[0]?.title ?? "";
		expectByteClean(title);
		expect(title).toBe("lane-c: 交回");
	});

	test("falls through to the next candidate when a name is only escape sequences", () => {
		const rows = buildAgentsViewRows([
			makeSummary({ sessionName: `${OSC52}${CLEAR}`, firstMessage: "把这段跑一遍" }),
		]);
		const title = rows[0]?.title ?? "";
		expectByteClean(title);
		expect(title).toBe("把这段跑一遍");
	});

	test("washes the answer preview row under its session row", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				sessionName: "clean",
				answerPreview: `三条都过了${OSC52} ${CLEAR}\u0007账本已写\r\n第二行`,
			}),
		]);
		const answer = rows.find((row) => row.kind === "answer");
		expect(answer).toBeDefined();
		const title = answer?.title ?? "";
		expectByteClean(title);
		expect(title).toBe("三条都过了 账本已写 第二行");
	});

	test("washes the status label built from a queued task prompt", () => {
		// `active.label` is `compactRlmText(payload.text)`: an RLM child's task
		// prompt, written by the parent model, collapsed to one line but never
		// stripped of escape sequences.
		const rows = buildAgentsViewRows([
			makeSummary({
				sessionActions: {
					queuedCount: 0,
					steering: [],
					followUps: [],
					active: { kind: "turn", phase: "running", label: `跑一遍清洗${OSC52}\u0007 然后回报\r` },
				},
			}),
		]);
		const statusLabel = rows[0]?.statusLabel ?? "";
		expectByteClean(statusLabel);
		expect(statusLabel).toBe("跑一遍清洗 然后回报");
	});

	test("washes the roster status label a worker reports", () => {
		// The field is a closed union in today's schema; an older or hostile daemon
		// writes whatever bytes it likes onto the wire, and the row shows them.
		const rows = buildAgentsViewRows([
			makeSummary({ statusLabel: `recovering${OSC52}` as SessionSummary["statusLabel"] }),
		]);
		const statusLabel = rows[0]?.statusLabel ?? "";
		expectByteClean(statusLabel);
		expect(statusLabel).toBe("recovering");
	});

	test("washes the worker state a non-ready worker reports", () => {
		// Same wire class as the roster label above: a closed union in the schema,
		// bytes on the socket.
		const rows = buildAgentsViewRows([
			makeSummary({ workerState: `recovering${OSC52}` as SessionSummary["workerState"] }),
		]);
		const statusLabel = rows[0]?.statusLabel ?? "";
		expectByteClean(statusLabel);
		expect(statusLabel).toBe("recovering");
	});

	test("washes the subtitle without dropping its separators", () => {
		const rows = buildAgentsViewRows([makeSummary({ cwd: `/tmp/proj${CLEAR}ect\u0007` })]);
		const subtitle = rows[0]?.subtitle ?? "";
		expectByteClean(subtitle);
		expect(subtitle).toBe("/tmp/project  active-1");
	});

	test("washes spawn-code rows and keeps the indentation a program reads by", () => {
		const spawnCode = [
			`task = sleep(60)${OSC52}`,
			"for i in range(2):",
			`    run_subagent(i, task)${CLEAR}`,
			'\tprint("x\u0007y")',
		].join("\n");
		const summaries = [
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
		];
		const parentIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		const rows = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		const codeLines = rows.filter((row) => row.kind === "subagent-code").map((row) => row.code ?? "");
		expect(codeLines.length).toBeGreaterThan(0);
		for (const line of codeLines) {
			expectByteClean(line);
		}
		// Blank pad lines top and bottom, the program in between with its own
		// indentation kept: a tab widens to the four spaces a code row shows.
		expect(codeLines).toEqual([
			"",
			"task = sleep(60)",
			"for i in range(2):",
			"    run_subagent(i, task)",
			'    print("xy")',
			"",
		]);
	});

	test("washes the recap a row shows beside its title, however old the journal it came from", () => {
		// The summarizer washes a recap before it persists one now; a journal an
		// older build wrote is still on disk, and the roster replays it on every
		// redraw. This is the read side of the same row.
		const recap = agentsViewRowRecap(
			makeSummary({ summary: `Fixing the parser${OSC52}${CLEAR}\u0007done\r\nsecond line` }),
		);
		expect(recap).toBeDefined();
		expectByteClean(recap ?? "");
		expect(recap).toBe("Fixing the parserdone second line");
		expect(agentsViewRowRecap(makeSummary({ summary: `${OSC52}${CLEAR}` }))).toBeUndefined();
		expect(agentsViewRowRecap(makeSummary({}))).toBeUndefined();
	});

	test("washes the reply headline the view names a session by", () => {
		const headline = createAgentsViewReplyHeadline(`\n\n  都跑完了${OSC52} ${SGR}绿${RESET}  \n第二行`);
		expect(headline).toBeDefined();
		expectByteClean(headline ?? "");
		expect(headline).toBe("都跑完了 绿");
		expect(createAgentsViewReplyHeadline(`   \n${CLEAR}\n  `)).toBeUndefined();
	});

	test("washes the status line the view shows below its rows", () => {
		// The single-row hint slot: a daemon error message or a session's cwd lands
		// here, and the line renders through theme.fg, not Text.
		const line = formatAgentsViewStatusLine(`opened ${OSC52}/tmp/pro${CLEAR}ject\r done`);
		expectByteClean(line);
		expect(line).toBe("opened /tmp/project done");
	});

	test("washes the action kind the status label falls back to", () => {
		// `label` is empty, so the label falls back to the action kind - wire bytes
		// from the same closed union the roster label above defends against.
		const rows = buildAgentsViewRows([
			makeSummary({
				sessionActions: {
					queuedCount: 0,
					steering: [],
					followUps: [],
					active: { kind: `tur${OSC52}n_now\u0007` as "turn", phase: "running", label: "" },
				},
			}),
		]);
		const statusLabel = rows[0]?.statusLabel ?? "";
		expectByteClean(statusLabel);
		expect(statusLabel).toBe("turn now");
	});

	test("drops an answer row whose preview is only escape sequences", () => {
		// The preview washes to nothing, so no empty `↳` row sits under its parent.
		const rows = buildAgentsViewRows([
			makeSummary({ sessionName: "clean", answerPreview: `${OSC52}${CLEAR}\u0007` }),
		]);
		expect(rows.filter((row) => row.kind === "answer")).toHaveLength(0);
	});
});

describe("the row line the view renders itself", () => {
	test("washes the model label a subagent row's title carries", () => {
		setKeybindings(new KeybindingsManager());
		const summaries = [
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				model: { provider: `an${OSC52}thropic`, id: `cl${CLEAR}aude` } as SessionSummary["model"],
				thinkingLevel: `hi\u0007gh` as SessionSummary["thinkingLevel"],
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "parent",
				isStreaming: true,
				activity: "working",
			}),
		];
		const parentIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		const expanded = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		const childRow = expanded.find((row) => row.summary.sessionId === "child-session");
		expect(childRow).toBeDefined();
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			const line = invoke("renderRow", view, childRow, 200) as string;
			// The row line is theme-painted (its own SGR stays); the model label's
			// injected bytes do not.
			expect(line).not.toContain("\u001b]52");
			expect(line).not.toContain("cGFzdGU=");
			expect(line).not.toContain("\u0007");
			expect(line).not.toContain("\u001b[2J");
			expect(stripAnsi(line)).toContain("anthropic/claude:high");
		} finally {
			stopThemeWatcher();
		}
	});
});
