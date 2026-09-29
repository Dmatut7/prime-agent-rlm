import assert from "node:assert";
import { describe, it } from "node:test";
import type { ClickPosition, ClickRegion, StickyHeader } from "../src/click-regions.js";
import { type Component, Container, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const MARKER = "\x1b_pi:sticky-focus\x07";

interface HeaderSpec {
	line: number;
	endLine: number;
	tag?: string;
	height?: number;
	regions?: ClickRegion[];
	renders?: number[];
}

function header(spec: HeaderSpec): StickyHeader {
	const tag = spec.tag ?? "BOX";
	return {
		line: spec.line,
		endLine: spec.endLine,
		render: (past) => {
			spec.renders?.push(past);
			return Array.from({ length: spec.height ?? 2 }, (_, i) =>
				i === 0 ? `${tag} past=${past}` : `${tag} hint${i}`,
			);
		},
		regions: spec.regions,
	};
}

class Tall implements Component {
	rows: string[];
	headers: StickyHeader[] = [];
	regions: ClickRegion[] = [];
	stableOutput: string[] | undefined;
	constructor(count: number) {
		this.rows = Array.from({ length: count }, (_, i) => `row ${i}`);
	}
	render(): string[] {
		if (this.stableOutput) return this.stableOutput;
		return [...this.rows];
	}
	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}
	getStickyHeaders(): ReadonlyArray<StickyHeader> {
		return this.headers;
	}
	invalidate(): void {}
}

const plain = (lines: string[]): Component => ({ render: () => lines, invalidate: () => {} });

interface Rig {
	terminal: VirtualTerminal;
	tui: TUI;
	comp: Tall;
	screen: () => string[];
	settle: () => Promise<void>;
	scrollTo: (top: number) => Promise<void>;
	send: (...inputs: string[]) => Promise<void>;
}

async function withSticky(
	options: { rows?: number; cols?: number; height?: number; pin?: Component; setup?: (comp: Tall) => void },
	test: (rig: Rig) => Promise<void>,
): Promise<void> {
	const terminal = new VirtualTerminal(options.cols ?? 40, options.height ?? 10);
	const tui = new TUI(terminal);
	const comp = new Tall(options.rows ?? 60);
	options.setup?.(comp);
	tui.start();
	tui.enterFullscreen({ scroll: [comp], dock: plain(["> prompt"]), pin: options.pin });
	await terminal.waitForRender();
	const settle = () => terminal.waitForRender();
	try {
		await test({
			terminal,
			tui,
			comp,
			screen: () => terminal.getViewport(),
			settle,
			scrollTo: async (top) => {
				const info = tui.getScrollInfo();
				assert.ok(info, "fullscreen is active");
				tui.scrollBy(top - info.linesAbove);
				await settle();
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, top, `window top is ${top}`);
			},
			send: async (...inputs) => {
				for (const input of inputs) terminal.sendInput(input);
				await settle();
			},
		});
	} finally {
		tui.stop();
	}
}

const wholeBox = (comp: Tall, spec: Partial<HeaderSpec> = {}) => {
	comp.headers = [header({ line: 5, endLine: comp.rows.length - 1, ...spec })];
};
const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
const hover = (x: number, y: number) => `\x1b[<35;${x};${y}M`;
const WHEEL_UP = (x: number, y: number) => `\x1b[<64;${x};${y}M`;
const WHEEL_DOWN = (x: number, y: number) => `\x1b[<65;${x};${y}M`;

describe("fullscreen sticky headers: judging and drawing", () => {
	it("pins the header of a box taller than the screen while following the bottom", async () => {
		const renders: number[] = [];
		await withSticky({ setup: (comp) => wholeBox(comp, { renders }) }, async ({ screen }) => {
			const rows = screen();
			assert.strictEqual(rows[0], "BOX past=46");
			assert.strictEqual(rows[1], "BOX hint1");
			assert.strictEqual(rows[2], "row 53");
			assert.strictEqual(rows[8], "row 59");
			assert.strictEqual(rows[9], "> prompt");
			assert.ok(renders.length > 0);
			assert.ok(
				renders.every((past) => past === 46),
				`only the current scroll distance is asked for: ${renders}`,
			);
		});
	});

	it("does not pin while the header row is still on screen and pins once it has scrolled past", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp) }, async ({ screen, scrollTo }) => {
			await scrollTo(0);
			assert.ok(!screen().some((line) => line.includes("BOX")));
			await scrollTo(4);
			assert.strictEqual(screen()[1], "row 5");
			assert.ok(!screen().some((line) => line.includes("BOX")));
			await scrollTo(5);
			assert.strictEqual(screen()[0], "row 5", "the header's own row is at the top edge: nothing above it to pin");
			await scrollTo(6);
			assert.deepStrictEqual(screen().slice(0, 3), ["BOX past=1", "BOX hint1", "row 8"]);
			await scrollTo(20);
			assert.deepStrictEqual(screen().slice(0, 3), ["BOX past=15", "BOX hint1", "row 22"]);
		});
	});

	it("stops pinning once the rest of the box cannot hold the pinned rows", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp, { endLine: 20 }) }, async ({ screen, scrollTo }) => {
			await scrollTo(18);
			assert.deepStrictEqual(
				screen().slice(0, 3),
				["BOX past=13", "BOX hint1", "row 20"],
				"the bottom line stays visible",
			);
			await scrollTo(19);
			assert.strictEqual(screen()[0], "row 19");
			assert.ok(!screen().some((line) => line.includes("BOX")));
			await scrollTo(40);
			assert.ok(!screen().some((line) => line.includes("BOX")), "past the box: nothing pinned");
		});
	});

	it("shows at most three rows and never more than the window height minus one, cut to the width", async () => {
		await withSticky(
			{
				setup: (comp) => {
					comp.headers = [
						{
							line: 5,
							endLine: 59,
							render: () => ["A".repeat(100), "B", "C", "D", "E"],
						},
					];
				},
			},
			async ({ screen }) => {
				assert.deepStrictEqual(screen().slice(0, 4), ["A".repeat(40), "B", "C", "row 54"]);
			},
		);
		for (const height of [4, 3, 2, 1]) {
			await withSticky(
				{
					height,
					setup: (comp) => {
						comp.headers = [header({ line: 5, endLine: 59, height: 3 })];
					},
				},
				async ({ tui, screen }) => {
					const window = tui.getScrollInfo()?.windowHeight ?? 0;
					assert.ok(window >= 1, `window ${window} at height ${height}`);
					const rows = screen();
					assert.ok(
						rows[window - 1]?.startsWith("row "),
						`height ${height}: the last window row is transcript: ${rows}`,
					);
					if (window >= 2) assert.ok(rows[0]?.startsWith("BOX past="), `height ${height}: ${rows}`);
				},
			);
		}
	});

	it("keeps the pinned rows under the top bar and picks the innermost of two nested headers", async () => {
		await withSticky(
			{
				pin: plain(["TOP BAR"]),
				setup: (comp) => wholeBox(comp),
			},
			async ({ screen }) => {
				assert.deepStrictEqual(screen().slice(0, 4), ["TOP BAR", "BOX past=47", "BOX hint1", "row 54"]);
			},
		);
		await withSticky(
			{
				setup: (comp) => {
					comp.headers = [
						header({ line: 20, endLine: 40, tag: "IN" }),
						header({ line: 3, endLine: 59, tag: "OUT" }),
					];
				},
			},
			async ({ screen, scrollTo }) => {
				await scrollTo(10);
				assert.strictEqual(screen()[0], "OUT past=7");
				await scrollTo(30);
				assert.strictEqual(screen()[0], "IN past=10", "the innermost header wins");
				await scrollTo(38);
				assert.strictEqual(screen()[0], "IN past=18");
				await scrollTo(39);
				assert.strictEqual(
					screen()[0],
					"OUT past=36",
					"the inner box is too near its end: the outer one still holds",
				);
				await scrollTo(45);
				assert.strictEqual(screen()[0], "OUT past=42");
			},
		);
	});

	it("asks only the header it pins, however many headers the transcript has", async () => {
		const counters: number[][] = [];
		await withSticky(
			{
				rows: 3000,
				setup: (comp) => {
					comp.headers = Array.from({ length: 300 }, (_, i) => {
						const renders: number[] = [];
						counters.push(renders);
						return header({ line: i * 10, endLine: i * 10 + 9, tag: `H${i}`, renders });
					});
				},
			},
			async ({ screen }) => {
				assert.deepStrictEqual(screen().slice(0, 2), ["H299 past=1", "H299 hint1"]);
				const asked = counters.flatMap((renders, i) => (renders.length > 0 ? [i] : []));
				assert.deepStrictEqual(asked, [299]);
			},
		);
	});

	it("keeps pinning across frames the aggregator serves from its cache", async () => {
		const clicks: ClickPosition[] = [];
		await withSticky(
			{
				setup: (comp) => {
					comp.stableOutput = [...comp.rows];
					wholeBox(comp, {
						regions: [{ line: 0, col: 0, width: 40, height: 1, onClick: (p) => clicks.push(p) }],
					});
				},
			},
			async ({ tui, screen, settle, send }) => {
				for (let i = 0; i < 3; i++) {
					tui.requestRender();
					await settle();
				}
				assert.strictEqual(screen()[0], "BOX past=46");
				await send(press(3, 1), release(3, 1));
				assert.deepStrictEqual(clicks, [{ row: 0, col: 2 }]);
			},
		);
	});

	it("does not pin, or even ask for rows, outside fullscreen", async () => {
		const renders: number[] = [];
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new Tall(30);
		wholeBox(comp, { renders });
		tui.addChild(comp);
		tui.start();
		await terminal.waitForRender();
		try {
			assert.ok(!terminal.getScrollBuffer().some((line) => line.includes("BOX past")));
			assert.deepStrictEqual(renders, []);
		} finally {
			tui.stop();
		}
	});
});

describe("fullscreen sticky headers: aggregation through containers", () => {
	class ClassHeader implements StickyHeader {
		readonly regions: ClickRegion[];
		constructor(
			readonly line: number,
			readonly endLine: number,
			region: ClickRegion,
		) {
			this.regions = [region];
		}
		render(scrolledPast: number): readonly string[] {
			return [`class header ${scrolledPast}`];
		}
	}

	it("offsets line and endLine through nested containers and keeps render and regions working", () => {
		const region: ClickRegion = { line: 0, col: 1, width: 5, height: 1, onClick: () => {} };
		const leaf = new Tall(6);
		leaf.headers = [new ClassHeader(1, 4, region)];
		const inner = new Container();
		inner.addChild(plain(["a", "b"]));
		inner.addChild(leaf);
		const outer = new Container();
		outer.addChild(plain(["x", "y", "z"]));
		outer.addChild(inner);
		outer.addChild(plain(["tail"]));
		assert.deepStrictEqual(outer.getStickyHeaders(), [], "nothing before the first render");
		assert.strictEqual(outer.render(40).length, 3 + 2 + 6 + 1);
		const [only, ...rest] = outer.getStickyHeaders();
		assert.deepStrictEqual(rest, []);
		assert.strictEqual(only?.line, 1 + 2 + 3);
		assert.strictEqual(only?.endLine, 4 + 2 + 3);
		assert.deepStrictEqual(only?.render(7), ["class header 7"]);
		assert.deepStrictEqual(only?.regions, [region]);
		assert.deepStrictEqual(
			inner.getStickyHeaders().map((h) => [h.line, h.endLine]),
			[[3, 6]],
		);
		outer.removeChild(inner);
		assert.deepStrictEqual(outer.getStickyHeaders(), []);
	});
});

describe("fullscreen sticky headers: clicks, hover and wheel", () => {
	it("sends a click on a pinned row to the header's region and not to the transcript under it", async () => {
		const header0: ClickPosition[] = [];
		const header1: ClickPosition[] = [];
		const transcript: ClickPosition[] = [];
		await withSticky(
			{
				setup: (comp) => {
					comp.regions = [{ line: 0, col: 0, width: 40, height: 60, onClick: (p) => transcript.push(p) }];
					wholeBox(comp, {
						regions: [
							{ line: 0, col: 0, width: 20, height: 1, onClick: (p) => header0.push(p) },
							{ line: 1, col: 0, width: 40, height: 1, onClick: (p) => header1.push(p) },
						],
					});
				},
			},
			async ({ tui, send }) => {
				await send(press(3, 1), release(3, 1));
				assert.deepStrictEqual(header0, [{ row: 0, col: 2 }]);
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 51, "a click that leaves the box alone moves nothing");
				assert.strictEqual(tui.getScrollInfo()?.following, true);
				await send(press(5, 2), release(5, 2));
				assert.deepStrictEqual(header1, [{ row: 0, col: 4 }]);
				// The pinned row beyond the region's width covers transcript pixels too.
				await send(press(30, 1), release(30, 1));
				assert.deepStrictEqual(transcript, [], "pinned pixels swallow clicks aimed at rows beneath them");
				await send(press(3, 3), release(3, 3));
				assert.deepStrictEqual(transcript, [{ row: 53, col: 2 }]);
				assert.strictEqual(header0.length, 1);
				assert.strictEqual(header1.length, 1);
			},
		);
	});

	it("reports hover on pinned rows to the header region and not to the transcript under them", async () => {
		const log: string[] = [];
		const tracked = (key: string, line: number, height: number): ClickRegion => ({
			line,
			col: 0,
			width: 40,
			height,
			hoverKey: key,
			onClick: () => {},
			onHover: (on) => log.push(`${key}:${on}`),
		});
		await withSticky(
			{
				setup: (comp) => {
					comp.regions = [tracked("T", 0, 60)];
					wholeBox(comp, { regions: [tracked("H", 0, 2)] });
				},
			},
			async ({ send }) => {
				await send(hover(3, 1));
				assert.deepStrictEqual(log, ["H:true"]);
				await send(hover(3, 2));
				assert.deepStrictEqual(log, ["H:true"], "both pinned rows are the same region");
				await send(hover(3, 5));
				assert.deepStrictEqual(log, ["H:true", "H:false", "T:true"]);
				await send(hover(3, 1));
				assert.deepStrictEqual(log, ["H:true", "H:false", "T:true", "T:false", "H:true"]);
			},
		);
	});

	it("moves the hover to the header when a pin appears under a still pointer", async () => {
		const log: string[] = [];
		const tracked = (key: string, line: number, height: number): ClickRegion => ({
			line,
			col: 0,
			width: 40,
			height,
			hoverKey: key,
			onClick: () => {},
			onHover: (on) => log.push(`${key}:${on}`),
		});
		await withSticky(
			{
				setup: (comp) => {
					comp.regions = [tracked("T", 0, 60)];
					wholeBox(comp, { regions: [tracked("H", 0, 2)] });
				},
			},
			async ({ send, scrollTo }) => {
				await scrollTo(5);
				await send(hover(3, 1));
				assert.deepStrictEqual(log, ["T:true"]);
				await send(WHEEL_DOWN(3, 1));
				assert.deepStrictEqual(log, ["T:true", "T:false", "H:true"]);
			},
		);
	});

	it("scrolls the transcript when the wheel turns over a pinned row, unless the header region takes it", async () => {
		const directions: number[] = [];
		let take = false;
		await withSticky(
			{
				setup: (comp) =>
					wholeBox(comp, {
						regions: [
							{
								line: 0,
								col: 0,
								width: 40,
								height: 1,
								onClick: () => {},
								onWheel: (direction) => {
									directions.push(direction);
									return take;
								},
							},
						],
					}),
			},
			async ({ tui, screen, send }) => {
				await send(WHEEL_UP(3, 2));
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 50);
				assert.strictEqual(screen()[0], "BOX past=45", "over a row with no region the transcript scrolls");
				await send(WHEEL_UP(3, 1));
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 49, "the region declined: the transcript scrolls");
				take = true;
				await send(WHEEL_UP(3, 1));
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 49, "the region scrolled its own content");
				assert.deepStrictEqual(directions, [-1, -1]);
				await send(WHEEL_DOWN(3, 2), WHEEL_DOWN(3, 2));
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 51);
			},
		);
	});
});

describe("fullscreen sticky headers: rows that must stay visible", () => {
	const reveal = async (rig: Rig, row: number): Promise<void> => {
		rig.comp.rows[row] = `${MARKER}row ${row}`;
		rig.tui.setFullscreenRevealMarker(MARKER);
		await rig.settle();
	};

	it("puts a marked row below the pinned rows when it scrolls into view", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp) }, async (rig) => {
			await reveal(rig, 30);
			const rows = rig.screen();
			assert.deepStrictEqual(rows.slice(0, 5), ["BOX past=21", "BOX hint1", "row 28", "row 29", "row 30"]);
		});
	});

	it("moves a marked row that sits under the pinned rows, and leaves one that is visible", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp) }, async (rig) => {
			await rig.scrollTo(30);
			assert.strictEqual(rig.screen()[1], "BOX hint1", "row 31 is hidden by the second pinned row");
			await reveal(rig, 31);
			assert.strictEqual(rig.screen()[4], "row 31");
			assert.strictEqual(rig.tui.getScrollInfo()?.linesAbove, 27);
		});
		await withSticky({ setup: (comp) => wholeBox(comp) }, async (rig) => {
			await rig.scrollTo(30);
			await reveal(rig, 35);
			assert.strictEqual(rig.tui.getScrollInfo()?.linesAbove, 30, "already visible below the pins");
		});
	});

	it("keeps the usual two rows of context when nothing is pinned above the marked row", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp) }, async (rig) => {
			await reveal(rig, 5);
			assert.strictEqual(rig.tui.getScrollInfo()?.linesAbove, 3);
			assert.strictEqual(rig.screen()[2], "row 5");
			assert.ok(!rig.screen().some((line) => line.includes("BOX")));
		});
	});

	it("keeps a clicked row below the pins while the rows it opens render under it", async () => {
		await withSticky(
			{
				setup: (comp) => {
					wholeBox(comp);
					comp.regions = [
						{
							line: 53,
							col: 0,
							width: 40,
							height: 1,
							revealBelow: 20,
							onClick: () => {
								comp.rows.splice(54, 0, ...Array.from({ length: 20 }, (_, i) => `open ${i}`));
								wholeBox(comp);
							},
						},
					];
				},
			},
			async ({ screen, send }) => {
				assert.strictEqual(screen()[2], "row 53");
				await send(press(3, 3), release(3, 3));
				const rows = screen();
				assert.deepStrictEqual(rows.slice(0, 4), ["BOX past=46", "BOX hint1", "row 53", "open 0"]);
			},
		);
	});

	it("does not leave a clicked row under a header that only starts pinning because of the click", async () => {
		await withSticky(
			{
				setup: (comp) => {
					comp.headers = [header({ line: 5, endLine: 31 })];
					comp.regions = [
						{
							line: 30,
							col: 0,
							width: 40,
							height: 1,
							revealBelow: 1,
							onClick: () => {
								comp.headers = [header({ line: 5, endLine: 59 })];
							},
						},
					];
				},
			},
			async ({ screen, send, scrollTo }) => {
				await scrollTo(30);
				assert.strictEqual(screen()[0], "row 30", "the box ends too soon to pin");
				await send(press(3, 1), release(3, 1));
				const rows = screen();
				assert.ok(rows[0]?.startsWith("BOX past="), `${rows}`);
				assert.strictEqual(rows[2], "row 30");
			},
		);
	});

	it("shows the header row again after a click on the pinned header shrinks the box", async () => {
		await withSticky(
			{
				rows: 100,
				setup: (comp) => {
					comp.headers = [
						header({
							line: 5,
							endLine: 59,
							regions: [
								{
									line: 0,
									col: 0,
									width: 40,
									height: 1,
									onClick: () => {
										comp.rows.splice(6, 50);
										comp.headers = [];
									},
								},
							],
						}),
					];
				},
			},
			async ({ tui, screen, send, scrollTo }) => {
				await scrollTo(30);
				assert.ok(screen()[0]?.startsWith("BOX past="));
				await send(press(3, 1), release(3, 1));
				assert.strictEqual(screen()[0], "row 5", "the collapsed box's header is where the window starts");
				assert.strictEqual(tui.getScrollInfo()?.linesAbove, 5);
			},
		);
	});
});

describe("fullscreen sticky headers: paging", () => {
	const PAGE_UP = "\x1b[5~";
	const PAGE_DOWN = "\x1b[6~";

	it("pages without skipping the rows the pinned header covers", async () => {
		await withSticky({ setup: (comp) => wholeBox(comp) }, async ({ screen, scrollTo, send }) => {
			// The follow hint takes the window's last row, so the last row seen is one above it.
			await scrollTo(0);
			assert.strictEqual(screen()[7], "row 7");
			await send(PAGE_DOWN);
			assert.deepStrictEqual(screen().slice(0, 3), ["BOX past=1", "BOX hint1", "row 8"], "row 8 follows row 7");
			await scrollTo(30);
			assert.strictEqual(screen()[7], "row 37");
			await send(PAGE_DOWN);
			assert.strictEqual(screen()[2], "row 38", "row 38 follows row 37");
			await send(PAGE_UP);
			assert.strictEqual(screen()[2], "row 32");
			await send(PAGE_UP);
			assert.strictEqual(screen()[7], "row 31", "row 31 precedes row 32, the first row seen before");
		});
	});
});

describe("fullscreen sticky headers: collapsing from the pinned header while following", () => {
	it("keeps following the newest line when the box collapses under a window at the bottom", async () => {
		await withSticky(
			{
				rows: 100,
				setup: (comp) => {
					comp.headers = [
						header({
							line: 5,
							endLine: 99,
							regions: [
								{
									line: 0,
									col: 0,
									width: 40,
									height: 1,
									onClick: () => {
										comp.rows.splice(6, 50);
										comp.headers = [];
									},
								},
							],
						}),
					];
				},
			},
			async ({ tui, screen, send }) => {
				assert.ok(screen()[0]?.startsWith("BOX past="));
				await send(press(3, 1), release(3, 1));
				assert.strictEqual(tui.getScrollInfo()?.following, true);
				assert.strictEqual(screen()[8], "row 99");
			},
		);
	});
});

describe("fullscreen sticky headers: selecting text", () => {
	it("never selects the pinned rows: dragging into them stops at the first row below and copies transcript text only", async () => {
		const copies: string[] = [];
		await withSticky({ setup: (comp) => wholeBox(comp) }, async ({ tui, send }) => {
			tui.onCopy = (text) => copies.push(text);
			await send(press(3, 6), `\x1b[<32;3;1M`);
			await send(release(3, 1));
			assert.deepStrictEqual(copies, ["w 53\nrow 54\nrow 55\nro"]);
		});
	});

	it("starts no selection from a pinned row", async () => {
		const copies: string[] = [];
		await withSticky({ setup: (comp) => wholeBox(comp) }, async ({ tui, screen, send }) => {
			tui.onCopy = (text) => copies.push(text);
			await send(press(3, 1), `\x1b[<32;3;6M`);
			await send(release(3, 6));
			assert.deepStrictEqual(copies, []);
			assert.strictEqual(screen()[0], "BOX past=46");
		});
	});
});
