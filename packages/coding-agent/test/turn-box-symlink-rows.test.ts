import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { STRIP_EDITS, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { setWorkingPulseTick } from "../src/modes/interactive/theme/working-icon.js";

function usage(output: number): AssistantMessage["usage"] {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: usage(0),
		stopReason,
		timestamp,
	};
}

function host(overrides: Partial<TimelineHost> = {}): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
		...overrides,
	};
}

function quietTurn() {
	const state = new TurnActivityState(Date.now() - 5_000);
	state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
const text = (lines: readonly string[]) => plain(lines).join("\n");

/** The turn's lines once every event lists its steps. */
function openLines(turn: ReturnType<typeof quietTurn>): string[] {
	turn.summary.render(120);
	turn.summary.toggleBox();
	return plain(turn.summary.render(120));
}

/** One assistant message with a single call, and the change the kernel reported for it. */
function linkTurn(kind: "created" | "modified", at: number) {
	const turn = quietTurn();
	turn.timeline.noteMessage(
		assistant(at, [{ type: "toolCall", id: "e1", name: "ipython", arguments: { code: "" } }]),
		true,
	);
	turn.state.addStep({ toolCallId: "e1", toolName: "ipython", args: { code: "" }, status: "queued" });
	turn.state.setStepStatus("e1", "running", at + 500);
	turn.timeline.mergeStep(
		"e1",
		"ipython",
		{},
		{
			details: {
				fileChanges: [
					{
						path: "/work/app/blink.txt",
						relPath: "blink.txt",
						kind,
						scope: "project",
						added: 0,
						removed: 0,
						symlink: true,
						source: "python",
						at: 1,
					},
				],
			},
		},
		false,
	);
	turn.state.setStepStatus("e1", "done", at + 1_000);
	return turn;
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	setWorkingPulseTick(0);
	vi.useRealTimers();
});

describe("a symlink change reads as a link, not a file with +0 -0", () => {
	it("shows a newly-created link as a step of its event, with no line counts", () => {
		const at = Date.now() - 4_000;
		const turn = linkTurn("created", at);
		const closed = plain(turn.summary.render(120));
		expect(closed[0]?.startsWith(` ${formatTimelineTime(at)}   ◆      改了 1 个文件`)).toBe(true);
		expect(closed[0]?.trimEnd().endsWith("1 步 ▸")).toBe(true);
		expect(closed.join("\n")).not.toContain("blink.txt");
		const lines = openLines(turn);
		expect(lines[0]?.trimEnd().endsWith("1 步 ▴")).toBe(true);
		expect(lines[1]?.trimEnd()).toBe("         │           ✎  新建链接 blink.txt");
		const out = lines.join("\n");
		expect(out).not.toMatch(/blink\.txt.*[+＋]0/);
		expect(out).not.toContain("−0");
	});

	it("shows a re-pointed link as changed, still with no line counts", () => {
		const turn = linkTurn("modified", Date.now() - 4_000);
		const lines = openLines(turn);
		expect(lines[1]?.trimEnd()).toBe("         │           ✎  改了链接 blink.txt");
		expect(lines.join("\n")).not.toContain("−0");
	});

	it("in the finished turn's change strip, lists a link without +0 -0 counts", () => {
		const turn = linkTurn("created", Date.now() - 4_000);
		turn.state.markTurnEnded(Date.now());
		const strip = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => turn.state.boxView().facts,
			requestRender: vi.fn(),
		});
		strip.render(120);
		strip.activate(STRIP_EDITS);
		const list = text(strip.render(120));
		expect(list).toContain("新建链接");
		expect(list).toContain("blink.txt");
		expect(list).not.toContain("+0");
		expect(list).not.toContain("−0");
	});
});
