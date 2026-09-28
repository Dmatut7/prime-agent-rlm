import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KeybindingDefinition } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.js";

const DOC_PATH = fileURLToPath(new URL("../docs/keybindings.md", import.meta.url));

interface DocRow {
	id: string;
	defaults: string;
	description: string;
}

const definitions: Record<string, KeybindingDefinition> = KEYBINDINGS;

function readDocRows(): DocRow[] {
	const rows: DocRow[] = [];
	for (const line of readFileSync(DOC_PATH, "utf-8").split("\n")) {
		const match = /^\|\s*`([A-Za-z0-9_.]+)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/.exec(line);
		if (match) rows.push({ id: match[1]!, defaults: match[2]!, description: match[3]! });
	}
	return rows;
}

function codeDefaultKeys(id: string): string[] {
	const keys = definitions[id]!.defaultKeys;
	return Array.isArray(keys) ? keys : [keys];
}

describe("docs/keybindings.md matches the keybinding ids defined in code", () => {
	const codeIds = Object.keys(definitions);
	const rows = readDocRows();
	const rowById = new Map(rows.map((row) => [row.id, row]));

	it("reads a non-trivial table on both sides", () => {
		expect(codeIds.length).toBeGreaterThan(100);
		expect(rows.length).toBeGreaterThan(100);
	});

	it("documents every keybinding id the code defines", () => {
		const missing = codeIds.filter((id) => !rowById.has(id));
		expect(missing).toEqual([]);
	});

	it("documents no id the code does not define", () => {
		const unknown = rows.map((row) => row.id).filter((id) => !(id in definitions));
		expect(unknown).toEqual([]);
	});

	it("documents each id once", () => {
		const ids = rows.map((row) => row.id);
		const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
		expect(repeated).toEqual([]);
	});

	it("lists the default keys the code binds, in the Default column", () => {
		let compared = 0;
		for (const id of codeIds) {
			const row = rowById.get(id);
			if (!row) continue; // reported by the "documents every id" test
			compared++;
			const keys = codeDefaultKeys(id);
			if (keys.length === 0) {
				expect(row.defaults, id).toMatch(/none/);
				continue;
			}
			const documented = [...row.defaults.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
			for (const key of keys) {
				expect(documented, `${id} default ${key}`).toContain(key);
			}
		}
		expect(compared).toBeGreaterThan(100);
	});

	it("documents Alt+T and Alt+P, the global thinking and agent-message expanders", () => {
		const thinking = rowById.get("app.thinking.toggleAll");
		const messages = rowById.get("app.messages.expandAll");
		expect(thinking, "app.thinking.toggleAll has a row").toBeDefined();
		expect(messages, "app.messages.expandAll has a row").toBeDefined();
		expect(thinking!.defaults).toContain("`alt+t`");
		expect(messages!.defaults).toContain("`alt+p`");
	});

	it("documents the block-navigation keys", () => {
		const ids = ["app.blocks.prev", "app.blocks.next", "app.blocks.toggle", "app.blocks.copy", "app.blocks.exit"];
		expect(ids.filter((id) => !rowById.has(id))).toEqual([]);
		expect(rowById.get("app.blocks.copy")!.defaults).toContain("`y`");
	});

	it("takes the description of each added row from the code's own definition", () => {
		const added = [
			"app.agents.expand",
			"app.blocks.copy",
			"app.blocks.exit",
			"app.blocks.next",
			"app.blocks.prev",
			"app.blocks.toggle",
			"app.messages.expandAll",
			"app.stall.diagnostics",
			"app.thinking.toggleAll",
		];
		expect(added.length).toBe(9);
		for (const id of added) {
			const description = definitions[id]!.description;
			expect(description, `${id} has a description in code`).toBeTruthy();
			const row = rowById.get(id);
			expect(row, `${id} has a row in the doc`).toBeDefined();
			expect(row!.description, id).toContain(description);
		}
	});

	it("describes app.tools.expand as the latest turn's process surface, as the code does", () => {
		const description = definitions["app.tools.expand"]!.description;
		expect(description).toContain("process surface");
		expect(rowById.get("app.tools.expand")!.description).toContain(description);
	});
});
