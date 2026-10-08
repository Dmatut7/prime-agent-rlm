import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { formatTokenCount } from "../src/modes/interactive/agent-activity.js";
import { FooterComponent, formatContextTokens } from "../src/modes/interactive/components/footer.js";
import { formatBoxTokens } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for narrow provider data", () => {
		const width = 93;
		const footer = new FooterComponent(createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps all lines within width for wide provider data", () => {
		const width = 60;
		const footer = new FooterComponent(createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("the token readouts agree on the 1000k boundary", () => {
	it("promotes a near-million to the M form everywhere, never 1000k", () => {
		// The footer's context readout rounds 999,600 up to 1M; the box's token
		// count must not print "1000k" for the same number.
		expect(formatContextTokens(999_600, 1_000_000)).toBe("1M/1M");
		expect(formatBoxTokens(999_600)).not.toContain("k");
		expect(formatBoxTokens(999_600)).toMatch(/^1(\.0)?M$/);
		// Below the promotion band the k form stays.
		expect(formatBoxTokens(999_400)).toBe("999k");
	});

	it("the agents-view formatter follows the same rule", () => {
		expect(formatTokenCount(999_600)).not.toContain("k");
		expect(formatTokenCount(999_600)).toBe("1.0M");
		expect(formatTokenCount(999_400)).toBe("999k");
		expect(formatTokenCount(1_000_000)).toBe("1.0M");
	});
});
