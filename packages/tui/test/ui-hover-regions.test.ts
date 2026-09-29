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
	private regions: ClickRegion[] = [];
	constructor(
		private readonly specs: RegionSpec[],
		private readonly log: string[],
		private readonly rows = 20,
	) {}

	render(): string[] {
		// Fresh region objects on every frame, like a component that rebuilds them each render.
		this.regions = this.specs.map((spec) => ({
			line: spec.line,
			col: 0,
			width: 10,
			height: 1,
			onClick: () => {},
			hoverKey: spec.hoverKey,
			onHover: spec.report === false ? undefined : (hovered) => this.log.push(`${spec.hoverKey}:${hovered}`),
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
	tui.start();
	tui.enterFullscreen({ scroll: [new HoverTranscript(specs, log)], dock, mouse: options.mouse });
	await terminal.waitForRender();
	const settle = () => terminal.waitForRender();
	try {
		await test({
			terminal,
			tui,
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
		await withHover(specs, async ({ log, send }) => {
			await send(at(A));
			await send(at(B));
			assert.deepStrictEqual(
				log,
				["A:true", "A:false"],
				"a region with a key but no callback is not a hover target",
			);
			await send(at(A));
			await send(at(18));
			assert.deepStrictEqual(log, ["A:true", "A:false", "A:true", "A:false"], "no key means no hover either");
		});
	});

	it("keeps the hover through a left-button drag and selects text as before", async () => {
		await withHover(TWO_REGIONS, async ({ tui, terminal, log, send, settle }) => {
			const copies: string[] = [];
			tui.onCopy = (text) => copies.push(text);
			await send(at(A));
			assert.deepStrictEqual(log, ["A:true"]);

			// Press above region A, drag across region B and out again, release.
			await send(`\x1b[<0;1;${transcriptRow(A - 1)}M`);
			await send(`\x1b[<32;5;${transcriptRow(B)}M`, `\x1b[<32;${BLANK_X};${transcriptRow(B)}M`);
			assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection is highlighted while dragging");
			await send(`\x1b[<0;${BLANK_X};${transcriptRow(B)}m`);
			await settle();
			assert.strictEqual(copies.length, 1, "the drag copied its selection on release");
			assert.strictEqual(copies[0], "row 12\nrow 13\nrow 14\nrow 15\nrow 16");
			assert.deepStrictEqual(log, ["A:true"], "the drag never changed the hover");

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

	it("does not clear the hover on keyboard input or wheel scrolling", async () => {
		await withHover(TWO_REGIONS, async ({ log, send }) => {
			await send(at(A));
			await send("x", "\x1b[5~", "\x1b[<64;3;5M");
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
