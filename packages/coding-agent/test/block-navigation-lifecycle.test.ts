import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, type Focusable, setKeybindings, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { FocusableTextBlock, isFocusableBlock } from "../src/modes/interactive/components/block-focus.js";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Block navigation (Alt+Up) driven through a real TUI on a virtual terminal:
 * keys go in through the terminal and reach whatever holds focus, the way the
 * owner's keypresses do. The mode is a partial fake on InteractiveMode's
 * prototype (the pattern of block-navigation.test.ts); the navigation
 * methods under test run for real.
 */

const ALT_UP = "\x1b[1;3A";
const ALT_DOWN = "\x1b[1;3B";
const ENTER = "\r";
const ESC = "\x1b";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

/** The prompt: records what reaches it. */
class PromptRecorder implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];
	render(): string[] {
		return ["> prompt"];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

/** A dialog that takes focus the way an extension select/confirm does. */
class Dialog implements Component, Focusable {
	focused = false;
	render(): string[] {
		return ["[dialog]"];
	}
	handleInput(): void {}
	invalidate(): void {}
}

/** A tool row after the turn head: it follows the turn's process lane. */
class ToolRow implements Component {
	expanded = false;
	render(): string[] {
		return this.expanded ? [" ✓ ran ls", "   a  b  c"] : [];
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {}
}

function assistant(text: string, extra: Partial<AssistantMessage> = {}, thinking?: string): AssistantMessageComponent {
	return new AssistantMessageComponent({
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking" as const, thinking }] : []), { type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...extra,
	});
}

function turn(steps: number, quiet = true): TurnSummaryComponent {
	const state = new TurnActivityState(1_000);
	for (let i = 0; i < steps; i++) {
		state.addStep({ toolCallId: `t${i}`, toolName: "bash", args: { command: `ls ${i}` }, status: "done" });
	}
	state.markTurnEnded(2_000);
	const summary = new TurnSummaryComponent(state);
	summary.setQuiet(quiet);
	return summary;
}

interface Harness {
	mode: InteractiveMode;
	ui: TUI;
	terminal: VirtualTerminal;
	chat: Container;
	prompt: PromptRecorder;
	navigating(): boolean;
	press(data: string): Promise<void>;
	start(): Promise<void>;
	focusedText(): string;
	viewport(): Promise<string[]>;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

function call(mode: InteractiveMode, name: string, ...args: unknown[]): unknown {
	const method = (InteractiveMode.prototype as unknown as Record<string, Method>)[name];
	if (!method) throw new Error(`no method ${name}`);
	return method.call(mode, ...args);
}

async function createHarness(
	children: Component[],
	options: { fullscreen?: boolean; rows?: number; processMode?: "quiet" | "verbose" } = {},
): Promise<Harness> {
	const terminal = new VirtualTerminal(80, options.rows ?? 12);
	const ui = new TUI(terminal);
	const chat = new Container();
	for (const child of children) chat.addChild(child);
	const prompt = new PromptRecorder();
	const dock = new Container();
	dock.addChild(prompt);
	ui.addChild(chat);
	ui.addChild(dock);
	ui.start();
	if (options.fullscreen) ui.enterFullscreen({ scroll: [chat], dock, mouse: false });
	ui.setFocus(prompt);
	const fake: Record<string, unknown> = {
		ui,
		chatContainer: chat,
		editor: prompt,
		blockNavigation: undefined,
		hideThinkingBlock: false,
		processBlockOpenOrder: undefined,
		toolOutputExpanded: false,
		thinkingExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		settingsManager: { getProcessMode: () => options.processMode ?? "quiet" },
		getFullscreenScrollComponents: () => [chat],
		showStatus: vi.fn(),
		showError: vi.fn(),
		showToast: vi.fn(),
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	const mode = fake as unknown as InteractiveMode;
	await terminal.waitForRender();
	const harness: Harness = {
		mode,
		ui,
		terminal,
		chat,
		prompt,
		navigating: () => fake.blockNavigation !== undefined,
		press: async (data) => {
			terminal.sendInput(data);
			await terminal.waitForRender();
		},
		start: async () => {
			call(mode, "startBlockNavigation", -1);
			await terminal.waitForRender();
		},
		focusedText: () => {
			const navigation = fake.blockNavigation as { focused: Component } | undefined;
			return navigation ? plain(navigation.focused.render(80)).join("\n") : "";
		},
		viewport: async () => {
			await terminal.waitForRender();
			return terminal.getViewport();
		},
	};
	return harness;
}

describe("block navigation lifecycle", () => {
	it("ends when a dialog takes focus, and Esc after answering it goes to the prompt", async () => {
		const answer = assistant("目录里有 4 个包。");
		const h = await createHarness([new UserMessageComponent("看一下目录"), turn(1), answer]);
		await h.start();
		expect(h.navigating()).toBe(true);
		expect(plain(answer.render(80)).join("\n")).toContain("复制");

		const dialog = new Dialog();
		h.ui.setFocus(dialog);
		await h.terminal.waitForRender();
		expect(h.navigating()).toBe(false);
		expect(plain(answer.render(80)).join("\n")).not.toContain("复制");

		// hideExtensionSelector hands focus to the prompt; keys now reach it.
		h.ui.setFocus(h.prompt);
		await h.press(ESC);
		expect(h.prompt.inputs).toEqual([ESC]);
		await h.press(ALT_UP);
		expect(h.prompt.inputs).toEqual([ESC, ALT_UP]);
	});

	it("hands keys to the prompt when an overlay closes back onto a finished navigator", async () => {
		const h = await createHarness([new UserMessageComponent("hi"), assistant("好的")]);
		await h.start();
		const overlay = h.ui.showOverlay(new Dialog());
		await h.terminal.waitForRender();
		expect(h.navigating()).toBe(false);
		overlay.hide();
		await h.terminal.waitForRender();
		await h.press("x");
		expect(h.prompt.inputs).toEqual(["x"]);
	});

	it("survives a same-component focus re-set and pressing Alt+Up twice", async () => {
		const first = new UserMessageComponent("第一问");
		const h = await createHarness([
			first,
			assistant("第一答"),
			new UserMessageComponent("第二问"),
			assistant("第二答"),
		]);
		await h.start();
		const navigator = (h.mode as unknown as Record<string, { navigator: Component }>).blockNavigation?.navigator;
		if (navigator) h.ui.setFocus(navigator);
		await h.terminal.waitForRender();
		expect(h.navigating()).toBe(true);
		await h.press(ALT_UP);
		await h.press(ALT_UP);
		expect(h.focusedText()).toContain("第一答");
		await h.press(ALT_DOWN);
		expect(h.focusedText()).toContain("第二问");
		await h.press(ESC);
		expect(h.navigating()).toBe(false);
		expect(h.prompt.inputs).toEqual([]);
	});

	it("ends on a chat reset (/new, /resume, reattach) and gives the prompt its focus back", async () => {
		const h = await createHarness([new UserMessageComponent("hi"), assistant("好的")]);
		await h.start();
		call(h.mode, "resetBlockNavigation");
		h.chat.clear();
		await h.press("a");
		expect(h.navigating()).toBe(false);
		expect(h.prompt.inputs).toEqual(["a"]);
	});

	it("types through: any other key leaves and reaches the prompt", async () => {
		const h = await createHarness([new UserMessageComponent("hi"), assistant("好的")]);
		await h.start();
		await h.press("q");
		expect(h.navigating()).toBe(false);
		expect(h.prompt.inputs).toEqual(["q"]);
	});
});

describe("block navigation in fullscreen", () => {
	function longAnswer(label: string, rows: number): AssistantMessageComponent {
		return assistant(Array.from({ length: rows }, (_, i) => `${label} 第 ${i} 行`).join("\n\n"));
	}

	it("lets the page keys read a long focused answer, and follows the tail again on exit", async () => {
		const long = longAnswer("长答", 20);
		const h = await createHarness(
			[new UserMessageComponent("讲讲"), long, new UserMessageComponent("还有吗"), assistant("没了")],
			{
				fullscreen: true,
			},
		);
		await h.start();
		await h.press(ALT_UP);
		await h.press(ALT_UP);
		expect(h.focusedText()).toContain("长答 第 0 行");
		const top = await h.viewport();
		expect(top.some((row) => row.includes("长答 第 0 行"))).toBe(true);

		await h.press(PAGE_DOWN);
		await h.press(PAGE_DOWN);
		const paged = await h.viewport();
		// The window stayed where the page keys put it instead of snapping back to the block's top.
		expect(paged.some((row) => row.includes("长答 第 0 行"))).toBe(false);
		expect(paged.some((row) => row.includes("长答 第 1"))).toBe(true);
		expect(h.navigating()).toBe(true);

		// A resize keeps the navigation and its highlight.
		h.terminal.resize(60, 12);
		await h.terminal.waitForRender();
		expect(h.navigating()).toBe(true);
		expect(h.focusedText()).toContain("复制");

		await h.press(ESC);
		expect(h.navigating()).toBe(false);
		const after = await h.viewport();
		expect(h.ui.isFullscreenReviewing()).toBe(false);
		expect(after.some((row) => row.includes("没了"))).toBe(true);
	});

	it("starts on the block in view when the owner scrolled up, and leaves the view there on exit", async () => {
		const children: Component[] = [];
		for (let i = 0; i < 8; i++) {
			children.push(new UserMessageComponent(`问题 ${i}`));
			children.push(assistant(`回答 ${i}`));
		}
		const h = await createHarness(children, { fullscreen: true });
		await h.press(PAGE_UP);
		await h.press(PAGE_UP);
		const before = await h.viewport();
		expect(h.ui.isFullscreenReviewing()).toBe(true);
		await h.start();
		const visible = before.join("\n");
		const focused =
			h
				.focusedText()
				.split("\n")
				.find((row) => /问题|回答/.test(row)) ?? "";
		const label = /(问题|回答) \d/.exec(focused)?.[0] ?? "missing";
		expect(visible).toContain(label);
		expect(label).not.toBe("回答 7");
		const during = await h.viewport();
		expect(during.join("\n")).toContain(label);

		await h.press(ESC);
		expect(h.ui.isFullscreenReviewing()).toBe(true);
	});
});

describe("Enter on a focused block", () => {
	it("hints Enter only where it does something", async () => {
		const user = new UserMessageComponent("看一下");
		const summary = turn(2);
		const bare = assistant("没有思考的回答");
		const h = await createHarness([user, summary, bare]);
		await h.start();
		expect(h.focusedText()).toContain("Y 复制 · Esc 返回");
		expect(h.focusedText()).not.toContain("Enter");
		await h.press(ENTER);
		expect(summary.state.processBlockExpanded).toBe(false);

		await h.press(ALT_UP);
		expect(h.focusedText()).toContain("Enter 展开 · Y 复制");
		await h.press(ALT_UP);
		expect(h.focusedText()).toContain("看一下");
		expect(h.focusedText()).not.toContain("Enter");
	});

	it("runs quiet mode's three-step Ctrl+O cycle and the Esc close order", async () => {
		const summary = turn(12);
		const h = await createHarness([new UserMessageComponent("跑一下"), summary, assistant("完成")]);
		await h.start();
		await h.press(ALT_UP);
		expect(h.focusedText()).toContain("Enter 展开");
		await h.press(ENTER);
		expect(summary.state.processBlockExpanded).toBe(true);
		expect(summary.state.processKeyStepsView).toBe(true);
		expect(h.focusedText()).toContain("Enter 展开全部");
		await h.press(ENTER);
		expect(summary.state.processKeyStepsView).toBe(false);
		expect(summary.state.processBlockExpanded).toBe(true);
		expect(h.focusedText()).toContain("Enter 收起");
		// The open was recorded: T8's Esc close order folds it.
		expect(call(h.mode, "closeLastOpenedProcessBlock")).toBe(true);
		expect(summary.state.processBlockExpanded).toBe(false);
	});

	it("opens an answer's Thinking only when it has a trace, with a rebound toggle key in the hint", async () => {
		const keys = new KeybindingsManager({ "app.blocks.toggle": "t" });
		setKeybindings(keys);
		const summary = turn(1);
		const answer = assistant("结论", {}, "先想一想");
		const h = await createHarness([new UserMessageComponent("查"), summary, answer]);
		await h.start();
		expect(h.focusedText()).toContain("T 展开 Thinking");
		await h.press(ENTER);
		expect(summary.state.thinkingExpanded).toBe(false);
		expect(h.navigating()).toBe(false);
		await h.start();
		await h.press("t");
		expect(summary.state.thinkingExpanded).toBe(true);
		expect(h.focusedText()).toContain("T 收起 Thinking");
	});
});

describe("copy and focus on failure rows", () => {
	it("copies a failed answer's error, and focuses an 出错 row", () => {
		const failed = assistant("", { stopReason: "error", errorMessage: "503 upstream overloaded", content: [] });
		expect(failed.getBlockCopyText()).toBe("Error: 503 upstream overloaded");
		const partial = assistant("写到一半", { stopReason: "aborted", errorMessage: "连接断了" });
		expect(partial.getBlockCopyText()).toBe("写到一半\n\n连接断了");
		const interrupted = assistant("写到一半", { stopReason: "aborted", errorMessage: "Request was aborted" });
		expect(interrupted.getBlockCopyText()).toBe("写到一半");

		const row = new FocusableTextBlock("\x1b[31m出错：磁盘满了\x1b[0m", "出错：磁盘满了");
		expect(isFocusableBlock(row)).toBe(true);
		expect(row.getBlockCopyText()).toBe("出错：磁盘满了");
		row.setBlockFocus({ reveal: false });
		expect(plain(row.render(60)).join("")).toContain("Y 复制");
		expect(isFocusableBlock(new Text("plain"))).toBe(false);
	});

	it("walks onto an 出错 row the host adds", async () => {
		const h = await createHarness([new UserMessageComponent("hi"), assistant("好")]);
		const showError = (InteractiveMode.prototype as unknown as Record<string, Method>).showError;
		showError?.call(h.mode, "磁盘满了");
		await h.start();
		expect(h.focusedText()).toContain("出错：磁盘满了");
	});
});

describe("clicking a turn head", () => {
	it("applies the lanes to the turn's rows, and Ctrl+O afterwards agrees with the caret", async () => {
		const summary = turn(2);
		const row = new ToolRow();
		const answer = assistant("完成", {}, "想了想");
		const h = await createHarness([new UserMessageComponent("跑"), summary, row, answer]);
		summary.setOnLanesChange(() => call(h.mode, "handleTurnLanesClicked", summary));
		summary.render(80);
		const header = summary.getClickRegions()[0];
		expect(header).toBeDefined();
		header?.onClick({ row: 0, col: 0 });
		expect(summary.state.processBlockExpanded).toBe(true);
		expect(row.expanded).toBe(true);
		expect(plain(summary.render(80)).join("\n")).toContain("▾");

		header?.onClick({ row: 0, col: 0 });
		expect(summary.state.processBlockExpanded).toBe(false);
		expect(row.expanded).toBe(false);
		// Ctrl+O now opens (the caret says ▸), instead of doing nothing.
		call(h.mode, "cycleTurnProcess", summary);
		expect(summary.state.processBlockExpanded).toBe(true);
		expect(row.expanded).toBe(true);
		// The click-opened state was recorded for Esc too.
		header?.onClick({ row: 0, col: 0 });
		header?.onClick({ row: 0, col: 0 });
		expect(call(h.mode, "closeLastOpenedProcessBlock")).toBe(true);
		expect(row.expanded).toBe(false);
	});
});
