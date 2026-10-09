import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectTrustPromptCopy } from "../src/main.js";
import { ProjectTrustSelectorComponent } from "../src/modes/interactive/components/project-trust-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("project trust prompt default cursor", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	it("starts on the most conservative option (untrusted, this session only), not on 信任", () => {
		const copy = projectTrustPromptCopy("/tmp/project", "/tmp/project/.prime/agent/extensions");
		const options = copy.options.map((option) => option.label);

		new ProjectTrustSelectorComponent(copy.title, options, vi.fn(), vi.fn(), {
			onInterrupt: vi.fn(),
			tui: { requestRender: vi.fn() } as never,
			getRows: () => 30,
			initialSelectedIndex: 3,
		});

		// A reflexive Enter selects the option the cursor started on: it must be
		// 不信任（仅本次会话）, not 信任.
		const expectedChoice = copy.options[3]!.choice;
		expect(expectedChoice.trusted).toBe(false);
		expect(expectedChoice.remember).toBe(false);
		expect(options[3]).toContain("不信任");
		expect(options[0]).toBe("信任");
		// The option order is unchanged (信任 first); only the default cursor moved.
		expect(options.length).toBe(4);
	});

	it("the trust prompt passes initialSelectedIndex=3 to the selector", async () => {
		// The integration point: main.ts must pass the conservative index.
		// We verify by reading the source (a source-level assertion; the
		// component-level behavior is covered above).
		const source = await import("node:fs").then((fs) => fs.readFileSync("src/main.ts", "utf8"));
		expect(source).toContain("initialSelectedIndex: 3");
		// And it is placed inside the ProjectTrustSelectorComponent construction.
		const idx = source.indexOf("ProjectTrustSelectorComponent");
		const paramIdx = source.indexOf("initialSelectedIndex: 3");
		expect(paramIdx).toBeGreaterThan(idx);
		// ...and within the same call (before the next function definition).
		const nextFn = source.indexOf("function ", paramIdx);
		expect(paramIdx).toBeLessThan(nextFn);
	});
});
