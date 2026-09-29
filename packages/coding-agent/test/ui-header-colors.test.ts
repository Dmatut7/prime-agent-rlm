import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addClosingAnswer,
	addCommand,
	addStep,
	addThought,
	plain,
	type QuietTurn,
	quietTurn,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

afterEach(() => {
	setMotionReduced(false);
});

const WIDTH = 140;

function finish(turn: QuietTurn): string {
	setMotionReduced(true);
	turn.state.markTurnEnded(Date.now());
	turn.state.finishBox(Date.now());
	return turn.summary.render(WIDTH)[2] ?? "";
}

const mutedDot = () => theme.fg("muted", " · ");

describe("the finished box header colors each count by kind", () => {
	it("paints thoughts, commands, file changes, memories and subagents in their kind's color, joined by muted dots", () => {
		const turn = quietTurn({ live: false });
		addThought(turn, "先看一下。再看一下。");
		addCommand(turn, "c1", "git status");
		addActivities(turn, "e1", [], {
			fileChanges: [
				{
					path: "/work/app/a.go",
					relPath: "a.go",
					kind: "modified",
					scope: "project",
					added: 12,
					removed: 4,
					source: "edit",
					at: 1,
				},
			],
			memoryChanges: [
				{ op: "created", kind: "memory", scope: "session", title: "一条记忆", after: "内容。", at: 3 },
			],
		});
		turn.timeline.upsertSubagent({ childId: "c1", name: "审查员", status: "done", result: "好了" });
		const raw = finish(turn);
		expect(plain([raw])[0]).toContain(
			"想了 1 次 · 跑了 1 条命令 · 改了 1 个文件 +12 −4 · 记住 1 条 · 派了 1 个子代理",
		);
		expect(raw).toContain(theme.fg("kindThink", "想了 1 次"));
		expect(raw).toContain(theme.fg("kindCommand", "跑了 1 条命令"));
		expect(raw).toContain(theme.fg("kindEdit", "改了 1 个文件 "));
		expect(raw).toContain(theme.fg("kindMemory", "记住 1 条"));
		expect(raw).toContain(theme.fg("kindSubagent", "派了 1 个子代理"));
		expect(raw.split(mutedDot())).toHaveLength(5);
	});

	it("paints a read count in the read color", () => {
		const turn = quietTurn({ live: false });
		addActivities(turn, "r1", [
			{ id: "a", kind: "read", label: "a.go", status: "ok", startedAt: 1 },
			{ id: "b", kind: "read", label: "b.go", status: "ok", startedAt: 2 },
		]);
		const raw = finish(turn);
		expect(plain([raw])[0]).toContain("读了 2 个文件");
		expect(raw).toContain(theme.fg("kindRead", "读了 2 个文件"));
	});

	it("paints a failure count red and a corrected mistake in the recovered color", () => {
		const mistake = (turn: QuietTurn) => {
			addStep(turn, "x1", "import nope", "error");
			turn.timeline.mergeStep(
				"x1",
				"ipython",
				{},
				{
					isError: true,
					details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope'", traceback: [] } },
				},
				false,
			);
		};
		const failed = quietTurn({ live: false });
		mistake(failed);
		failed.timeline.errorEnded = true;
		expect(finish(failed)).toContain(theme.fg("kindError", "1 处出错"));

		const recovered = quietTurn({ live: false });
		mistake(recovered);
		addCommand(recovered, "c1", "pip install nope");
		addClosingAnswer(recovered);
		const raw = finish(recovered);
		expect(raw).toContain(theme.fg("kindRecovered", "出错 1 次，已改正"));
		expect(raw).not.toContain(theme.fg("kindError", "出错"));
	});

	it("keeps the words themselves unchanged", () => {
		const turn = quietTurn({ live: false });
		addThought(turn, "先看一下。再看一下。");
		addCommand(turn, "c1", "git status");
		expect(plain([finish(turn)])[0]).toMatch(/▸ ✓ 想了 1 次 · 跑了 1 条命令 +\d+秒 · ↓ \d+ │$/);
	});
});
