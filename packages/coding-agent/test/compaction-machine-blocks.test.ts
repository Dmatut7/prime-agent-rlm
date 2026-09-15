import { describe, expect, it } from "vitest";
import {
	findMachineBlock,
	findMachineBlocks,
	MACHINE_BLOCK_TAGS,
	parseBlockAttributes,
	parseBlockLines,
	renderMachineBlock,
	stripMachineBlocks,
} from "../src/core/compaction/index.js";

const NARRATIVE = "## Goal\nShip the release checklist\n\n## Critical Context\nvault path /srv/releases";

describe("machine blocks", () => {
	it("renders a block that parses back to the same attributes and body", () => {
		const rendered = renderMachineBlock("fact-appendix", { generation: 3, facts: 12 }, '{"k":"sha","v":"abc1234"}');
		const block = findMachineBlock(rendered, "fact-appendix");

		expect(block).toBeDefined();
		expect(block?.attributes).toEqual({ generation: "3", facts: "12" });
		expect(block?.body).toBe('{"k":"sha","v":"abc1234"}');
	});

	it("escapes attribute values so a rendered block cannot be broken out of", () => {
		const rendered = renderMachineBlock("user-requests", { note: 'a "quoted" <value> & more' }, "body");
		expect(rendered).not.toContain('"quoted"');
		expect(parseBlockAttributes(/<user-requests([^>]*)>/.exec(rendered)?.[1] ?? "").note).toBe(
			'a "quoted" <value> & more',
		);
	});

	it("renders an empty body without collapsing the tags", () => {
		const rendered = renderMachineBlock("read-files", {}, "");
		expect(rendered).toBe("\n\n<read-files>\n</read-files>");
		expect(parseBlockLines(findMachineBlock(rendered, "read-files")?.body ?? "")).toEqual([]);
	});

	it("strips every known block and keeps the narrative byte-identical", () => {
		const summary = [
			NARRATIVE,
			renderMachineBlock("read-files", {}, "/a\n/b"),
			renderMachineBlock("modified-files", {}, "/c"),
			renderMachineBlock("fact-appendix", { generation: 1 }, "{}"),
			renderMachineBlock("user-requests", { generation: 1 }, "{}"),
		].join("");

		const stripped = stripMachineBlocks(summary);
		expect(stripped).toBe(NARRATIVE);
		// Stripping is idempotent: a second pass cannot eat narrative text.
		expect(stripMachineBlocks(stripped)).toBe(NARRATIVE);
		// K3R2/MVS-3: the kernel roster notices join as strip-only members.
		expect(MACHINE_BLOCK_TAGS.length).toBe(6);
	});

	it("collapses the blank lines a stripped block leaves behind", () => {
		const summary = `${NARRATIVE}\n\n<fact-appendix generation="1">\nx\n</fact-appendix>\n\n\n\n## Next Steps\n1. push`;
		const stripped = stripMachineBlocks(summary);

		expect(stripped).toBe(`${NARRATIVE}\n\n## Next Steps\n1. push`);
		expect(stripped).not.toContain("\n\n\n");
	});

	it("leaves unknown tags and prose angle brackets alone", () => {
		const summary = `${NARRATIVE}\n\n<not-a-block>keep me</not-a-block>\n<fact-appendix>dropped</fact-appendix>`;
		const stripped = stripMachineBlocks(summary);

		expect(stripped).toContain("<not-a-block>keep me</not-a-block>");
		expect(stripped).not.toContain("dropped");
	});

	it("finds repeated blocks in document order", () => {
		const summary = `${renderMachineBlock("read-files", { n: 1 }, "first")}${renderMachineBlock("read-files", { n: 2 }, "second")}`;
		const blocks = findMachineBlocks(summary, ["read-files"]);

		expect(blocks.map((block) => block.body)).toEqual(["first", "second"]);
		expect(findMachineBlock(summary, "modified-files")).toBeUndefined();
	});

	it("reads list bodies line by line, skipping blanks", () => {
		expect(parseBlockLines("a\n\n  b  \n\nc")).toEqual(["a", "b", "c"]);
	});
});
