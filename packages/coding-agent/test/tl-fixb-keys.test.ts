import { type KeyId, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { FooterComponent, type StatusBarState } from "../src/modes/interactive/components/footer.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The key that stops a run is named in full wherever the screen names it: when the
 * owner binds more than one key to it, every key is listed, since any of them works.
 */

type Method<T> = (this: object) => T;

function method<T>(name: string): Method<T> {
	const found: unknown = Reflect.get(InteractiveMode.prototype, name);
	if (typeof found !== "function") throw new Error(`InteractiveMode has no ${name}`);
	return found as Method<T>;
}

function modeWith(stubs: Record<string, unknown>): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, stubs);
	return mode;
}

function bind(keys: KeyId | KeyId[] | undefined): void {
	setKeybindings(new KeybindingsManager(keys === undefined ? {} : { "app.input.clear": keys }));
}

/** The status line of a run in progress. */
function workingStatusLine(): string {
	const strip = new SubagentSummaryLine();
	const mode = modeWith({
		getCurrentModel: () => ({ id: "glm-5.3-prime", reasoning: false }),
		connectionState: { thinkingLevel: "medium" },
		getConnectionContextUsage: () => undefined,
		footerDataProvider: { getGitBranch: () => null },
		getCurrentCwd: () => "/work/app",
		subagentSummaryLine: strip,
		subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
		footerToast: undefined,
		currentTurnState: undefined,
		isAgentStreaming: () => true,
		isAgentCompacting: () => false,
		workingStartedAt: Date.now() - 86_000,
		turnStartedAt: undefined,
		activityTracker: { getStatus: () => ({ tokens: 7_100 }) },
		sessionOutputTokens: undefined,
		connectionLost: false,
		liveTurnFlowStore: { hasLiveBox: () => false, lastFinished: undefined },
	});
	const state = method<StatusBarState | undefined>("getStatusBarState").call(mode);
	const footer = new FooterComponent({ getGitBranch: () => null } as never);
	footer.setStatusBarSource(() => state);
	return stripAnsi(footer.render(160).join("\n"));
}

function trayOverride(): string | undefined {
	const mode = modeWith({
		isCtrlCExitHintVisible: () => false,
		escapeRepeatAction: "tree",
		hasInterruptibleWork: () => false,
		editor: { getText: () => "" },
	});
	return method<string | undefined>("getTrayOverrideLabel").call(mode);
}

/** The hint line of a run in progress in the legacy (not quiet) conversation. */
function legacyTrayHints(): string[] {
	const mode = modeWith({
		boxFocus: undefined,
		options: { returnToAgentsView: false },
		editor: { getText: () => "" },
		uiServices: { settingsManager: { getProcessMode: () => "verbose" } },
		connectionState: { messageCount: 3, isStreaming: true },
		isAgentStreaming: () => true,
	});
	return method<string[]>("getTrayHints").call(mode);
}

beforeAll(() => {
	initTheme("dark");
});

describe("the stop key with one binding", () => {
	it("reads Esc everywhere", () => {
		bind(undefined);
		expect(workingStatusLine()).toContain("· Esc 停止");
		expect(trayOverride()).toBe("再按一次 Esc 回退到之前的消息");
		expect(legacyTrayHints()).toContain("Esc 中断");
	});
});

describe("the stop key with two bindings", () => {
	it("lists both in the status line", () => {
		bind(["escape", "ctrl+x"]);
		const line = workingStatusLine();
		expect(line).toContain("Esc/Ctrl+X 停止");
		expect(line).not.toMatch(/(?<![/\w])Esc 停止/u);
	});

	it("lists both in the second-press hint", () => {
		bind(["escape", "ctrl+x"]);
		expect(trayOverride()).toBe("再按一次 Esc/Ctrl+X 回退到之前的消息");
	});

	it("lists both on the hint line", () => {
		bind(["escape", "ctrl+x"]);
		const hints = legacyTrayHints();
		expect(hints).toContain("Esc/Ctrl+X 中断");
		expect(hints).not.toContain("Esc 中断");
	});

	it("shows the one key that is left when the owner rebinds it to a single key", () => {
		bind("ctrl+x");
		expect(workingStatusLine()).toContain("· Ctrl+X 停止");
		expect(legacyTrayHints()).toContain("Ctrl+X 中断");
	});
});
