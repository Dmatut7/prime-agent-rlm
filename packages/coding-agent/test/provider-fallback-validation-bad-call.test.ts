import { describe, expect, it } from "vitest";
import { isBadToolCall } from "../src/core/provider-fallback.js";

/**
 * W20-B: the storm detector must also count schema-validation failures whose
 * arguments are NOT empty. The observed shape (GLM-5.3-prime, session
 * 01a0cfb2): the model called `ipython` with `{"command": "..."}` instead of
 * the required `code` key - a malformed call the empty-args rule cannot see,
 * because the args object is non-empty. The validation receipt itself
 * (`Validation failed for tool "X":` from packages/ai validateToolArguments)
 * is evidence enough that the model sent arguments the schema rejects.
 */
describe("isBadToolCall validation-failure receipts", () => {
	const ipythonLike = {
		parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
	};

	it("flags a validation failure whose non-empty args used the wrong key", () => {
		const text =
			'Validation failed for tool "ipython":\n  - code: must have required properties code\n\nReceived arguments:\n{\n  "command": "ls"';
		expect(isBadToolCall({ isError: true, text, args: { command: "ls" } }, ipythonLike)).toBe(true);
	});

	it("flags a validation failure when the caller cannot resolve the tool schema", () => {
		const text = 'Validation failed for tool "ipython":\n  - code: must have required properties code';
		expect(isBadToolCall({ isError: true, text, args: { command: "ls" } })).toBe(true);
	});

	it("still flags the empty-args validation failure through either rule", () => {
		const text =
			'Validation failed for tool "ipython":\n  - code: must have required properties code\n\nReceived arguments:\n{}';
		expect(isBadToolCall({ isError: true, text, args: {} }, ipythonLike)).toBe(true);
	});

	it("never flags a successful result or an error that only mentions validation", () => {
		const text = 'Validation failed for tool "ipython":\n  - code: must have required properties code';
		expect(isBadToolCall({ isError: false, text, args: { command: "ls" } }, ipythonLike)).toBe(false);
		expect(
			isBadToolCall(
				{ isError: true, text: "command failed: validation error on line 3", args: { code: "x" } },
				ipythonLike,
			),
		).toBe(false);
	});
});
