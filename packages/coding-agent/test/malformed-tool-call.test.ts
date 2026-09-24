import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	isMalformedToolName,
	MALFORMED_TOOL_CALL_LABEL,
	turnStepLabel,
} from "../src/modes/interactive/components/step-label.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Seen live on GLM: markup from the arguments leaked into the tool name.
const GARBLED = "ipythone_code</arg_key><arg_value>None</arg_value>";

beforeAll(() => {
	initTheme("dark");
});

function fakeTui() {
	return { requestRender: () => {} } as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5];
}

describe("a tool call with a garbled name", () => {
	it("is recognized as malformed; real tool names are not", () => {
		expect(isMalformedToolName(GARBLED)).toBe(true);
		for (const name of ["ipython", "bash", "mcp_call_github", "read_file", "exa.search"]) {
			expect(isMalformedToolName(name)).toBe(false);
		}
	});

	it("reads as 写错的工具调用 wherever a step is named", () => {
		expect(turnStepLabel({ toolName: GARBLED, args: {} })).toBe(MALFORMED_TOOL_CALL_LABEL);
	});

	it("renders as one dim line, not the raw name, {} and the not-found text", () => {
		const component = new ToolExecutionComponent(GARBLED, "call-1", {}, {}, undefined, fakeTui(), process.cwd());
		component.updateResult(
			{ content: [{ type: "text", text: `Tool ${GARBLED} not found` }], details: {}, isError: true },
			false,
		);
		const lines = component
			.render(100)
			.map((line) => stripAnsi(line))
			.filter((line) => line.trim());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("模型写错了一次工具调用");
		expect(lines.join("\n")).not.toContain("arg_key");
		component.setExpanded(true);
		expect(
			component
				.render(100)
				.map((line) => stripAnsi(line))
				.join("\n"),
		).toContain("not found");
	});
});
