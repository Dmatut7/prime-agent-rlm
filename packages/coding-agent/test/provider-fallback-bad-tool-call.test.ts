import { describe, expect, it } from "vitest";
import { isBadToolCall } from "../src/core/provider-fallback.js";

/**
 * The bad-call storm detector counts broken tool calls; an empty-args error only
 * counts when the tool's schema actually declares required parameters, because
 * calling a zero-required-parameter tool with `{}` is legal and its runtime
 * failure is not a malformed call.
 */
describe("isBadToolCall", () => {
	it("flags unknown tool names regardless of the schema", () => {
		expect(
			isBadToolCall(
				{ isError: true, text: "Tool nope not found", args: {} },
				{ parameters: { type: "object", properties: {} } },
			),
		).toBe(true);
	});

	it("never flags successful results or calls that carried arguments", () => {
		expect(isBadToolCall({ isError: false, text: "Tool x not found", args: {} })).toBe(false);
		expect(
			isBadToolCall(
				{ isError: true, text: "command failed", args: { path: "a" } },
				{ parameters: { required: ["path"] } },
			),
		).toBe(false);
	});

	it("flags empty-args errors when the tool schema declares required parameters", () => {
		const tool = { parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
		expect(isBadToolCall({ isError: true, text: "Invalid arguments", args: {} }, tool)).toBe(true);
		expect(isBadToolCall({ isError: true, text: "Invalid arguments" }, tool)).toBe(true);
	});

	it("does not flag empty-args errors from a tool whose schema requires nothing", () => {
		const tool = { parameters: { type: "object", properties: { verbose: { type: "boolean" } } } };
		expect(isBadToolCall({ isError: true, text: "command failed", args: {} }, tool)).toBe(false);
	});

	it("treats an empty or malformed required list as no required parameters", () => {
		expect(isBadToolCall({ isError: true, text: "failed", args: {} }, { parameters: { required: [] } })).toBe(false);
		expect(isBadToolCall({ isError: true, text: "failed", args: {} }, { parameters: null })).toBe(false);
		expect(isBadToolCall({ isError: true, text: "failed", args: {} }, {})).toBe(false);
	});

	it("keeps the conservative reading when the caller cannot resolve the tool schema", () => {
		expect(isBadToolCall({ isError: true, text: "Invalid arguments", args: {} })).toBe(true);
	});

	it("matches the loop's enriched multi-line not-found receipt by its first line", () => {
		// W11-C: the loop appends the available tools, a did-you-mean and (at the warn
		// threshold) the breaker notice on later lines; the storm classification must
		// not depend on the receipt being a single line.
		const enriched = 'Tool rlm not found\nAvailable tools: echo, ipython. Did you mean: "echo"?';
		expect(isBadToolCall({ isError: true, text: enriched, args: {} })).toBe(true);
		const warned = `${enriched}\n[tool-not-found breaker] 3 unknown-tool call(s) this run; the run stops at 5.`;
		expect(isBadToolCall({ isError: true, text: warned, args: {} })).toBe(true);
	});

	it("does not match lookalike text that merely contains the phrase", () => {
		// Non-empty args isolate the not-found pattern from the empty-args rule.
		expect(isBadToolCall({ isError: true, text: "Error: Tool rlm not found", args: { path: "a" } })).toBe(false);
		expect(isBadToolCall({ isError: true, text: "Tool rlm not found anywhere", args: { path: "a" } })).toBe(false);
	});
});
