import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { stripAnsi } from "../src/utils.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const autocompleteProvider: AutocompleteProvider = {
	async getSuggestions() {
		return {
			prefix: "/",
			items: [
				{ value: "/help", label: "help" },
				{ value: "/hotkeys", label: "hotkeys" },
			],
		};
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		const nextLines = [...lines];
		const line = nextLines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		nextLines[cursorLine] = before + item.value + line.slice(cursorCol);
		return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
	},
};

async function createOpenAutocomplete(): Promise<Editor> {
	const tui = new TUI(new VirtualTerminal(40, 12));
	const editor = new Editor(tui, defaultEditorTheme);
	tui.setFocus(editor);
	editor.setAutocompleteProvider(autocompleteProvider);
	editor.handleInput("/");
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
	return editor;
}

describe("editor autocomplete overlay", () => {
	it("anchors the overlay to the active input row", async () => {
		const editor = await createOpenAutocomplete();
		const lines = editor.render(40);

		assert.equal(lines[0]?.includes("\x1b_pi:autocomplete:"), false);
		assert.equal(lines[1]?.includes("\x1b_pi:autocomplete:"), true);
	});

	it("closes synchronously when typing leaves the completion context", async () => {
		const editor = await createOpenAutocomplete();

		editor.handleInput("/");

		assert.equal(editor.getText(), "//");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("keeps the overlay visible when fullscreen clips the editor top row", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.setFocus(editor);
		editor.setAutocompleteProvider(autocompleteProvider);
		tui.start();
		tui.enterFullscreen({ scroll: [], dock: editor, mouse: false });

		editor.handleInput("/");
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		tui.requestRender(true);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("help"));
		assert.ok(viewport[1]?.includes("hotkeys"));
		assert.ok(viewport[3]?.includes("/"));
		tui.stop();
	});

	it("keeps one suggestion visible when the editor is at the terminal top edge", async () => {
		const terminal = new VirtualTerminal(40, 3);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setAutocompleteProvider(autocompleteProvider);
		tui.start();

		editor.handleInput("/");
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		tui.requestRender(true);
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// One row of budget: the selected suggestion survives, not the tail of the list.
		assert.ok(viewport[0]?.includes("help"));
		assert.ok(viewport[1]?.includes("/"));
		tui.stop();
	});

	it("keeps the selected suggestion visible when the popup is clipped to fewer rows than the list", async () => {
		const manyItemsProvider: AutocompleteProvider = {
			async getSuggestions() {
				return {
					prefix: "/",
					kind: "slash-command",
					items: Array.from({ length: 8 }, (_, i) => ({
						value: `/cmd${i}`,
						label: `cmd${i}`,
						description: "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod",
					})),
				};
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const nextLines = [...lines];
				const line = nextLines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol - prefix.length);
				nextLines[cursorLine] = before + item.value + line.slice(cursorCol);
				return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
			},
		};

		class StaticContent {
			lines = ["s0", "s1"];
			render(_width: number): string[] {
				return this.lines;
			}
			invalidate(): void {}
		}

		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.addChild(new StaticContent());
		tui.addChild(editor);
		tui.setFocus(editor);
		editor.setAutocompleteProvider(manyItemsProvider);
		tui.start();

		editor.handleInput("/");
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		// Move the selection off the first item: clipping must follow it.
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		tui.requestRender(true);
		await terminal.waitForRender();

		// Two rows of budget above the input: the selected item and its neighbor
		// survive; the scroll info and the multi-line description drop first.
		const viewport = terminal.getViewport();
		assert.ok(
			viewport[0]?.includes("cmd1"),
			`row 0 should show the candidate above the selection, got: ${viewport[0]}`,
		);
		assert.ok(viewport[1]?.includes("cmd2"), `row 1 should show the selected candidate, got: ${viewport[1]}`);
		assert.ok(
			viewport.every((line) => !line.includes("lorem")),
			"the description block is dropped before any candidate row",
		);
		assert.ok(viewport[3]?.includes("/"), "the input row stays put below the popup");
		tui.stop();
	});
});

describe("editor autocomplete list and caret moves", () => {
	it("closes the list on a caret move, so accepting cannot splice at a stale prefix", async () => {
		// With the list open, moving the caret and then accepting used to apply
		// the completion against the OLD prefix position: "@doc" + ← + Tab
		// produced "@do" + the completion spliced mid-word.
		const editor = await createOpenAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		editor.handleInput("\x1b[D"); // cursorLeft
		assert.equal(editor.isShowingAutocomplete(), false);

		// Tab with the list closed is the indent/autocomplete key, not a splice:
		// whatever it does, the line must not contain the completion wedged
		// into the middle of the typed text.
		editor.handleInput("\t");
		await new Promise((resolve) => setImmediate(resolve));
		const line = editor.render(40)[1] ?? "";
		assert.ok(!stripAnsi(line).includes("@do@"), `no mid-word splice, got ${JSON.stringify(line)}`);
	});

	it("closes the list on Home, End and word jumps, the same caret-move rule", async () => {
		const moves: Array<[string, string]> = [
			["\x1b[H", "home"],
			["\x1b[F", "end"],
			["\x1b[1;5D", "ctrl+left (word left)"],
			["\x1b[1;5C", "ctrl+right (word right)"],
		];
		assert.equal(moves.length, 4);
		for (const [key, label] of moves) {
			const editor = await createOpenAutocomplete();
			editor.handleInput(key);
			assert.equal(
				editor.isShowingAutocomplete(),
				false,
				`the list must close on ${label} (${JSON.stringify(key)})`,
			);
			editor.render(40);
		}
	});
});
