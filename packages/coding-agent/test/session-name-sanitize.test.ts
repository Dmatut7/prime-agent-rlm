import { describe, expect, it } from "vitest";
import { normalizeRequestedRlmSubagentSessionName } from "../src/core/rlm-runtime.js";
import { sanitizeSessionName } from "../src/core/session-names.js";

describe("session name sanitization", () => {
	it("strips control characters a model-controlled name may carry", () => {
		expect(sanitizeSessionName("worker\x07\x1b]52;c;cGFzdGU=\x07 evil")).toBe("worker]52;c;cGFzdGU= evil");
		expect(sanitizeSessionName("line1\nline2")).toBe("line1line2");
		expect(sanitizeSessionName("tab\tseparated")).toBe("tabseparated");
		expect(sanitizeSessionName("clean name")).toBe("clean name");
		expect(sanitizeSessionName("CJK 名字保持不变")).toBe("CJK 名字保持不变");
	});

	it("normalizes requested subagent names through the same strip", () => {
		// The name reaches the terminal title OSC sequence and single-row chips;
		// BEL would terminate the OSC early and let ESC inject escapes.
		expect(normalizeRequestedRlmSubagentSessionName("worker\x07\x1b]52;c;evil")).toBe("worker]52;c;evil");
		expect(normalizeRequestedRlmSubagentSessionName("  spaced  ")).toBe("spaced");
		expect(normalizeRequestedRlmSubagentSessionName("multi\nline\x1b[2Jname")).toBe("multiline[2Jname");
		expect(() => normalizeRequestedRlmSubagentSessionName("\x1b\x07\n\x0b")).toThrow("must not be empty");
		expect(normalizeRequestedRlmSubagentSessionName(undefined)).toBeUndefined();
	});
});
