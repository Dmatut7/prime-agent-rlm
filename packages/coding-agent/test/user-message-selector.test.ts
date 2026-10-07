import { beforeAll, describe, expect, it } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("UserMessageSelectorComponent height budget", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shrinks its visible entry count to the available dock rows", () => {
		const messages = Array.from({ length: 10 }, (_, index) => ({
			id: `m-${index}`,
			text: `message ${index}`,
		}));

		// A 24-row terminal leaves little room after the dock's other members:
		// three lines per entry plus the scroll indicator — one entry fits.
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
			undefined,
			() => 14,
		);
		const messageLines = selector.render(100).filter((line) => line.includes("第 ") && line.includes(" 条"));

		expect(messageLines.length).toBe(1);
		// The whole render (chrome + entries + scroll info) stays inside the
		// budget the dock actually has.
		expect(selector.render(100).length).toBeLessThanOrEqual(14);
	});

	it("keeps the default entry count on tall terminals", () => {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			id: `m-${index}`,
			text: `message ${index}`,
		}));

		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
			undefined,
			() => 60,
		);
		const messageLines = selector.render(100).filter((line) => line.includes("第 ") && line.includes(" 条"));

		expect(messageLines.length).toBe(10);
		expect(selector.render(100).length).toBeLessThanOrEqual(60);
	});

	it("always keeps at least one entry visible on tiny terminals", () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			id: `m-${index}`,
			text: `message ${index}`,
		}));

		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
			undefined,
			() => 10,
		);
		const messageLines = selector.render(100).filter((line) => line.includes("第 ") && line.includes(" 条"));

		expect(messageLines.length).toBe(1);
	});
});
