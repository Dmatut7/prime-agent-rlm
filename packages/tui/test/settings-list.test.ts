import assert from "node:assert";
import { describe, it } from "node:test";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";
import { stripAnsi } from "../src/utils.js";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "› ",
	hint: (text) => text,
};

function makeItems(): SettingItem[] {
	return [
		{ id: "autocompact", label: "Autocompact", currentValue: "true", values: ["true", "false"] },
		{ id: "editor.padding", label: "Editor Padding", currentValue: "1", values: ["0", "1", "2"] },
	];
}

function createSearchableList(onChange: (id: string, value: string) => void) {
	return new SettingsList(makeItems(), 10, testTheme, onChange, () => {}, { enableSearch: true });
}

describe("SettingsList search", () => {
	it("feeds space to the search query instead of toggling the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = createSearchableList((id, value) => changes.push({ id, value }));

		list.handleInput("editor");
		list.handleInput(" ");

		assert.deepStrictEqual(changes, [], "a space while searching must not modify any setting");

		// The space is part of the query, so a space-carrying label still matches.
		list.handleInput("padding");
		const rendered = list.render(80).map(stripAnsi);
		assert.ok(
			rendered.some((line) => line.includes("Editor Padding")),
			"query with a space keeps its match",
		);
		assert.ok(!rendered.some((line) => line.includes("Autocompact")), "non-matching item filtered out");
	});

	it("renders the typed space in the search input", () => {
		const list = createSearchableList(() => {});

		list.handleInput("ab");
		list.handleInput(" ");
		list.handleInput("c");

		const rendered = list.render(80).map(stripAnsi);
		assert.ok(rendered[0]?.includes("ab c"), `search line should show the space, got: ${rendered[0]}`);
	});

	it("keeps Enter as the activation key while searching", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = createSearchableList((id, value) => changes.push({ id, value }));

		list.handleInput("editor");
		list.handleInput("\r");

		assert.deepStrictEqual(changes, [{ id: "editor.padding", value: "2" }]);
	});

	it("space still toggles when search is disabled", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			makeItems(),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "autocompact", value: "false" }]);
	});
});

function makeBurstItems(count: number): SettingItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `item-${index + 1}`,
		label: `item-${index + 1}`,
		currentValue: "true",
		values: ["true", "false"],
	}));
}

/** The rendered row that carries the selection cursor, without ANSI dressing. */
function selectedRow(list: SettingsList, width = 80): string {
	const rows = list.render(width).map(stripAnsi);
	return rows.find((line) => line.startsWith("› ")) ?? "<no selected row>";
}

describe("SettingsList rapid navigation", () => {
	it("digests a rapid down-arrow burst without wrapping back to the top", () => {
		// 30 keys into a 30-item list: every key is consumed and the selection
		// rests on the last item. Wrapping (the pre-fix behavior) teleports the
		// selection back to item 1, which reads to the user as lost keys.
		const list = new SettingsList(
			makeBurstItems(30),
			10,
			testTheme,
			() => {},
			() => {},
		);
		for (let index = 0; index < 30; index++) list.handleInput("\x1b[B");

		assert.ok(
			selectedRow(list).includes("item-30"),
			`30 downs must land on the last item, got: ${selectedRow(list)}`,
		);
	});

	it("keeps clamping at the last item when the burst runs past the end", () => {
		const list = new SettingsList(
			makeBurstItems(30),
			10,
			testTheme,
			() => {},
			() => {},
		);
		for (let index = 0; index < 35; index++) list.handleInput("\x1b[B");

		assert.ok(
			selectedRow(list).includes("item-30"),
			`overshooting downs stay on the last item, got: ${selectedRow(list)}`,
		);
	});

	it("keeps clamping at the first item when up runs past the top", () => {
		const list = new SettingsList(
			makeBurstItems(30),
			10,
			testTheme,
			() => {},
			() => {},
		);
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		for (let index = 0; index < 5; index++) list.handleInput("\x1b[A");

		assert.ok(
			selectedRow(list).includes("item-1"),
			`overshooting ups stay on the first item, got: ${selectedRow(list)}`,
		);
	});
});

describe("SettingsList back key", () => {
	it("closes the panel on left when the search query is empty", () => {
		let cancellations = 0;
		const list = new SettingsList(
			makeBurstItems(10),
			10,
			testTheme,
			() => {},
			() => {
				cancellations++;
			},
		);

		list.handleInput("\x1b[B");
		list.handleInput("\x1b[D");

		assert.strictEqual(cancellations, 1, "left with an empty query must close the panel");
	});

	it("keeps the selection while left edits a non-empty query", () => {
		const list = new SettingsList(
			makeBurstItems(10),
			10,
			testTheme,
			() => {},
			() => {},
			{
				enableSearch: true,
			},
		);
		list.handleInput("m"); // a query every item matches
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		assert.ok(selectedRow(list).includes("item-4"), "precondition: three downs select item-4");

		// The cursor sits inside the query, so left moves it; the query is
		// unchanged and the selection must not reset to item-1.
		list.handleInput("\x1b[D");

		assert.ok(
			selectedRow(list).includes("item-4"),
			`left inside the query must keep the selection, got: ${selectedRow(list)}`,
		);
	});
});

describe("SettingsList row layout", () => {
	it("keeps the value visible when the label is wider than the row budget", () => {
		const items: SettingItem[] = [
			{
				id: "wide",
				label: "这是一个特别特别长的设置标签名字",
				currentValue: "on",
				values: ["on", "off"],
			},
		];
		const list = new SettingsList(
			items,
			5,
			testTheme,
			() => {},
			() => {},
		);

		const lines = list.render(28).map(stripAnsi);
		const row = lines.find((line) => line.includes("这是"));
		assert.ok(row, "the setting row should render");
		assert.ok(
			row.includes("on"),
			`the value must survive an over-wide label (label side truncates), got: ${JSON.stringify(lines)}`,
		);
	});

	it("bounds the selected item's description to a fixed row budget", () => {
		const items: SettingItem[] = [{ id: "x", label: "x", currentValue: "1", description: "很长的描述。".repeat(60) }];
		const list = new SettingsList(
			items,
			5,
			testTheme,
			() => {},
			() => {},
		);

		const lines = list.render(40);
		// 1 item row + 1 blank + description rows + 1 blank + 1 hint; the
		// description must not wrap into an unbounded block under the list.
		assert.ok(
			lines.length <= 8,
			`description wrap should be capped, got ${lines.length} rows: ${JSON.stringify(lines.map(stripAnsi))}`,
		);
	});
});
