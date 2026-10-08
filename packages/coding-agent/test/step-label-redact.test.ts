import { describe, expect, it } from "vitest";
import { turnStepLabel } from "../src/modes/interactive/components/step-label.js";

/**
 * R3-M21's third site: a step label shows a command verbatim when nothing in it is
 * worth naming - a setup-only chain, a quiet tail, or the command a handle waits
 * for. Those are the labels that never went through the preview descriptor, so
 * they owed the same redaction and did not have it.
 */
const bashLabel = (command: string) => turnStepLabel({ toolName: "bash", args: { command } });
const cellLabel = (code: string) => turnStepLabel({ toolName: "ipython", args: { code } });

describe("step label command redaction", () => {
	it("redacts a setup-only bash command instead of showing its secret", () => {
		expect(bashLabel("export MY_TOKEN=abc123")).toBe("运行 export MY_TOKEN=<redacted>");
		expect(bashLabel("export MY_TOKEN=abc123")).not.toContain("abc123");
	});

	it("redacts the raw fallback of a chain whose every segment is setup", () => {
		const label = cellLabel("%%bash\ncd /tmp && export API_KEY=sk-abcdef");
		expect(label).not.toContain("sk-abcdef");
		expect(label).toContain("API_KEY=<redacted>");
	});

	it("redacts a credential header in the command a label names", () => {
		const label = bashLabel("curl -H 'authorization: Bearer tok_123' http://example.invalid");
		expect(label).not.toContain("tok_123");
		expect(label).toContain("<redacted>");
	});

	it("redacts each segment of a quiet chain the label joins with arrows", () => {
		const label = bashLabel("sleep 1 && echo KEY=abc123");
		expect(label).not.toContain("abc123");
		expect(label).toBe("运行 sleep 1 → echo KEY=<redacted>");
	});

	it("redacts the command a handle wait label names", () => {
		const label = turnStepLabel(
			{ toolName: "ipython", args: { code: "await h" } },
			{ handleCommands: new Map([["h", "export MY_TOKEN=abc123"]]) },
		);
		expect(label).toBe("等待 export MY_TOKEN=<redacted>");
	});

	it("keeps a label with nothing to redact exactly as it was", () => {
		expect(bashLabel("npm test")).toBe("运行 npm test");
		expect(bashLabel('grep -rn "\\bText\\b" packages')).toBe("搜索 Text");
		expect(cellLabel("%%bash\nls -la /tmp")).toBe("列目录 tmp");
		expect(bashLabel("git status --short")).toBe("运行 git status --short");
	});
});
