import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { addCommand, addSay, host, quietTurn, text, useTruecolorTheme } from "./ui-blocks-helpers.js";

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

describe("a narrower terminal does not make old rows look new", () => {
	it("keeps a box scrolled up without a `有新内容` rule when the terminal narrows and short notes wrap onto more lines", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 24 }) });
		for (let index = 0; index < 8; index++) {
			addSay(
				turn,
				`趁等待，先查第 ${index} 个风险点：旧规则的返回值到底怎么处理。`,
				`s${index}`,
				Date.now() - 20_000 + index * 10,
			);
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
		}
		turn.summary.render(120);
		expect(turn.timeline.ui.scrollBody(-4)).toBe(true);
		turn.summary.render(120);
		expect(turn.timeline.ui.unseen).toBe(false);
		const narrow = turn.summary.render(50);
		expect(turn.timeline.ui.unseen).toBe(false);
		expect(text(narrow)).not.toContain("↓ 有新内容");
	});

	it("still says a row that really arrived while scrolled up is new", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 24 }) });
		for (let index = 0; index < 8; index++) addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
		turn.summary.render(100);
		expect(turn.timeline.ui.scrollBody(-4)).toBe(true);
		turn.summary.render(100);
		addCommand(turn, "late", "echo late", { output: "x" });
		expect(text(turn.summary.render(100))).toContain("↓ 有新内容");
	});
});
