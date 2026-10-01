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
