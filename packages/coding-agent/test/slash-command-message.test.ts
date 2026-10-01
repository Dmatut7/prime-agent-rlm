import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";
import { SlashCommandMessageComponent } from "../src/modes/interactive/components/slash-command-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("SlashCommandMessageComponent", () => {
	test("wraps the rendered lines in OSC 133 markers", () => {
		initTheme("dark");

		const component = new SlashCommandMessageComponent("/compact focus on errors");
		const lines = component.render(60);

		expect(lines.length).toBeGreaterThan(0);
		expect(stripAnsi(lines.join("\n"))).toContain("/compact focus on errors");
		expect(lines[0].split(OSC133_ZONE_START)).toHaveLength(2);
		expect(lines[lines.length - 1].split(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toHaveLength(2);
	});

	test("keeps the OSC 133 markers in zone order across the rendered lines", () => {
		initTheme("dark");

		// The padded box never renders a single line, so A sits on the first line
		// and B,C on the last; the single-line branch keeps the same A<B<C order.
		const lines = new SlashCommandMessageComponent("/compact focus").render(60);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[0]).not.toContain(OSC133_ZONE_FINAL);
		expect(lines[lines.length - 1]?.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);

		const joined = lines.join("\n");
		const start = joined.indexOf(OSC133_ZONE_START);
		const end = joined.indexOf(OSC133_ZONE_END);
		const final = joined.indexOf(OSC133_ZONE_FINAL);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(start).toBeLessThan(end);
		expect(end).toBeLessThan(final);
	});

	test("does not accumulate OSC 133 markers on repeated renders", () => {
		initTheme("dark");

		const component = new SlashCommandMessageComponent("/compact focus on errors");
		const first = [...component.render(60)];
		const second = [...component.render(60)];

		expect(second).toEqual(first);
		expect(first[0].split(OSC133_ZONE_START)).toHaveLength(2);
		expect(first[first.length - 1].split(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toHaveLength(2);

		// Unchanged content must keep handing back the same array, otherwise the
		// differential renderer loses its cache hit and repaints every frame.
		expect(component.render(60)).toBe(component.render(60));
	});
});
