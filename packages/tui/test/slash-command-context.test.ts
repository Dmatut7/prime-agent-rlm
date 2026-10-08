import assert from "node:assert";
import { describe, it } from "node:test";
import { getSlashCommandContext } from "../src/slash-command-context.js";

describe("getSlashCommandContext", () => {
	it("splits the command token on a tab", () => {
		const line = "/compact\tfocus";
		assert.deepStrictEqual(getSlashCommandContext([line], 0, line.length), {
			kind: "argument",
			commandName: "compact",
			prefix: "focus",
			isAtPromptStart: true,
		});
	});

	it("treats NBSP as a separator, matching the executor's \\s+ split", () => {
		// parseSlashCommand splits name and args on /\s+/, which includes NBSP;
		// the completion context must agree or an NBSP-separated argument kills completion.
		const line = "/compact\u00a0focus";
		assert.deepStrictEqual(getSlashCommandContext([line], 0, line.length), {
			kind: "argument",
			commandName: "compact",
			prefix: "focus",
			isAtPromptStart: true,
		});
	});

	it("detects a mid-line command after NBSP the same as after a space", () => {
		const line = "say\u00a0/mo";
		assert.deepStrictEqual(getSlashCommandContext([line], 0, line.length), {
			kind: "name",
			prefix: "/mo",
			isAtPromptStart: false,
		});
	});

	it("still detects a mid-line command after a plain space", () => {
		const line = "say /mo";
		assert.deepStrictEqual(getSlashCommandContext([line], 0, line.length), {
			kind: "name",
			prefix: "/mo",
			isAtPromptStart: false,
		});
	});
});
