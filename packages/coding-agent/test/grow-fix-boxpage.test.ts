import { Container, setKeybindings, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addStep, host, type QuietTurn, quietTurn, T0 } from "./ui-blocks-helpers.js";

/**
 * Walking a turn's timeline with the keyboard: its lines grow with the turn and it has no inner scroll,
 * so in the fullscreen window PageUp/PageDown page the whole transcript, and on an inline screen they move nothing.
 */

const COLUMNS = 70;
const ROWS = 14;
const STEPS = 30;
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

const screens: TUI[] = [];

/** A finished command step; each one has its own timestamp, since steps stamped in the same millisecond share a message. */
function addTimedCommand(turn: QuietTurn, index: number): void {
	const id = `c${index}`;
	const label = `echo step-${index}`;
	addStep(turn, id, `await bash(${JSON.stringify(label)})`, "done", T0 - 600_000 + index * 1_000);
	turn.timeline.mergeStep(
		id,
		"ipython",
		{},
		{
			details: {
				activities: [
					{ id: `${id}-a`, kind: "command", label, status: "ok", detail: "done", startedAt: 1, endedAt: 2 },
				],
			},
		},
		false,
	);
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	setMotionReduced(true);
});

afterEach(() => {
	for (const tui of screens.splice(0)) tui.stop();
});

interface Walk {
	terminal: VirtualTerminal;
	tui: TUI;
	/** The step numbers on screen right now. */
	steps(): number[];
	press(data: string): Promise<void>;
}

/** The key handlers are private; the fake drives them the way interactive-mode-status.test.ts does. */
function walkerMode(chat: Container, tui: TUI) {
	const fake = {
		uiServices: { settingsManager: { getProcessMode: () => "quiet" as const } },
		chatContainer: chat,
		editor: { getText: () => "", handleInput: () => {} },
		showToast: () => {},
		ui: tui,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake as any;
}

/** Opens the turn's one event with every step listed (`全部 ›` taken): nothing is open by default. */
function listEverySteps(turn: QuietTurn): void {
	turn.summary.render(COLUMNS);
	const eventKey = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:")) ?? "";
	expect(eventKey).not.toBe("");
	turn.summary.activate(eventKey);
	turn.summary.render(COLUMNS);
	expect(turn.summary.activate(`all:${eventKey}`)).toBe(true);
	turn.summary.render(COLUMNS);
}

async function startWalk(options: { fullscreen: boolean }): Promise<Walk> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TUI(terminal);
	const turn = quietTurn({ host: host({ viewportRows: () => ROWS }) });
	for (let step = 0; step < STEPS; step++) addTimedCommand(turn, step);
	listEverySteps(turn);
	const chat = new Container();
	chat.addChild(new Text("earlier chat", 0, 0));
	chat.addChild(turn.summary);
	const dock = new Container();
	dock.addChild(new Text("prompt", 0, 0));
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	if (options.fullscreen) tui.enterFullscreen({ scroll: [chat], dock, mouse: true });
	screens.push(tui);
	await terminal.waitForRender();
	walkerMode(chat, tui).focusLatestTurnBox();
	await terminal.waitForRender();
	const steps = (): number[] =>
		terminal
			.getViewport()
			.map((line) => /\$ +echo step-(\d+)/.exec(stripAnsi(line))?.[1])
			.filter((found): found is string => found !== undefined)
			.map(Number);
	return {
		terminal,
		tui,
		steps,
		press: async (data) => {
			terminal.sendInput(data);
			await terminal.waitForRender();
		},
	};
}

describe("PageUp and PageDown while the keyboard walks the timeline in the fullscreen window", () => {
	it("pages the transcript down, then back up", async () => {
		const walk = await startWalk({ fullscreen: true });
		const first = walk.steps();
		expect(first.length).toBeGreaterThan(0);
		await walk.press(PAGE_DOWN);
		const down = walk.steps();
		expect(Math.max(...down)).toBeGreaterThan(Math.max(...first));
		await walk.press(PAGE_UP);
		expect(walk.steps()).toEqual(first);
	});

	it("shows every step on the way from the header to the end and back, skipping none", async () => {
		const walk = await startWalk({ fullscreen: true });
		const seen = new Set<number>(walk.steps());
		for (let page = 0; page < STEPS && walk.tui.getScrollInfo()?.following === false; page++) {
			await walk.press(PAGE_DOWN);
			for (const step of walk.steps()) seen.add(step);
		}
		expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: STEPS }, (_, step) => step));

		const back = new Set<number>(walk.steps());
		for (let page = 0; page < STEPS && (walk.tui.getScrollInfo()?.linesAbove ?? 0) > 0; page++) {
			await walk.press(PAGE_UP);
			for (const step of walk.steps()) back.add(step);
		}
		expect([...back].sort((a, b) => a - b)).toEqual(Array.from({ length: STEPS }, (_, step) => step));
	});
});

describe("PageUp and PageDown while the keyboard walks the timeline on an inline screen", () => {
	it("has no body of its own to scroll: the screen keeps showing the newest lines", async () => {
		const walk = await startWalk({ fullscreen: false });
		expect(walk.tui.getScrollInfo()).toBeNull();
		const before = walk.terminal.getViewport().join("\n");
		const shown = walk.steps();
		expect(shown.length).toBeGreaterThan(0);
		expect(Math.max(...shown)).toBe(STEPS - 1);
		await walk.press(PAGE_UP);
		await walk.press(PAGE_DOWN);
		const after = walk.terminal.getViewport().join("\n");
		expect(after).toBe(before);
		expect(walk.steps()).toEqual(shown);
		for (const gone of ["上面还有", "有新内容"]) expect(stripAnsi(after)).not.toContain(gone);
	});
});
