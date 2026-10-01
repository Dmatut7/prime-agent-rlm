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
});
