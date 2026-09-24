import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	BLOCK_REVEAL_MARKER,
	BlockNavigator,
	blockFocusHint,
	decorateFocusedBlock,
} from "../src/modes/interactive/components/block-focus.js";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function assistant(text: string): AssistantMessageComponent {
	return new AssistantMessageComponent({
		role: "assistant",
		content: [{ type: "text", text }],
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
	});
}

function turn(): TurnSummaryComponent {
	const state = new TurnActivityState(1_000);
	state.addStep({ toolCallId: "t1", toolName: "bash", args: { command: "ls" }, status: "done" });
	state.markTurnEnded(2_000);
	const summary = new TurnSummaryComponent(state);
	summary.setQuiet(true);
	return summary;
}

describe("block focus decoration", () => {
	it("paints every row, puts the key hint on the first row and the reveal marker only when asked", () => {
		const lines = ["", " first row", " second row"];
		const plain = decorateFocusedBlock(lines, 60, { reveal: false });
		expect(plain).toHaveLength(3);
		expect(strip(plain[1] ?? "")).toContain(blockFocusHint());
		expect(strip(plain[2] ?? "")).not.toContain("复制");
		expect(plain.join("")).not.toContain(BLOCK_REVEAL_MARKER);
		const revealed = decorateFocusedBlock(lines, 60, { reveal: true });
		expect(revealed[1]?.startsWith(BLOCK_REVEAL_MARKER)).toBe(true);
		expect(blockFocusHint()).toBe("Enter 展开 · Y 复制 · Esc 返回");
	});

	it("routes navigator keys and hands every other key back to the prompt", () => {
		const handlers = { move: vi.fn(), toggle: vi.fn(), copy: vi.fn(), exit: vi.fn() };
		const navigator = new BlockNavigator(handlers);
		navigator.handleInput("\x1b[1;3A");
		navigator.handleInput("\x1b[1;3B");
		navigator.handleInput("\r");
		navigator.handleInput(" ");
		navigator.handleInput("y");
		navigator.handleInput("\x1b");
		navigator.handleInput("h");
		expect(handlers.move.mock.calls).toEqual([[-1], [1]]);
		expect(handlers.toggle).toHaveBeenCalledTimes(2);
		expect(handlers.copy).toHaveBeenCalledTimes(1);
		expect(handlers.exit.mock.calls).toEqual([[], ["h"]]);
	});
});

describe("InteractiveMode block navigation", () => {
	function createMode(children: unknown[]) {
		const chatContainer = new Container();
		for (const child of children) chatContainer.addChild(child as never);
		const editor = { handleInput: vi.fn() };
		const mode: any = {
			chatContainer,
			editor,
			connectionState: { sessionActions: { steering: [], followUps: [] } },
			queueSelection: { isBrowsing: false },
			uiServices: { settingsManager: { getProcessMode: () => "quiet" as const } },
			toolOutputExpanded: false,
			thinkingExpanded: false,
			agentMessagesExpanded: false,
			editDiffsExpanded: false,
			ui: {
				terminal: { columns: 100 },
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: () => false,
				setFullscreenRevealMarker: vi.fn(),
			},
			focusEditor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("walks blocks from the newest, toggles the focused turn, and returns keys to the prompt on exit", () => {
		const user = new UserMessageComponent("看一下目录");
		const summary = turn();
		const answer = assistant("目录里有 4 个包。");
		const mode = createMode([user, summary, answer]);

		mode.startBlockNavigation(-1);
		expect(mode.blockNavigation.focused).toBe(answer);
		expect(mode.ui.setFocus).toHaveBeenCalledWith(mode.blockNavigation.navigator);
		expect(strip(answer.render(100).join("\n"))).toContain("复制");

		mode.moveBlockFocus(-1);
		expect(mode.blockNavigation.focused).toBe(summary);
		expect(strip(answer.render(100).join("\n"))).not.toContain("复制");
		expect(summary.state.processBlockExpanded).toBe(false);
		mode.toggleFocusedBlock();
		expect(summary.state.processBlockExpanded).toBe(true);

		mode.moveBlockFocus(-1);
		mode.moveBlockFocus(-1);
		expect(mode.blockNavigation.focused).toBe(user);

		mode.exitBlockNavigation("x");
		expect(mode.blockNavigation).toBeUndefined();
		expect(mode.focusEditor).toHaveBeenCalled();
		expect(mode.editor.handleInput).toHaveBeenCalledWith("x");
		expect(strip(user.render(100).join("\n"))).not.toContain("复制");
	});

	it("toggles an answer's Thinking and copies its markdown source", async () => {
		const summary = turn();
		const answer = assistant("**结论**：没问题。");
		const mode = createMode([new UserMessageComponent("查一下"), summary, answer]);
		mode.startBlockNavigation(-1);
		mode.toggleFocusedBlock();
		expect(summary.state.thinkingBlockExpanded).toBe(true);
		expect(mode.blockNavigation.focused.getBlockCopyText()).toBe("**结论**：没问题。");
		expect(new UserMessageComponent("原样 __name__").getBlockCopyText()).toBe("原样 __name__");
	});

	it("does nothing with an empty chat, and browses the queue instead when messages are pending", () => {
		const empty = createMode([]);
		empty.startBlockNavigation(-1);
		expect(empty.blockNavigation).toBeUndefined();

		const queued = createMode([new UserMessageComponent("hi")]);
		queued.connectionState.sessionActions.followUps = ["later"];
		expect(queued.hasBrowsableQueue()).toBe(true);
	});
});
