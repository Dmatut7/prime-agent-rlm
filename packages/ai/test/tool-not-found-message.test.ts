import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.js";
import { validateToolCall } from "../src/utils/validation.js";

const demoTools: Tool[] = [
	{ name: "ipython", description: "kernel", parameters: { type: "object", properties: {} } } as unknown as Tool,
];

describe("validateToolCall not-found message", () => {
	it("names the missing tool AND lists the available ones, so a model can self-correct", () => {
		expect(() => validateToolCall(demoTools, { name: "bash", arguments: {} } as never)).toThrow(
			/Tool "bash" not found\. Available tools: ipython/,
		);
	});
});
