import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, host, type QuietTurn, quietTurn } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

type Hand = "none" | "open-while-running" | "close-while-running" | "open-after-end";

interface Outcome {
	/** The box body, just before the turn ended. */
	duringRun: boolean;
	afterEnd: boolean;
}

/** Runs one turn with the two settings and one thing done by hand, and reads whether the box body shows. */
function run(openWhileWorking: boolean, autoFold: boolean, hand: Hand): Outcome {
	const turn: QuietTurn = quietTurn({
		host: host({ openWhileWorking: () => openWhileWorking, autoFold: () => autoFold }),
	});
	addCommand(turn, "c1", "npm test");
	const toggleTo = (open: boolean): void => {
		if (turn.state.boxOpen !== open) turn.summary.toggleBox();
	};
	if (hand === "open-while-running") {
		// An opening of their own: close first when the settings had left it open.
		toggleTo(false);
		toggleTo(true);
	}
	if (hand === "close-while-running") {
		// Close it, having opened it first when the settings had left it closed.
		toggleTo(true);
		toggleTo(false);
	}
	const duringRun = turn.state.boxOpen;
	turn.state.markTurnEnded();
	turn.state.finishBox();
	if (hand === "open-after-end") {
		// Open it after the turn ended, closing first when the settings had left it open.
		toggleTo(false);
		toggleTo(true);
	}
	return { duringRun, afterEnd: turn.state.boxOpen };
}

describe("a box the user opened or closed by hand, under every setting", () => {
	// [openWhileWorking, autoFold, hand] -> [body during the run, body after the turn ended]
	const table: Array<[boolean, boolean, Hand, boolean, boolean]> = [
		[true, true, "none", true, false],
		[true, true, "open-while-running", true, false],
		[true, true, "close-while-running", false, false],
		[true, true, "open-after-end", true, true],
		[true, false, "none", true, true],
		[true, false, "open-while-running", true, true],
		[true, false, "close-while-running", false, false],
		[true, false, "open-after-end", true, true],
		[false, true, "none", false, false],
		[false, true, "open-while-running", true, false],
		[false, true, "close-while-running", false, false],
		[false, true, "open-after-end", false, true],
		[false, false, "none", false, false],
		[false, false, "open-while-running", true, true],
		[false, false, "close-while-running", false, false],
		[false, false, "open-after-end", false, true],
	];

	it("covers every combination of the two settings and the three things a user does", () => {
		expect(table.length).toBe(16);
		const combos = new Set(table.map(([open, fold, hand]) => `${open}/${fold}/${hand}`));
		expect(combos.size).toBe(16);
	});

	for (const [openWhileWorking, autoFold, hand, duringRun, afterEnd] of table) {
		it(`open-while-working=${openWhileWorking} auto-fold=${autoFold} hand=${hand}: body ${duringRun ? "shows" : "hidden"} while it runs, ${afterEnd ? "shows" : "hidden"} once it ended`, () => {
			expect(run(openWhileWorking, autoFold, hand)).toEqual({ duringRun, afterEnd });
		});
	}

	it("keeps a box open that was opened while the turn ran when neither setting opens or folds it", () => {
		const turn = quietTurn({ host: host({ openWhileWorking: () => false, autoFold: () => false }) });
		addCommand(turn, "c1", "npm test");
		turn.summary.toggleBox();
		expect(turn.state.boxOpen).toBe(true);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(turn.state.boxOpen).toBe(true);
	});
});
