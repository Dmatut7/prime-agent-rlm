import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFactLedger, parseFactAppendix, renderFactAppendix } from "../../../src/core/compaction/fact-appendix.js";
import { stripMachineBlocks } from "../../../src/core/compaction/machine-blocks.js";
import {
	buildUserRequestLedger,
	parseUserRequests,
	renderUserRequests,
} from "../../../src/core/compaction/user-requests.js";

/**
 * A machine block carries foreign text verbatim (the user's own words, an error
 * signature). A body that contains the block's own delimiter must not be able to
 * end the block early: the next generation parses these blocks back out, and a
 * truncated parse loses exactly the content the block exists to preserve.
 */
function userMessage(text: string, id: string): never {
	return { role: "user", content: [{ type: "text", text }], details: { id } } as never;
}

describe("machine-block bodies survive their own delimiters", () => {
	it("round-trips every user request when one of them quotes the closing tag", () => {
		const messages = [
			userMessage("first: keep me", "m1"),
			userMessage("second: I typed </user-requests> in a document, explain it", "m2"),
			userMessage("third: keep me too", "m3"),
		];
		const rendered = renderUserRequests(buildUserRequestLedger({ messages, generation: 1 }));
		const parsed = parseUserRequests(rendered);
		// Red today: the delimiter inside record 2 ends the block, so everything from
		// that record on is dropped and the parse reports one record.
		expect(parsed?.records.map((record) => record.text)).toEqual([
			"first: keep me",
			"second: I typed </user-requests> in a document, explain it",
			"third: keep me too",
		]);
	});

	it("strips the whole block even when a record quotes the closing tag", () => {
		const messages = [
			userMessage("first: keep me", "m1"),
			userMessage("second: I typed </user-requests> in a document", "m2"),
		];
		const rendered = renderUserRequests(buildUserRequestLedger({ messages, generation: 1 }));
		const stripped = stripMachineBlocks(rendered);
		// Red today: the tail of the block (raw ledger JSON) survives the strip.
		expect(stripped).not.toMatch(/<\/?user-requests/);
		expect(stripped).not.toContain('"k":"user"');
	});

	it("round-trips the fact appendix when an error signature quotes the closing tag", () => {
		const messages = [
			{
				role: "toolResult",
				content: [{ type: "text", text: "Error: cannot parse </fact-appendix> token in input" }],
				details: { id: "t1" },
			},
		] as never;
		const rendered = renderFactAppendix(buildFactLedger({ messages, generation: 1 }));
		const parsed = parseFactAppendix(rendered);
		// Red today: the signature ends the block, so the appendix parses back as empty
		// and the caller cannot tell "no block" from "block destroyed".
		expect(parsed?.records.length ?? 0).toBeGreaterThan(0);
	});

	it("does not depend on the renderer source to hold the property", () => {
		// Positive control for the three cases above: an ordinary body round-trips, so a
		// failure above is the delimiter and not a broken harness.
		const rendered = renderUserRequests(
			buildUserRequestLedger({ messages: [userMessage("plain request", "m1")], generation: 1 }),
		);
		expect(parseUserRequests(rendered)?.records.map((record) => record.text)).toEqual(["plain request"]);
		// The file this test was written against must be the one under test.
		expect(readFileSync(resolve(__dirname, "../../../src/core/compaction/machine-blocks.ts"), "utf8")).toContain(
			"renderMachineBlock",
		);
	});
});
