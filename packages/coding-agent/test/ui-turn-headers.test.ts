import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { QuietCompactionNoticeComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import {
	buildConversationComponents,
	resolveTurnHeaders,
} from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { assistant, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

const HEADER = "◆ prime";

function shows(summary: TurnSummaryComponent): boolean {
	return plain(summary.render(100)).some((line) => line.includes(HEADER));
}

function turn(model: string, startedByUser: boolean): TurnSummaryComponent {
	const made = quietTurn({ live: false });
	made.state.modelId = model;
	made.state.startedByUser = startedByUser;
	return made.summary;
}

const compactionNotice = () =>
	new QuietCompactionNoticeComponent({
		role: "compactionSummary",
		summary: "总结",
		tokensBefore: 120_000,
		timestamp: T0,
	});

describe("a woken turn under the same title draws no second title", () => {
	it("hides the title of a turn that no user message opened when the title above it names the same model", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		const later = turn("glm-5.3-prime", false);
		resolveTurnHeaders([
			new UserMessageComponent("审查提交"),
			first,
			new AgentMessageComponent(handedBack("m1")),
			woken,
			new AgentMessageComponent(handedBack("m2")),
			later,
		]);
		expect([first, woken, later].map(shows)).toEqual([true, false, false]);
	});

	it("draws the title of the first turn, of a turn after a user message and of a turn on another model", () => {
		const alone = turn("glm-5.3-prime", false);
		resolveTurnHeaders([alone]);
		expect(shows(alone)).toBe(true);

		const before = turn("glm-5.3-prime", true);
		const prompted = turn("glm-5.3-prime", true);
		resolveTurnHeaders([before, new UserMessageComponent("再来一次"), prompted]);
		expect(shows(prompted)).toBe(true);

		const other = turn("glm-5.3-prime", true);
		const switched = turn("gpt-5.5", false);
		const back = turn("glm-5.3-prime", false);
		resolveTurnHeaders([other, new AgentMessageComponent(handedBack("m3")), switched, back]);
		// The nearest title shown above `back` names gpt-5.5, not its own model.
		expect([shows(other), shows(switched), shows(back)]).toEqual([true, true, true]);
	});

	it("draws the title of the first turn after a compaction", () => {
		const before = turn("glm-5.3-prime", true);
		const after = turn("glm-5.3-prime", false);
		resolveTurnHeaders([before, compactionNotice(), new AgentMessageComponent(handedBack("m4")), after]);
		expect([shows(before), shows(after)]).toEqual([true, true]);
	});

	it("leaves the box a working header row and click area when the title is gone", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		resolveTurnHeaders([first, new AgentMessageComponent(handedBack("m5")), woken]);
		const lines = plain(woken.render(100));
		expect(lines[0]).toMatch(/^ ╭─+╮$/);
		expect(lines[1]).toContain("│");
		const regions = woken.getClickRegions();
		const headerRow = regions.find((region) => region.line === 1 && !region.passive);
		expect(headerRow).toBeDefined();
		expect(regions.some((region) => region.line === 0 && region.width < 100)).toBe(false);
		const before = woken.state.boxOpen;
		headerRow?.onClick({ row: 0, col: 0 });
		expect(woken.state.boxOpen).toBe(!before);
	});

	it("moves the box's click areas down with the blank line a woken turn gets when no message row is above it", () => {
		const first = turn("glm-5.3-prime", true);
		const woken = turn("glm-5.3-prime", false);
		resolveTurnHeaders([first, woken]);
		const lines = plain(woken.render(100));
		expect(lines[0]).toBe("");
		expect(lines[1]).toMatch(/^ ╭─+╮$/);
		const regions = woken.getClickRegions();
		const headerRow = regions.find((region) => region.line === 2 && !region.passive);
		expect(headerRow).toBeDefined();
		expect(regions.some((region) => region.line < 2)).toBe(false);
	});
});

describe("the live view draws one title per question", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	it("draws no title for the turns a handed-back message wakes on the same model", () => {
		const screen = new LiveChat();
		screen.prompt("审查最近的提交");
		screen.wake("m1");
		screen.wake("m2");
		expect(screen.summaries()).toHaveLength(3);
		expect(screen.summaries().map(shows)).toEqual([true, false, false]);
		screen.flow.dispose();
	});

	it("draws the title again after a new prompt and when the model changes", () => {
		const screen = new LiveChat();
		screen.prompt("第一个问题");
		screen.wake("m1");
		screen.prompt("第二个问题");
		screen.wake("m2");
		screen.wake("m3", { model: "gpt-5.5" });
		screen.wake("m4", { model: "gpt-5.5" });
		expect(screen.summaries().map(shows)).toEqual([true, false, true, false, true, false]);
		screen.flow.dispose();
	});

	it("keeps a run no message started in the box it continues, under its one title", () => {
		const screen = new LiveChat();
		screen.prompt("第一个问题");
		screen.continueOnItsOwn();
		expect(screen.summaries()).toHaveLength(1);
		expect(screen.summaries().map(shows)).toEqual([true]);
		screen.flow.dispose();
	});
});

function toolResult(id: string, at: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: at,
	};
}

describe("a replayed conversation draws one title per question", () => {
	it("starts a turn of its own at a handed-back message, under no second title", () => {
		const call = (id: string, at: number) =>
			assistant(at, [{ type: "toolCall", id, name: "ipython", arguments: { code: "await bash('ls')" } }]);
		const messages: AgentMessage[] = [
			{ role: "user", content: "审查最近的提交", timestamp: T0 },
			call("t1", T0 + 1_000),
			toolResult("t1", T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "派出去了。" }], "stop"),
			handedBack("m1", T0 + 4_000),
			call("t2", T0 + 5_000),
			toolResult("t2", T0 + 6_000),
			assistant(T0 + 7_000, [{ type: "text", text: "审查完成。" }], "stop"),
			{ role: "user", content: "再看一下测试", timestamp: T0 + 8_000 },
			assistant(T0 + 9_000, [{ type: "text", text: "测试都过了。" }], "stop"),
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
		// The message that woke the AI after its answer starts the next turn: the answer stays under its own turn.
		expect(summaries).toHaveLength(3);
		expect(summaries.map(shows)).toEqual([true, false, true]);
		const titles = components
			.flatMap((component) => plain(component.render(100)))
			.filter((line) => line.includes(HEADER));
		expect(titles).toHaveLength(2);
	});
});
