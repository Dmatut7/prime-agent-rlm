import { describe, expect, it } from "vitest";
import { recapLineText } from "../src/modes/interactive/components/recap-line.js";

/**
 * The recap line under the chat. The daemon's verdict for a turn that errored
 * is the transcript's error in its own words; the quiet conversation's box
 * already shows that error as a red row, so the line under it stays away.
 */
describe("the recap line", () => {
	const failed = "Model request failed: 400 upstream overloaded";

	it("leaves out a failed turn's recap in the quiet conversation", () => {
		expect(recapLineText(failed, true)).toBeUndefined();
		expect(recapLineText("Model request failed", true)).toBeUndefined();
	});

	it("still shows an ordinary recap in the quiet conversation", () => {
		expect(recapLineText("修好了 add，测试都过了", true)).toBe("回顾：修好了 add，测试都过了");
	});

	it("keeps a failed turn's recap outside the quiet conversation, where no box shows the error", () => {
		expect(recapLineText(failed, false)).toBe(`回顾：${failed}`);
	});

	it("shows nothing for an empty recap", () => {
		expect(recapLineText("  ", true)).toBeUndefined();
		expect(recapLineText(undefined, false)).toBeUndefined();
	});
});
