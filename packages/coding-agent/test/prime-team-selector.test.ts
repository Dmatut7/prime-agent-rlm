import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeTeamSelectorComponent } from "../src/modes/interactive/components/prime-team-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("PrimeTeamSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders personal and team options with current status", () => {
		const selector = new PrimeTeamSelectorComponent(
			[
				{ teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				{ teamId: "team-2", name: "Infra", role: "member" },
			],
			"team-1",
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(100).join("\n"));

		expect(output).toContain("Prime Team");
		expect(output).toContain("Personal");
		expect(output).toContain("personal account");
		expect(output).toContain("Research");
		expect(output).toContain("slug: research, role: admin");
		expect(output).toContain("Infra");
		expect(output).toContain("role: member");
		expect(output).toContain("current");
	});

	it("marks personal as current when no team id is active", () => {
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
			undefined,
			() => {},
			() => {},
		);

		const lines = stripAnsi(selector.render(100).join("\n")).split("\n");
		const personalLine = lines.find((line) => line.includes("Personal"));
		const teamLine = lines.find((line) => line.includes("Research"));

		expect(personalLine).toContain("current");
		expect(teamLine).not.toContain("current");
	});

	it("selects a team from the menu", () => {
		let selectedTeamId: string | undefined;
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
			undefined,
			(team) => {
				selectedTeamId = team?.teamId;
			},
			() => {},
		);

		selector.handleInput("\x1B[B");
		selector.handleInput("\r");

		expect(selectedTeamId).toBe("team-1");
	});

	it("cancels without selecting a team", () => {
		let cancelled = false;
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research" }],
			undefined,
			() => {},
			() => {
				cancelled = true;
			},
		);

		selector.handleInput("\x1B");

		expect(cancelled).toBe(true);
	});

	it("counts the wrapped subtitle against the list row budget", () => {
		const teams = Array.from({ length: 6 }, (_, index) => ({
			teamId: `team-${index}`,
			name: `Team ${index}`,
		}));
		const selector = new PrimeTeamSelectorComponent(
			teams,
			undefined,
			() => {},
			() => {},
			{
				getRows: () => 12,
			},
		);

		// The fixed English subtitle wraps to 2 rows at this width; the budget must
		// pay for both or the list overflows and the overlay clips it away.
		const lines = selector.render(30);

		expect(lines.length).toBeLessThanOrEqual(12);
		expect(stripAnsi(lines.join("\n"))).toContain("Personal");
	});

	it("treats left as back while the search field is empty", () => {
		let cancelled = 0;
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research" }],
			undefined,
			() => {},
			() => {
				cancelled++;
			},
		);

		selector.handleInput("\x1b[D");

		expect(cancelled).toBe(1);
	});

	it("keeps one option visible on an 8-row terminal by collapsing decoration", () => {
		const teams = Array.from({ length: 6 }, (_, index) => ({ teamId: `team-${index}`, name: `Team ${index}` }));
		const selector = new PrimeTeamSelectorComponent(
			teams,
			undefined,
			() => {},
			() => {},
			{ getRows: () => 8 },
		);

		const lines = selector.render(80);

		const visible = lines.slice(0, 8);
		expect(stripAnsi(visible.join("\n"))).toContain("Personal");
		for (const extra of lines.slice(8)) {
			expect(stripAnsi(extra).trim()).toBe("");
		}
	});
});
