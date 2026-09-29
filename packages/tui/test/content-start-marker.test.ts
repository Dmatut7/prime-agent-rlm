import assert from "node:assert";
import { describe, it } from "node:test";
import { CONTENT_START_MARKER } from "../src/selection-metadata.js";
import { type Component, TUI } from "../src/tui.js";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const GUTTER = " 12:03   │      ";
const rail = `${GUTTER}${CONTENT_START_MARKER}`;

class Lines implements Component {
	constructor(public lines: string[]) {}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class Recorder extends VirtualTerminal {
	written = "";
	override write(data: string): void {
		this.written += data;
		super.write(data);
	}
}

async function dragCopy(
	transcript: string[],
	from: { col: number; row: number },
	to: { col: number; row: number },
): Promise<{ copies: string[]; written: string }> {
	const terminal = new Recorder(60, 12);
	const tui = new TUI(terminal);
	const copies: string[] = [];
	tui.onCopy = (text) => copies.push(text);
	const chat = new Lines(transcript);
	tui.addChild(chat);
	tui.addChild(new Lines(["> prompt"]));
	tui.start();
	tui.enterFullscreen({ scroll: [chat], dock: new Lines(["> prompt"]) });
	await terminal.waitForRender();
	terminal.sendInput(`\x1b[<0;${from.col};${from.row}M`);
	terminal.sendInput(`\x1b[<32;${to.col};${to.row}M`);
	terminal.sendInput(`\x1b[<0;${to.col};${to.row}m`);
	await terminal.waitForRender();
	const written = terminal.written;
	tui.stop();
	return { copies, written };
}

describe("content-start marker", () => {
	it("takes no columns in width, slicing, truncation or wrapping", () => {
		const line = `${GUTTER}${CONTENT_START_MARKER}hello world`;
		assert.strictEqual(visibleWidth(line), visibleWidth(`${GUTTER}hello world`));
		assert.strictEqual(visibleWidth(sliceByColumn(line, 0, 10)), 10);
		assert.strictEqual(visibleWidth(truncateToWidth(line, 20, "…")), 20);
		const wrapped = wrapTextWithAnsi(`${CONTENT_START_MARKER}aaaa bbbb`, 4);
		assert.deepStrictEqual(
			wrapped.map((row) => row.split(CONTENT_START_MARKER).join("")),
			["aaaa", "bbbb"],
		);
	});

	it("drag-copy keeps only the content of each row and the blank rows between paragraphs", async () => {
		const transcript = [
			`${GUTTER}${CONTENT_START_MARKER}first paragraph`,
			rail,
			`${GUTTER}${CONTENT_START_MARKER}second paragraph`,
			"plain row without a gutter",
		];
		const { copies, written } = await dragCopy(transcript, { col: 1, row: 1 }, { col: 30, row: 4 });
		assert.strictEqual(copies.length, 1);
		assert.strictEqual(copies[0], "first paragraph\n\nsecond paragraph\nplain row without a gutter");
		assert.doesNotMatch(copies[0] ?? "", /\d\d:\d\d|[│┆┃◇◆]/);
		assert.strictEqual(written.includes("pi:content"), false, "the marker never reaches the terminal");
	});

	it("starting the drag inside the gutter still copies only content", async () => {
		const transcript = [`${GUTTER}${CONTENT_START_MARKER}alpha beta`, `${GUTTER}${CONTENT_START_MARKER}gamma`];
		const { copies } = await dragCopy(transcript, { col: 3, row: 1 }, { col: 40, row: 2 });
		assert.deepStrictEqual(copies, ["alpha beta\ngamma"]);
	});

	it("a partial selection inside the content keeps its own columns", async () => {
		const transcript = [`${GUTTER}${CONTENT_START_MARKER}alpha beta`];
		const start = visibleWidth(GUTTER) + 1 + 6;
		const { copies } = await dragCopy(transcript, { col: start, row: 1 }, { col: start + 4, row: 1 });
		assert.deepStrictEqual(copies, ["beta"]);
	});

	it("an inline screen paints the row without the marker", async () => {
		const terminal = new Recorder(60, 12);
		const tui = new TUI(terminal);
		tui.addChild(new Lines([`${GUTTER}${CONTENT_START_MARKER}inline text`]));
		tui.start();
		await terminal.waitForRender();
		const written = terminal.written;
		tui.stop();
		assert.ok(written.includes("inline text"));
		assert.strictEqual(written.includes("pi:content"), false);
	});
});
