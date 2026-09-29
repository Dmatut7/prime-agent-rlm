import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, host, plain, type QuietTurn, quietTurn } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

type Hand = "none" | "open-while-running" | "close-while-running" | "open-after-end";

interface Outcome {
	/** The event lists its steps, just before the turn ended. */
	duringRun: boolean;
	afterEnd: boolean;
}

const WIDTH = 80;

/** Whether the turn's lines list the command step, and whether the state says an event is open (they must agree). */
function stepsListed(turn: QuietTurn): boolean {
	const listed = plain(turn.summary.render(WIDTH)).some((line) => line.includes("$  npm test"));
	expect(turn.state.boxOpen).toBe(listed);
	return listed;
}

/** Runs one turn with the two settings and one thing done by hand, and reads whether the event lists its steps. */
function run(openWhileWorking: boolean, autoFold: boolean, hand: Hand): Outcome {
	const turn: QuietTurn = quietTurn({
		host: host({ openWhileWorking: () => openWhileWorking, autoFold: () => autoFold }),
	});
	addCommand(turn, "c1", "npm test");
	const toggleTo = (open: boolean): void => {
		if (turn.state.boxOpen !== open) turn.summary.toggleBox();
	};
	if (hand === "open-while-running") {
		// An opening of their own: close first when it had been left open.
		toggleTo(false);
		toggleTo(true);
	}
	if (hand === "close-while-running") {
		// Close it, having opened it first when it had been left closed.
		toggleTo(true);
		toggleTo(false);
	}
	const duringRun = stepsListed(turn);
	turn.state.markTurnEnded();
	turn.state.finishBox();
	if (hand === "open-after-end") {
		// Open it after the turn ended, closing first when it had been left open.
		toggleTo(false);
		toggleTo(true);
	}
	return { duringRun, afterEnd: stepsListed(turn) };
}

describe("an event the user opened or closed by hand, under every setting", () => {
	// The two settings are ignored: what the user did decides it. Nothing is open by default, and the
	// end of the turn folds every event, one opened while the turn ran included.
	// [openWhileWorking, autoFold, hand] -> [steps listed during the run, steps listed once the turn ended]
	const outcomeOf: Record<Hand, [boolean, boolean]> = {
		none: [false, false],
		"open-while-running": [true, false],
		"close-while-running": [false, false],
		"open-after-end": [false, true],
	};
	const table: Array<[boolean, boolean, Hand, boolean, boolean]> = [];
	for (const openWhileWorking of [true, false]) {
		for (const autoFold of [true, false]) {
			for (const hand of Object.keys(outcomeOf) as Hand[]) {
				const [duringRun, afterEnd] = outcomeOf[hand];
				table.push([openWhileWorking, autoFold, hand, duringRun, afterEnd]);
			}
		}
	}

	it("covers every combination of the two settings and the three things a user does", () => {
		expect(table.length).toBe(16);
		const combos = new Set(table.map(([open, fold, hand]) => `${open}/${fold}/${hand}`));
		expect(combos.size).toBe(16);
	});

	for (const [openWhileWorking, autoFold, hand, duringRun, afterEnd] of table) {
		it(`open-while-working=${openWhileWorking} auto-fold=${autoFold} hand=${hand}: steps ${duringRun ? "listed" : "hidden"} while it runs, ${afterEnd ? "listed" : "hidden"} once it ended`, () => {
			expect(run(openWhileWorking, autoFold, hand)).toEqual({ duringRun, afterEnd });
		});
	}

	it("folds an event that was opened while the turn ran when the turn ends, even with both settings off", () => {
		const turn = quietTurn({ host: host({ openWhileWorking: () => false, autoFold: () => false }) });
		addCommand(turn, "c1", "npm test");
		turn.summary.toggleBox();
		expect(stepsListed(turn)).toBe(true);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		expect(stepsListed(turn)).toBe(false);
	});
});
