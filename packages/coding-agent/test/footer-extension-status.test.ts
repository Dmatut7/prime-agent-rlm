import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFooterData(statuses: Map<string, string>): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("FooterComponent extension statuses (R3-M5)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders extension statuses sorted by key on their own line", () => {
		const footer = new FooterComponent(
			createFooterData(
				new Map([
					["zebra", "zebra status"],
					["alpha", "alpha status"],
				]),
			),
		);
		const lines = footer.render(100).map(stripAnsi);
		expect(lines).toEqual(["alpha status zebra status"]);
	});

	it("renders statuses even when the rest of the footer has nothing to show", () => {
		const footer = new FooterComponent(createFooterData(new Map([["my-ext", "Processing..."]])));
		const lines = footer.render(80).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("Processing...");
	});

	it("collapses newlines and strips control characters to keep the line single", () => {
		const footer = new FooterComponent(createFooterData(new Map([["my-ext", "line one\nline two\r\n\u0007end"]])));
		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const plain = stripAnsi(lines[0]!);
		expect(plain).toBe("line one line two end");
		expect(plain).not.toMatch(/[\r\n\u0007]/);
	});

	it("truncates an over-wide status line instead of overflowing", () => {
		const footer = new FooterComponent(createFooterData(new Map([["my-ext", "x".repeat(200)]])));
		const lines = footer.render(40);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
	});

	it("clears the line when the extension clears its status", () => {
		const statuses = new Map([["my-ext", "Processing..."]]);
		const footer = new FooterComponent(createFooterData(statuses));
		expect(footer.render(80).map(stripAnsi)).toEqual(["Processing..."]);
		statuses.delete("my-ext");
		expect(footer.render(80)).toEqual([]);
	});
});
