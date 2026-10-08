import { type Component, TruncatedText, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
} from "../src/modes/interactive/components/menu-panel.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

class StaticComponent implements Component {
	invalidate(): void {
		// Static test component has no cached state.
	}

	render(_width: number): string[] {
		return ["first", "second"];
	}
}

describe("MenuPanel", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a surface-style menu panel with padded rows", () => {
		const panel = new MenuPanel({ title: "Menu", subtitle: "Pick one." });
		panel.addChild(new StaticComponent());

		const lines = panel.render(24);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Menu");
		expect(output).toContain("Pick one.");
		expect(output).toContain("first");
		expect(output).toContain("second");
		expect(output).not.toContain("╭");
		expect(output).not.toContain("│");
		expect(output).not.toContain("╰");
		expect(stripAnsi(lines[0] ?? "").trim()).toBe("");
		expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(24);
		}
	});

	it("renders search fields without the shell prompt", () => {
		const field = new MenuSearchInput("Search models");
		const output = stripAnsi(field.render(24).join("\n"));

		expect(output).toContain("Search models");
		expect(output).not.toContain("> ");
		expect(visibleWidth(output)).toBe(24);
	});

	it("keeps the menu background behind ellipses", () => {
		const panel = new MenuPanel({ title: "Menu" });
		panel.addChild(new TruncatedText(theme.fg("muted", "A long line that must be truncated")));

		const line = panel.render(24).find((value) => stripAnsi(value).includes("A long line"));
		const backgroundEllipsis = theme.getEditorBackgroundColor()?.("...");

		expect(line).toBeDefined();
		expect(backgroundEllipsis).toBeDefined();
		expect(line).toContain(backgroundEllipsis);
	});

	it("renders selected rows as full-width surfaces without a cursor glyph", () => {
		const row = new MenuRow({
			primary: "openai/gpt-5",
			secondary: "openai",
			meta: "current",
			selected: true,
		});
		const lines = row.render(40);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("openai/gpt-5");
		expect(output).toContain("openai");
		expect(output).toContain("current");
		expect(output).not.toContain("›");
		expect(lines).toHaveLength(4);
		expect(stripAnsi(lines[0] ?? "").trim()).toBe("");
		expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	it("marks truncated row content with an ellipsis instead of a silent cut", () => {
		const row = new MenuRow({
			primary: "a-very-long-model-name-that-cannot-fit",
			secondary: "provider · session · every 45m · steer",
			selected: false,
		});

		const lines = row.render(30).map((line) => stripAnsi(line));
		const primaryLine = lines.find((line) => line.includes("a-very-long"));
		const secondaryLine = lines.find((line) => line.includes("provider"));

		expect(primaryLine).toContain("…");
		expect(secondaryLine).toContain("…");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(30);
		}
	});

	it("does not ellipsize row content that fits", () => {
		const row = new MenuRow({ primary: "short", secondary: "fits fine", selected: false });

		const lines = row.render(60).map((line) => stripAnsi(line));

		expect(lines.join("\n")).not.toContain("…");
		expect(lines.join("\n")).toContain("fits fine");
	});

	it("collapses adjacent row padding around the selected row", () => {
		const createList = (selectedIndex: number): MenuList => {
			const list = new MenuList();
			list.addChild(
				new MenuRow({
					primary: "first",
					secondary: "provider",
					selected: selectedIndex === 0,
				}),
			);
			list.addChild(
				new MenuRow({
					primary: "second",
					secondary: "provider",
					selected: selectedIndex === 1,
				}),
			);
			return list;
		};

		const firstSelectedLines = createList(0).render(40);
		const lines = createList(1).render(40);
		const output = lines.map((line) => stripAnsi(line));
		const selectedIndex = output.findIndex((line) => line.includes("second"));

		expect(lines).toHaveLength(firstSelectedLines.length);
		expect(selectedIndex).toBeGreaterThan(0);
		expect(output[selectedIndex - 1]?.trim()).toBe("");
		expect(output[selectedIndex - 2]?.trim()).not.toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	it("uses compact list layout when the comfortable layout would overflow", () => {
		const layout = getMenuListLayout({
			getRows: () => 24,
			preferredVisibleItems: 8,
			reservedRows: 8,
			comfortableItemRows: 3,
			compactItemRows: 2,
		});

		expect(layout).toEqual({ compact: true, visibleItems: 8 });
	});

	it("reserves scroll indicator rows when sizing visible items", () => {
		const layout = getMenuListLayout({
			getRows: () => 16,
			preferredVisibleItems: 10,
			totalItems: 12,
			reservedRows: 12,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: 1,
		});

		expect(layout).toEqual({ compact: true, visibleItems: 1 });
	});

	it("uses compact layout when neither layout can fully fit", () => {
		const layout = getMenuListLayout({
			getRows: () => 5,
			preferredVisibleItems: 3,
			reservedRows: 4,
			comfortableItemRows: 3,
			compactItemRows: 2,
		});

		expect(layout).toEqual({ compact: true, visibleItems: 1 });
	});

	it("renders compact rows without vertical padding", () => {
		const list = new MenuList({ compact: true });
		list.addChild(
			new MenuRow({
				primary: "first",
				secondary: "provider",
				selected: true,
			}),
		);
		list.addChild(
			new MenuRow({
				primary: "second",
				secondary: "provider",
				selected: false,
			}),
		);

		const lines = list.render(40);
		const output = lines.map((line) => stripAnsi(line));

		expect(lines).toHaveLength(4);
		expect(output[0]).toContain("first");
		expect(output[1]).toContain("provider");
		expect(output[2]).toContain("second");
		expect(output[3]).toContain("provider");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	it("keeps row content on one physical line when it carries a newline", () => {
		const row = new MenuRow({
			primary: "first line\nsecond line",
			secondary: "alpha\nbeta",
			meta: "x\ny",
			selected: false,
		});

		const lines = row.render(40);
		// A raw newline inside a row reads as one array entry but two physical
		// lines, and every row-height budget above this component miscounts.
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(lines).toHaveLength(4);
		const output = stripAnsi(lines.join("\n"));
		expect(output).toContain("first line second line");
		expect(output).toContain("alpha beta");
	});

	it("shows the search placeholder behind the cursor while focused and empty", () => {
		const field = new MenuSearchInput("Search models");
		field.focused = true;

		const output = stripAnsi(field.render(24).join("\n"));

		// The placeholder used to hide behind `!focused`, and the field is always
		// focused in production - so the hint never showed.
		expect(output).toContain("Search models");
	});
});
