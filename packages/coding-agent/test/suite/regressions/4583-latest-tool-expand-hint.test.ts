import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConversationComponents } from "../../../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { TurnSummaryComponent } from "../../../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const ipythonTool: AgentTool = {
	name: "ipython",
	label: "ipython",
	description: "Execute a test IPython cell",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "ok" }],
		details: { status: "ok", durationMs: 1 },
	}),
};

describe("ENG-4583 latest tool expand hint", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("shows the expand or collapse hint only on the latest tool row", async () => {
		harness = await createHarness({ tools: [ipythonTool] });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("ipython", { code: "1 + 1" }, { id: "tool-4583-a" }),
					fauxToolCall("ipython", { code: "2 + 2" }, { id: "tool-4583-b" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "3 + 3" }, { id: "tool-4583-c" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run three cells");

		const components = buildConversationComponents(harness.session.messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: harness.tempDir,
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		const tools = components.filter(
			(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
		);
		const latest = tools.at(-1);

		expect(tools).toHaveLength(3);
		expect(latest).toBeDefined();
		if (!latest) {
			throw new Error("Expected a latest tool component");
		}
		// U6: collapsed, the turn's tool rows hide behind one process line; no
		// per-row expand hints exist at all (the global tail hint line owns the
		// Ctrl+O affordance), which subsumes ENG-4583's "only the latest row
		// carries the hint" concern.
		const summary = components.find(
			(component): component is TurnSummaryComponent => component instanceof TurnSummaryComponent,
		);
		expect(summary).toBeDefined();
		const collapsedChat = stripAnsi(components.flatMap((component) => component.render(120)).join("\n"));
		expect(collapsedChat).toContain("⚙ 3 步");
		expect(collapsedChat).not.toContain("展开");
		expect(render(tools)).not.toContain("展开");

		for (const tool of tools) {
			tool.setExpanded(true);
		}
		summary?.setExpanded(true);
		expect(render(tools.slice(0, -1))).not.toContain("收起");
		expect(render(tools).match(/收起/g)).toBe(null);
	});
});

function render(components: readonly ToolExecutionComponent[]): string {
	return components.map((component) => stripAnsi(component.render(120).join("\n"))).join("\n");
}
