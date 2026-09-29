import assert from "node:assert";
import { describe, it } from "node:test";
import type { ClickRegion } from "../src/click-regions.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

interface RegionSpec {
	line: number;
	hoverKey?: string;
	report?: boolean;
}

// Screen (40x10): one dock row, so nine transcript rows show. Twenty rows are
// followed to the end, which puts transcript row 11 on screen row 1 (y=1).
const transcriptRow = (line: number) => line - 10;
const A = 13;
const B = 16;
const BLANK_Y = transcriptRow(11);
const BLANK_X = 30;

class HoverTranscript implements Component {
	/** Frames built so far; each hover callback remembers the frame whose region it came from. */
	generation = 0;
	readonly stamped: string[] = [];
	private regions: ClickRegion[] = [];
	constructor(
		private readonly specs: RegionSpec[],
		private readonly log: string[],
		public rows = 20,
	) {}

	render(): string[] {
		// Fresh region objects on every frame, like a component that rebuilds them each render.
		const generation = ++this.generation;
		this.regions = this.specs.map((spec) => ({
			line: spec.line,
			col: 0,
			width: 10,
			height: 1,
			onClick: () => {},
			hoverKey: spec.hoverKey,
			onHover:
				spec.report === false
					? undefined
					: (hovered) => {
							this.log.push(`${spec.hoverKey}:${hovered}`);
							this.stamped.push(`${spec.hoverKey}:${hovered}@${generation}`);
						},
		}));
		return Array.from({ length: this.rows }, (_, index) => `row ${index}`);
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}
}

class CountingDock implements Component {
	frames = 0;
	render(): string[] {
		this.frames++;
		return ["> prompt"];
	}
	invalidate(): void {}
}

const move = (x: number, y: number) => `\x1b[<35;${x};${y}M`;
const at = (line: number) => move(3, transcriptRow(line));

interface Harness {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	transcript: HoverTranscript;
	log: string[];
	dock: CountingDock;
	settle: () => Promise<void>;
	send: (...inputs: string[]) => Promise<void>;
	frames: () => number;
}

async function withHover(
	specs: RegionSpec[],
	test: (harness: Harness) => Promise<void>,
	options: { mouse?: boolean } = {},
): Promise<void> {
	const terminal = new LoggingVirtualTerminal(40, 10);
	const tui = new TUI(terminal);
	const log: string[] = [];
	const dock = new CountingDock();
	const transcript = new HoverTranscript(specs, log);
	tui.start();
	tui.enterFullscreen({ scroll: [transcript], dock, mouse: options.mouse });
	await terminal.waitForRender();
	const settle = () => terminal.waitForRender();
	try {
		await test({
			terminal,
			tui,
			transcript,
			log,
			dock,
			settle,
			frames: () => dock.frames,
			send: async (...inputs) => {
				for (const input of inputs) terminal.sendInput(input);
				await settle();
			},
		});
	} finally {
		tui.stop();
	}
}

const TWO_REGIONS: RegionSpec[] = [
	{ line: A, hoverKey: "A" },
	{ line: B, hoverKey: "B" },
];

describe("fullscreen hover", () => {
	it("reports enter and leave in order across two regions and empty space, one redraw per change", async () => {
		await withHover(TWO_REGIONS, async ({ log, send, frames }) => {
			let before = frames();
			await send(at(A));
			assert.deepStrictEqual(log, ["A:true"]);
			assert.strictEqual(frames() - before, 1, "entering A redraws once");

			before = frames();
			await send(move(1, transcriptRow(A)), move(5, transcriptRow(A)), move(10, transcriptRow(A)), at(A));
			assert.deepStrictEqual(log, ["A:true"], "moving inside A reports nothing");
			assert.strictEqual(frames() - before, 0, "moving inside A does not redraw");

			before = frames();
			await send(at(B));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true"]);
			assert.strictEqual(frames() - before, 1, "A to B redraws once");

			before = frames();
			await send(move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true", "B:false"]);
			assert.strictEqual(frames() - before, 1, "leaving into empty space redraws once");

			before = frames();
			await send(move(BLANK_X, BLANK_Y), move(BLANK_X + 1, BLANK_Y), move(11, transcriptRow(A)));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true", "B:false"], "empty space stays quiet");
			assert.strictEqual(frames() - before, 0, "empty space does not redraw");
		});
	});

	it("treats the first cell past a region's width as outside", async () => {
		await withHover(TWO_REGIONS, async ({ log, send }) => {
			await send(move(10, transcriptRow(A)));
			await send(move(11, transcriptRow(A)));
			assert.deepStrictEqual(log, ["A:true", "A:false"]);
		});
	});

	it("does not report a leave or an enter when the region is rebuilt with the same key", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send, settle, frames }) => {
			await send(at(A));
			assert.deepStrictEqual(log, ["A:true"]);

			const before = frames();
			for (let i = 0; i < 3; i++) {
				tui.requestRender();
				await settle();
			}
			assert.ok(frames() - before >= 3, "the frames really were rebuilt");
			await send(at(A), move(6, transcriptRow(A)));
			assert.deepStrictEqual(log, ["A:true"], "same key across frames is the same hover");

			await send(move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(log, ["A:true", "A:false"], "a single leave, from whichever frame's region");
		});
	});

	it("ignores regions without both a hoverKey and an onHover, and leaves the hover it had", async () => {
		const specs: RegionSpec[] = [
			{ line: A, hoverKey: "A" },
			{ line: B, hoverKey: "no-callback", report: false },
			{ line: 18, hoverKey: undefined },
		];
		await withHover(specs, async ({ log, send, frames }) => {
			await send(at(A));
			let before = frames();
			await send(at(B));
			assert.deepStrictEqual(
				log,
				["A:true", "A:false"],
				"a region with a key but no callback is not a hover target",
			);
			assert.strictEqual(frames() - before, 1, "leaving A redraws once; the keyed-only region adds nothing");
			await send(at(A));
			before = frames();
			await send(at(18));
			assert.deepStrictEqual(log, ["A:true", "A:false", "A:true", "A:false"], "no key means no hover either");
			assert.strictEqual(frames() - before, 1, "leaving A redraws once");
			before = frames();
			await send(at(B), at(18), at(B));
			assert.strictEqual(frames() - before, 0, "moving over regions that do not take part never redraws");
		});
	});

	it("keeps the hover through a left-button drag, selects text as before, and follows the pointer after it", async () => {
		await withHover(TWO_REGIONS, async ({ tui, terminal, log, send, settle }) => {
			const copies: string[] = [];
			tui.onCopy = (text) => copies.push(text);
			await send(at(A));
			assert.deepStrictEqual(log, ["A:true"]);

			// Press above region A, drag across region B and out again, release.
			await send(`\x1b[<0;1;${transcriptRow(A - 1)}M`);
			await send(`\x1b[<32;5;${transcriptRow(B)}M`, `\x1b[<32;${BLANK_X};${transcriptRow(B)}M`);
			assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection is highlighted while dragging");
			assert.deepStrictEqual(log, ["A:true"], "the drag never changed the hover");
			await send(`\x1b[<0;${BLANK_X};${transcriptRow(B)}m`);
			await settle();
			assert.strictEqual(copies.length, 1, "the drag copied its selection on release");
			assert.strictEqual(copies[0], "row 12\nrow 13\nrow 14\nrow 15\nrow 16");
			assert.deepStrictEqual(log, ["A:true", "A:false"], "released over empty space: the hover follows the pointer");

			await send(at(B));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true"], "hover works again after the drag");
		});
	});

	it("does not treat right or middle button drags as a hover move", async () => {
		await withHover(TWO_REGIONS, async ({ log, send }) => {
			await send(at(A));
			await send(`\x1b[<34;3;${transcriptRow(B)}M`, `\x1b[<33;3;${transcriptRow(B)}M`);
			assert.deepStrictEqual(log, ["A:true"]);
		});
	});

	it("does not clear the hover on keyboard input, or on a wheel tick that moves nothing", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send, frames }) => {
			tui.setFocus({ render: () => [], invalidate: () => {}, handleInput: () => {} });
			await send(at(A));
			const before = frames();
			await send("x");
			assert.ok(frames() > before, "a key press repaints, which re-checks the pointer cell");
			// Already at the bottom, so the wheel tick has nowhere to scroll and A stays under the pointer.
			await send(`\x1b[<65;3;${transcriptRow(A)}M`);
			assert.deepStrictEqual(log, ["A:true"]);
		});
	});

	it("clears the hover when an overlay takes the focus, and stays quiet while it has it", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send, settle }) => {
			await send(at(A));
			const menu: Component = { render: () => ["menu"], invalidate: () => {}, handleInput: () => {} };
			const handle = tui.showOverlay(menu, { width: 10, anchor: "bottom-right" });
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false"]);

			await send(at(B), at(A), move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(log, ["A:true", "A:false"], "no hover while an overlay has the focus");

			handle.hide();
			await settle();
			await send(at(B));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true"], "hover resumes once the overlay is gone");
		});
	});

	it("clears the hover when an overlay suspends mouse tracking without taking the focus", async () => {
		await withHover(TWO_REGIONS, async ({ tui, terminal, log, send, settle }) => {
			await send(at(B));
			const banner: Component = { render: () => ["banner"], invalidate: () => {} };
			const handle = tui.showOverlay(banner, {
				width: 10,
				anchor: "bottom-right",
				nonCapturing: true,
				suspendFullscreenMouse: true,
			});
			await settle();
			assert.strictEqual(terminal.mouseTrackingActive, false);
			assert.deepStrictEqual(log, ["B:true", "B:false"]);

			handle.hide();
			await settle();
			assert.strictEqual(terminal.mouseTrackingActive, true);
			await send(at(B));
			assert.deepStrictEqual(log, ["B:true", "B:false", "B:true"]);
		});
	});

	it("clears the hover when fullscreen ends, and again starts clean in the next fullscreen", async () => {
		await withHover(TWO_REGIONS, async ({ tui, terminal, log, send, settle }) => {
			await send(at(A));
			tui.exitFullscreen();
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false"]);

			const again: string[] = [];
			tui.enterFullscreen({ scroll: [new HoverTranscript(TWO_REGIONS, again)], dock: new CountingDock() });
			await settle();
			await send(at(A));
			assert.deepStrictEqual(again, ["A:true"], "the new fullscreen has its own hover, not the old one");
			assert.strictEqual(terminal.mouseTrackingActive, true);
			await send(move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(again, ["A:true", "A:false"]);
		});
	});

	it("clears the hover when the TUI stops", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const log: string[] = [];
		tui.start();
		tui.enterFullscreen({ scroll: [new HoverTranscript(TWO_REGIONS, log)], dock: new CountingDock() });
		await terminal.waitForRender();
		terminal.sendInput(at(B));
		await terminal.waitForRender();
		tui.stop();
		assert.deepStrictEqual(log, ["B:true", "B:false"]);
	});

	it("ignores moves entirely when the session has mouse tracking off", async () => {
		await withHover(
			TWO_REGIONS,
			async ({ terminal, log, send }) => {
				assert.strictEqual(terminal.mouseTrackingActive, false);
				await send(at(A), at(B));
				assert.deepStrictEqual(log, []);
			},
			{ mouse: false },
		);
	});
});

describe("hover moves stay out of the input path", () => {
	const HOVER_MOVES = [at(A), move(5, transcriptRow(A)), `\x1b[<39;3;${transcriptRow(B)}M`, move(BLANK_X, BLANK_Y)];

	it("never hands a pure pointer move to input listeners, while clicks, drags and wheel still reach them", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send }) => {
			const received: string[] = [];
			tui.addInputListener((data) => {
				received.push(data);
				return undefined;
			});
			assert.ok(HOVER_MOVES.length > 0);

			await send(...HOVER_MOVES);
			assert.deepStrictEqual(received, [], "the listener saw no hover move");
			assert.ok(log.length > 0, "the moves still drove the hover");

			const others = [
				`\x1b[<0;${BLANK_X};${transcriptRow(A)}M`,
				`\x1b[<32;${BLANK_X};${transcriptRow(B)}M`,
				`\x1b[<0;${BLANK_X};${transcriptRow(B)}m`,
				"\x1b[<64;3;5M",
				"x",
			];
			await send(...others);
			assert.deepStrictEqual(received, others, "everything else is forwarded as before");
		});
	});

	it("swallows moves in a session with mouse tracking off, and in inline mode", async () => {
		await withHover(
			TWO_REGIONS,
			async ({ tui, send }) => {
				const received: string[] = [];
				tui.addInputListener((data) => {
					received.push(data);
					return undefined;
				});
				await send(...HOVER_MOVES);
				assert.deepStrictEqual(received, []);
			},
			{ mouse: false },
		);

		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const listened: string[] = [];
		const typed: string[] = [];
		tui.addInputListener((data) => {
			listened.push(data);
			return undefined;
		});
		tui.addChild({ render: () => ["> "], invalidate: () => {}, handleInput: (data: string) => typed.push(data) });
		const input = tui.children[0]!;
		tui.setFocus(input);
		tui.start();
		try {
			for (const sequence of HOVER_MOVES) terminal.sendInput(sequence);
			terminal.sendInput("x");
			assert.deepStrictEqual(listened, ["x"]);
			assert.deepStrictEqual(typed, ["x"], "the focused component never sees a pointer move");
		} finally {
			tui.stop();
		}
	});

	it("does not light a region up under a modal overlay that has not reclaimed the keyboard yet", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send }) => {
			const menu: Component = { render: () => ["menu"], invalidate: () => {}, handleInput: () => {} };
			tui.showOverlay(menu, { width: 10, anchor: "bottom-right" });
			const other: Component = { render: () => [], invalidate: () => {}, handleInput: () => {} };
			tui.setFocus(other);
			await send(at(A), at(B));
			assert.deepStrictEqual(log, []);
		});
	});
});

describe("hover follows the content under a still pointer", () => {
	// B sits directly below A, so one row of upward movement carries the pointer from A to B.
	const STACKED: RegionSpec[] = [
		{ line: 12, hoverKey: "B" },
		{ line: A, hoverKey: "A" },
		{ line: 14, hoverKey: "C" },
	];

	it("re-checks the pointer cell after a wheel scroll moves other content under it", async () => {
		await withHover(STACKED, async ({ log, send }) => {
			await send(at(A));
			// Wheel up one row: transcript row 12 now sits where row 13 was.
			await send("\x1b[<64;3;3M");
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true"]);
		});
	});

	it("re-checks after the transcript grows and follow mode shifts the content up", async () => {
		await withHover(STACKED, async ({ tui, transcript, log, send, settle }) => {
			await send(at(A));
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true"]);
			await send(move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true", "C:false"]);
		});
	});

	it("does nothing, and redraws nothing, when the content under the pointer stays put", async () => {
		await withHover(STACKED, async ({ tui, log, send, settle, frames }) => {
			await send(at(A));
			const before = frames();
			for (let i = 0; i < 5; i++) {
				tui.requestRender();
				await settle();
			}
			assert.strictEqual(frames() - before, 5, "each requested frame is one frame, none follow from it");
			assert.deepStrictEqual(log, ["A:true"]);
		});
	});

	it("settles after a change: the frame that follows a hover change finds the same key and stops", async () => {
		await withHover(STACKED, async ({ tui, transcript, log, send, settle, frames }) => {
			await send(at(A));
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			const before = frames();
			await settle();
			await settle();
			assert.strictEqual(frames(), before, "no further frames once the hover matches the pointer");
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true"]);
		});
	});

	it("has nothing to re-check once an overlay took the focus, until the pointer moves again", async () => {
		await withHover(STACKED, async ({ tui, transcript, log, send, settle }) => {
			await send(at(A));
			const menu: Component = { render: () => ["menu"], invalidate: () => {}, handleInput: () => {} };
			const handle = tui.showOverlay(menu, { width: 10, anchor: "bottom-right" });
			await settle();
			handle.hide();
			await settle();
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false"], "the old pointer position was forgotten");
			await send(at(A));
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true"], "the next move starts hovering again");
		});
	});

	it("keeps the hover while the left button is held, and follows the pointer once it is released", async () => {
		await withHover(STACKED, async ({ tui, transcript, log, send, settle }) => {
			await send(at(A));
			await send(`\x1b[<0;${BLANK_X};${BLANK_Y}M`);
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true"], "content moved during a press, hover unchanged");

			await send(`\x1b[<0;3;3m`);
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true"], "after the release the pointer's cell decides");
		});
	});

	it("does not re-check under a modal overlay that became visible before it took the keyboard back", async () => {
		await withHover(STACKED, async ({ tui, terminal, transcript, log, send, settle }) => {
			const menu: Component = { render: () => ["menu"], invalidate: () => {}, handleInput: () => {} };
			// Too narrow to show at first; no input has come since it turned visible, so it has not reclaimed the focus.
			tui.showOverlay(menu, { width: 10, anchor: "bottom-right", visible: (columns) => columns >= 50 });
			await send(at(A));
			terminal.resize(60, 10);
			await settle();
			assert.ok(tui.hasOverlay(), "the overlay is visible now");
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true"], "the content moved, but the hover is left alone under the overlay");
		});
	});

	it("takes a plain move as proof that the left button is up again after a lost release", async () => {
		await withHover(STACKED, async ({ tui, transcript, log, send, settle }) => {
			await send(at(A));
			await send(`\x1b[<0;${BLANK_X};${BLANK_Y}M`);
			await send(at(A));
			transcript.rows = 21;
			tui.requestRender();
			await settle();
			assert.deepStrictEqual(log, ["A:true", "A:false", "C:true"]);
		});
	});

	it("uses the newest frame's region for the leave callback", async () => {
		await withHover(TWO_REGIONS, async ({ tui, transcript, send, settle }) => {
			const entered = transcript.generation;
			await send(at(A));
			for (let i = 0; i < 2; i++) {
				tui.requestRender();
				await settle();
			}
			await send(move(5, transcriptRow(A)));
			const newest = transcript.generation;
			assert.ok(newest > entered);
			await send(move(BLANK_X, BLANK_Y));
			assert.deepStrictEqual(transcript.stamped, [`A:true@${entered}`, `A:false@${newest}`]);
		});
	});
});

describe("legacy (non-SGR) hover moves", () => {
	// X10 encoding: ESC [ M, then button, column, row, each as 32 + value.
	const legacy = (button: number, x: number, y: number) =>
		`\x1b[M${String.fromCharCode(32 + button)}${String.fromCharCode(32 + x)}${String.fromCharCode(32 + y)}`;
	const legacyHover = (line: number) => legacy(35, 3, transcriptRow(line));

	it("drives hover like an SGR move and never reaches listeners", async () => {
		await withHover(TWO_REGIONS, async ({ tui, log, send }) => {
			const received: string[] = [];
			tui.addInputListener((data) => {
				received.push(data);
				return undefined;
			});
			await send(legacyHover(A), legacy(39, 3, transcriptRow(B)), legacy(35, BLANK_X, BLANK_Y));
			assert.deepStrictEqual(log, ["A:true", "A:false", "B:true", "B:false"]);
			assert.deepStrictEqual(received, []);

			const press = legacy(0, 3, transcriptRow(A));
			await send(press);
			assert.deepStrictEqual(received, [press], "a legacy click is forwarded as before");
		});
	});

	it("is swallowed in inline mode too", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const typed: string[] = [];
		tui.addChild({ render: () => ["> "], invalidate: () => {}, handleInput: (data: string) => typed.push(data) });
		tui.setFocus(tui.children[0]!);
		tui.start();
		try {
			terminal.sendInput(legacyHover(A));
			terminal.sendInput("x");
			assert.deepStrictEqual(typed, ["x"]);
		} finally {
			tui.stop();
		}
	});
});

describe("a hover callback that changes the layout", () => {
	// Hovering inserts a hint row above the region, so the region moves out from under the pointer.
	class ShiftyTranscript implements Component {
		hovered = false;
		calls = 0;
		render(): string[] {
			const lines = Array.from({ length: 8 }, (_, index) => `row ${index}`);
			if (this.hovered) lines.splice(3, 0, "hint");
			return lines;
		}
		getClickRegions(): ReadonlyArray<ClickRegion> {
			return [
				{
					line: this.hovered ? 4 : 3,
					col: 0,
					width: 10,
					height: 1,
					onClick: () => {},
					hoverKey: "A",
					onHover: (hovered) => {
						this.calls++;
						this.hovered = hovered;
					},
				},
			];
		}
		invalidate(): void {}
	}

	async function withShifty(
		test: (ctx: {
			shifty: ShiftyTranscript;
			dock: CountingDock;
			send: (...inputs: string[]) => Promise<void>;
		}) => Promise<void>,
	): Promise<void> {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const shifty = new ShiftyTranscript();
		const dock = new CountingDock();
		tui.start();
		tui.enterFullscreen({ scroll: [shifty], dock });
		await terminal.waitForRender();
		try {
			await test({
				shifty,
				dock,
				send: async (...inputs) => {
					for (const input of inputs) terminal.sendInput(input);
					await terminal.waitForRender();
				},
			});
		} finally {
			tui.stop();
		}
	}

	// The transcript is top-aligned here, so row N of it is screen row N + 1.
	const onRegion = move(3, 4);
	const elsewhere = move(30, 8);

	it("redraws a bounded number of times after one input instead of chasing the region for ever", async () => {
		await withShifty(async ({ shifty, dock, send }) => {
			const before = dock.frames;
			await send(onRegion);
			for (let i = 0; i < 10; i++) await send();
			assert.ok(dock.frames - before <= 2, `frames after one input: ${dock.frames - before}`);
			assert.ok(shifty.calls <= 2, `onHover calls after one input: ${shifty.calls}`);
			const frames = dock.frames;
			const calls = shifty.calls;
			for (let i = 0; i < 10; i++) await send();
			assert.strictEqual(dock.frames, frames, "and it stays quiet afterwards");
			assert.strictEqual(shifty.calls, calls);
		});
	});

	it("allows the same again after the next input", async () => {
		await withShifty(async ({ shifty, dock, send }) => {
			await send(onRegion);
			await send(elsewhere);
			for (let i = 0; i < 5; i++) await send();
			const frames = dock.frames;
			const calls = shifty.calls;
			await send(onRegion);
			for (let i = 0; i < 10; i++) await send();
			assert.ok(dock.frames - frames <= 2, `frames after the second input: ${dock.frames - frames}`);
			assert.ok(shifty.calls - calls >= 1, "the second input hovers again");
			assert.ok(shifty.calls - calls <= 2, `onHover calls after the second input: ${shifty.calls - calls}`);
		});
	});
});
