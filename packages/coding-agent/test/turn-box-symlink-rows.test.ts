import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
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
	it("shows a newly-created link in the turn box, with no line counts", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "toolCall", id: "e1", name: "ipython", arguments: { code: "" } }]),
			true,
		);
		turn.state.addStep({ toolCallId: "e1", toolName: "ipython", args: { code: "" }, status: "queued" });
		turn.state.setStepStatus("e1", "running", Date.now() - 3_500);
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
							kind: "created",
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
		turn.state.setStepStatus("e1", "done", Date.now() - 3_000);
		const out = text(turn.summary.render(120));
		expect(out).toContain("新建链接 blink.txt");
		expect(out).not.toMatch(/blink\.txt.*[+＋]0/);
		expect(out).not.toContain("−0");
	});

	it("shows a re-pointed link as changed, still with no line counts", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "toolCall", id: "e1", name: "ipython", arguments: { code: "" } }]),
			true,
		);
		turn.state.addStep({ toolCallId: "e1", toolName: "ipython", args: { code: "" }, status: "queued" });
		turn.state.setStepStatus("e1", "running", Date.now() - 3_500);
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
							kind: "modified",
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
		turn.state.setStepStatus("e1", "done", Date.now() - 3_000);
		const out = text(turn.summary.render(120));
		expect(out).toContain("改了链接 blink.txt");
		expect(out).not.toContain("−0");
	});

	it("in the finished turn's change strip, lists a link without +0 -0 counts", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "toolCall", id: "e1", name: "ipython", arguments: { code: "" } }]),
			true,
		);
		turn.state.addStep({ toolCallId: "e1", toolName: "ipython", args: { code: "" }, status: "queued" });
		turn.state.setStepStatus("e1", "running", Date.now() - 3_500);
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
							kind: "created",
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
		turn.state.setStepStatus("e1", "done", Date.now() - 3_000);
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
