import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../src/core/agent-messages.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import {
	TurnActivityState,
	TurnSummaryComponent,
	turnStepVerb,
} from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const ui = { requestRender: vi.fn() } as unknown as TUI;

function assistant(parts: AssistantMessage["content"], timestamp = 1_000): AssistantMessage {
	return {
		role: "assistant",
		content: parts,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** A tool-heavy turn: the mechanical noise U4 targets. */
function toolHeavyTurn(): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 1; i <= 6; i++) {
		out.push(
			assistant(
				i % 2 === 0
					? [{ type: "toolCall", id: `bash-${i}`, name: "bash", arguments: { command: `npm test --grep ${i}` } }]
					: [{ type: "toolCall", id: `edit-${i}`, name: "edit", arguments: { path: `src/file-${i}.ts` } }],
				1_000 + i * 100,
			),
		);
		out.push(
			toolResult(
				i % 2 === 0 ? `bash-${i}` : `edit-${i}`,
				i % 2 === 0 ? "bash" : "edit",
				`output line ${i}`,
				1_000 + i * 110,
			),
		);
	}
	out.push(assistant([{ type: "text", text: "All six checks passed; the build is green." }], 2_000));
	return out;
}

function renderAllWith(
	messages: readonly AgentMessage[],
	options: { toolsExpanded: boolean; thinkingExpanded: boolean },
): string {
	const components = buildConversationComponents(messages, {
		ui,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
		toolsExpanded: options.toolsExpanded,
		thinkingExpanded: options.thinkingExpanded,
	});
	return components
		.flatMap((component) => component.render(120))
		.map(stripAnsi)
		.join("\n");
}

function collapsedLinesWithoutUserLine(nonEmpty: string[]): number {
	return nonEmpty.filter((line) => !line.includes("fix the CI reds")).length;
}

function renderAll(messages: readonly AgentMessage[], expanded: boolean): string {
	const components = buildConversationComponents(messages, {
		ui,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
		toolsExpanded: expanded,
	});
	return components
		.flatMap((component) => component.render(120))
		.map(stripAnsi)
		.join("\n");
}

describe("turn activity summary (U4)", () => {
	beforeAll(() => initTheme("dark"));

	it("collapses one tool-heavy turn to a single aggregate line and expands on demand", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "run the checks", timestamp: 900 },
			...toolHeavyTurn(),
		];
		const collapsed = renderAll(messages, false);
		const collapsedLines = collapsed.split("\n").filter((line) => line.trim().length > 0);

		// The aggregate line: step count, duration, verb summary. No 本轮 prefix,
		// no running marker, and no per-line expand hint - the global tail hint
		// owns the Ctrl+O affordance.
		expect(collapsed).toContain("⚙ 6 步 · 0.6s · edit×3 · bash×3");
		expect(collapsed).not.toContain("本轮");
		expect(collapsed).not.toContain("运行中");
		expect(collapsed).not.toContain("展开");
		// Settled tool bodies are hidden; the assistant prose stays.
		expect(collapsed).toContain("All six checks passed");
		expect(collapsed).not.toContain("npm test --grep 2");
		expect(collapsed).not.toContain("output line 2");

		const expanded = renderAll(messages, true);
		const expandedLines = expanded.split("\n").filter((line) => line.trim().length > 0);
		expect(expanded).toContain("npm test --grep 2");
		expect(expanded).toContain("output line 2");
		// U4 acceptance, mechanical form: the collapsed view has strictly fewer
		// non-empty lines than the expanded view for the same transcript.
		expect(collapsedLines.length).toBeLessThan(expandedLines.length);
	});

	it("pins the aggregate line at the turn head, before any thinking or prose", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "run the checks", timestamp: 900 },
			...toolHeavyTurn(),
		];
		const collapsed = renderAll(messages, false);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);
		// Line 0 is the user prompt; the ⚙ line is the very next line.
		expect(nonEmpty[0]).toContain("run the checks");
		expect(nonEmpty[1]).toContain("⚙ 6 步");
	});

	it("failed steps never fold: the ✗ row stays visible and the aggregate counts it (第五批)", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "read and validate", timestamp: 900 },
			assistant(
				[
					{ type: "thinking", thinking: "Read the config first." },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "config.yaml" } },
				],
				1_000,
			),
			toolResult("read-1", "read", "debug: true", 1_100),
			assistant(
				[
					{ type: "thinking", thinking: "Now the schema." },
					{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "schema.json" } },
				],
				1_200,
			),
			{
				...toolResult("read-2", "read", "FileNotFoundError: schema.json not found", 1_300),
				isError: true,
			},
			assistant([{ type: "text", text: "The schema is missing." }], 1_400),
		];
		const collapsed = renderAll(messages, false);

		// The aggregate line alarms on its own: ✗1 beside the step count.
		expect(collapsed).toContain("⚙ 2 步");
		expect(collapsed).toContain("✗1");
		// The failed step's ✗ row keeps its readable error on screen (exactly
		// as pre-U4); the SUCCESSFUL step folds behind the aggregate line.
		expect(collapsed).toContain("FileNotFoundError: schema.json not found");
		expect(collapsed).not.toContain("debug: true");

		// A clean turn reports no ✗ marker.
		const clean = renderAll([{ role: "user", content: "run the checks", timestamp: 900 }, ...toolHeavyTurn()], false);
		expect(clean).not.toContain("✗");
	});

	it("keeps the blank-line wall out: density reads total/non-empty/empty (F2, DS2)", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "fix the CI reds", timestamp: 900 }];
		for (let i = 1; i <= 10; i++) {
			messages.push(
				assistant(
					[
						{ type: "thinking", thinking: `Step ${i}: weigh the options first.` },
						{ type: "toolCall", id: `py-${i}`, name: "ipython", arguments: { code: `check(${i})` } },
					],
					1_000 + i * 100,
				),
			);
			messages.push(toolResult(`py-${i}`, "ipython", `ok ${i}`, 1_000 + i * 110));
		}
		messages.push(assistant([{ type: "text", text: "All three reds closed." }], 2_600));

		const collapsed = renderAll(messages, false);
		const all = collapsed.split("\n");
		const total = all.length;
		const nonEmpty = all.filter((line) => line.trim().length > 0).length;
		const empty = total - nonEmpty;
		// The DS2 review's same fixture measured 29 total / 25 blank before F2
		// (the collapsed thinking blocks still earned their spacers). Now: nine
		// total, five structural blanks (user padding, the turn head's inner
		// blank, the final message's leading spacer).
		expect(total).toBe(9);
		expect(nonEmpty).toBe(4);
		expect(empty).toBe(5);

		// The same message renders zero lines while fully collapsed (thinking
		// hidden, no text) - and still zero under hideThinkingBlock.
		const thinkingToolMessage = messages[1] as AssistantMessage;
		const component = new AssistantMessageComponent(thinkingToolMessage, false, undefined, "思考");
		expect(component.render(100).filter((line) => line.trim().length > 0)).toHaveLength(0);
		const hidden = new AssistantMessageComponent(thinkingToolMessage, true, undefined, "思考");
		expect(hidden.render(100).filter((line) => line.trim().length > 0)).toHaveLength(0);
	});

	it("renders one thinking header plus one process line per turn, zero thinking rows collapsed", () => {
		// The boss's live scenario: a 10-step turn, one thinking block per step.
		const messages: AgentMessage[] = [{ role: "user", content: "fix the CI reds", timestamp: 900 }];
		for (let i = 1; i <= 10; i++) {
			messages.push(
				assistant(
					[
						{ type: "thinking", thinking: `Step ${i}: weigh the options first.` },
						{ type: "toolCall", id: `py-${i}`, name: "ipython", arguments: { code: `check(${i})` } },
					],
					1_000 + i * 100,
				),
			);
			messages.push(toolResult(`py-${i}`, "ipython", `ok ${i}`, 1_000 + i * 110));
		}
		messages.push(assistant([{ type: "text", text: "All three reds closed." }], 2_600));

		const collapsed = renderAll(messages, false);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);
		// Two mechanical lines at the turn head: the thinking block header (①)
		// above the process line (②). 评审短账: the duration lives on the ⚙ line
		// only - the header carries the segment count.
		expect(nonEmpty[1]).toBe(" 思考 10 段");
		expect(nonEmpty[2]).toBe(" ⚙ 10 步 · 1.0s · python×10");
		// Zero per-block thinking rows anywhere in the collapsed view.
		expect(collapsed).not.toContain("Thinking");
		expect(collapsed).not.toContain("weigh the options");
		expect(collapsed).not.toContain("展开");
		expect(collapsedLinesWithoutUserLine(nonEmpty)).toBe(3); // 思考 header + ⚙ line + final prose

		// The thinking traces appear with the T lane, not the O lane.
		const toolsExpanded = renderAll(messages, true);
		expect(toolsExpanded).not.toContain("weigh the options");
		const thinkingExpanded = renderAllWith(messages, { toolsExpanded: true, thinkingExpanded: true });
		expect(thinkingExpanded).toContain("weigh the options");
	});
	it("keeps mid-turn assistant text in place - it is content, not noise (K3 ①)", () => {
		// A real long turn interleaves thinking, tools, and assistant prose; the
		// collapsed surface hides only thinking rows, never the prose between
		// tools.
		const messages: AgentMessage[] = [
			{ role: "user", content: "fix the CI reds", timestamp: 900 },
			assistant(
				[
					{ type: "thinking", thinking: "Reproduce the failure first." },
					{ type: "toolCall", id: "py-1", name: "ipython", arguments: { code: "check(1)" } },
				],
				1_000,
			),
			toolResult("py-1", "ipython", "red: 3 failures", 1_100),
			assistant([{ type: "text", text: "红了，三个断言的 pin 需要贴契约改。先改第一个。" }], 1_200),
			assistant(
				[
					{ type: "thinking", thinking: "The second red comes from the queue prefix." },
					{ type: "toolCall", id: "py-2", name: "ipython", arguments: { code: "check(2)" } },
				],
				1_300,
			),
			toolResult("py-2", "ipython", "green", 1_400),
			assistant([{ type: "text", text: "改 pin 让断言贴合真实契约，最后全绿。" }], 1_500),
		];
		const collapsed = renderAll(messages, false);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);
		expect(nonEmpty[1]).toBe(" 思考 2 段");
		expect(nonEmpty[2]).toBe(" ⚙ 2 步 · 0.4s · python×2");
		// The mid-turn prose renders in place, between the mechanical lines and
		// the final answer - K3 ①: content is never collapsed away.
		expect(collapsed).toContain("红了，三个断言的 pin 需要贴契约改。先改第一个。");
		expect(collapsed).toContain("改 pin 让断言贴合真实契约，最后全绿。");
	});

	it("renders a thinking-only turn as one 思考 line and freezes its clock at the boundary", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "just think", timestamp: 900 },
			assistant(
				[
					{ type: "thinking", thinking: "First segment." },
					{ type: "thinking", thinking: "Second segment." },
					{ type: "text", text: "Concluded." },
				],
				1_000,
			),
			{ role: "user", content: "next", timestamp: 3_000 },
			assistant([{ type: "text", text: "No thinking here." }], 3_500),
		];
		const collapsed = renderAll(messages, false);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);
		// A single segment renders without the count; several render `思考 N 段`.
		expect(nonEmpty[1]).toBe(" 思考 2 段 · 2.0s");
		expect(collapsed).toContain("Concluded.");
		expect(collapsed).not.toContain("First segment");
		// The second turn has neither steps nor thinking: no mechanical line.
		expect(collapsed).not.toContain("思考 1 段");

		const single = renderAll(
			[
				{ role: "user", content: "one segment", timestamp: 900 },
				assistant([{ type: "thinking", thinking: "Only segment." }], 1_000),
				{ role: "user", content: "next", timestamp: 3_000 },
			],
			false,
		);
		const singleNonEmpty = single.split("\n").filter((line) => line.trim().length > 0);
		expect(singleNonEmpty[1]).toBe(" 思考 2.0s");
	});

	it("hides a live tool's body only after it settles, and the verb summary keeps one fragment per verb", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: { command: "npm test" }, status: "done" });
		state.addStep({ toolCallId: "t2", toolName: "bash", args: { command: "npm run build" }, status: "running" });
		const summary = new TurnSummaryComponent(state);
		const line = stripAnsi(summary.render(120).join("\n"));
		expect(line).toContain("⚙ 2 步");
		expect(line).toContain("bash×2");
		// A settled turn pins its line; the verb summary keeps one fragment per verb.
		state.setStepStatus("t2", "done", 2_500);
		const settled = stripAnsi(summary.render(120).join("\n"));
		expect(settled).toContain("1.5s");
		expect(settled).toContain("bash×2");
	});

	it("groups per user turn: two prompts get two independent summary lines", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 900 },
			...toolHeavyTurn(),
			{ role: "user", content: "second", timestamp: 3_000 },
			assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }], 3_100),
			toolResult("read-1", "read", "contents", 3_150),
			assistant([{ type: "text", text: "Done." }], 3_200),
		];
		const collapsed = renderAll(messages, false);
		const summaries = collapsed.split("\n").filter((line) => line.includes("⚙"));
		expect(summaries).toHaveLength(2);
		expect(collapsed).toContain("⚙ 6 步");
		expect(collapsed).toContain("⚙ 1 步");
		expect(collapsed).not.toContain("contents");
	});

	it("turnStepVerb maps ipython cells to python and keeps other names", () => {
		expect(turnStepVerb("ipython")).toBe("python");
		expect(turnStepVerb("edit")).toBe("edit");
		expect(turnStepVerb("agent")).toBe("agent");
	});
});

describe("turn head footnote (TUI v4 quiet)", () => {
	beforeAll(() => initTheme("dark"));

	function renderQuiet(messages: readonly AgentMessage[]): string {
		const components = buildConversationComponents(messages, {
			ui,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		return components
			.flatMap((component) => component.render(120))
			.map(stripAnsi)
			.join("\n");
	}

	it("collapses the turn head to one footnote line and drops the legacy pair", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "run the checks", timestamp: 900 },
			...toolHeavyTurn(),
		];
		const collapsed = renderQuiet(messages);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);

		// One footnote line at the turn head: duration, steps, the [O] hint.
		expect(nonEmpty[1]).toContain("干了");
		expect(nonEmpty[1]).toContain("6 步");
		expect(nonEmpty[1]).toContain("[O]");
		// The very next line is the final prose: no second mechanical line.
		expect(nonEmpty[2]).toContain("All six checks passed");
		expect(nonEmpty.filter((line) => line.includes("步"))).toHaveLength(1);
		// The legacy two-line surface is gone.
		expect(collapsed).not.toContain("⚙");
		expect(collapsed).not.toContain("思考 ");
	});

	it("renders a thinking-only quiet turn as 想了想, and a bare turn as nothing", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "just think", timestamp: 900 },
			assistant(
				[
					{ type: "thinking", thinking: "First segment." },
					{ type: "thinking", thinking: "Second segment." },
					{ type: "text", text: "Concluded." },
				],
				1_000,
			),
			{ role: "user", content: "next", timestamp: 3_000 },
			assistant([{ type: "text", text: "No thinking here." }], 3_500),
		];
		const collapsed = renderQuiet(messages);
		const nonEmpty = collapsed.split("\n").filter((line) => line.trim().length > 0);
		// The empty-state turn: only 想了想, no counts, no keys, no duration.
		expect(nonEmpty[1]).toBe("▸想了想");
		expect(collapsed).toContain("Concluded.");
		// R5-P2③: the thinking-less turn renders 想了想 too - the model is
		// always reasoning, so every turn carries the footnote.
		expect(collapsed.split("\n").filter((line) => line.includes("想了想"))).toHaveLength(2);
	});

	it("renders 想了想 for an all-zero turn (R5-P2③: every turn carries the footnote)", () => {
		const state = new TurnActivityState(1_000);
		state.markTurnEnded(1_500);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		// No steps, no thinking, no comms: still one 想了想 line, not nothing.
		const line = summary
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		expect(line).toContain("想了想");
		expect(line).not.toContain("步");
		expect(line).not.toContain("[");
	});

	it("counts comms from received agent rows plus sent agent messages in tool details", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "delegate and report", timestamp: 900 },
			assistant(
				[
					{ type: "thinking", thinking: "One segment." },
					{ type: "toolCall", id: "py-1", name: "ipython", arguments: { code: "send()" } },
				],
				1_000,
			),
			{
				...toolResult("py-1", "ipython", "ok", 1_100),
				details: {
					sentAgentMessages: [
						{
							id: "agentmsg_sent_1",
							message: "sent one",
							deliveryStatus: "delivered",
							target: { activeSessionId: "t1", sessionId: "t1" },
						},
						{
							id: "agentmsg_sent_2",
							message: "sent two",
							deliveryStatus: "delivered",
							target: { activeSessionId: "t1", sessionId: "t1" },
						},
					],
				},
			},
			createAgentSessionMessage(
				{
					id: "agentmsg_recv_1",
					source: AGENT_MESSAGE_SOURCE,
					message: "received one",
					target: { activeSessionId: "a1", sessionId: "a1" },
				},
				1_200,
			),
			assistant([{ type: "text", text: "Reported." }], 1_300),
		];
		const collapsed = renderQuiet(messages);
		// 1 step, 1 thinking segment, 3 comms (2 sent + 1 received).
		expect(collapsed).toContain("1 步");
		expect(collapsed).toContain("想 1 段");
		expect(collapsed).toContain("→ 通讯 3 条");
		expect(collapsed).toContain("[P]");
	});

	it("counts steps deduped by toolCallId", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "dup", toolName: "bash", args: {}, status: "done" });
		state.addStep({ toolCallId: "dup", toolName: "bash", args: {}, status: "done" });
		state.markTurnEnded(2_000);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const line = stripAnsi(summary.render(120).join("\n"));
		expect(line).toContain("1 步");
		expect(line).not.toContain("2 步");
	});

	it("addCommMessage feeds the footnote count", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: {}, status: "done" });
		state.markTurnEnded(1_500);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		summary.addCommMessage();
		summary.addCommMessage();
		const line = stripAnsi(summary.render(120).join("\n"));
		expect(line).toContain("→ 通讯 2 条");
	});

	it("setQuiet(false) restores the legacy two-line face", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: {}, status: "done" });
		state.markTurnEnded(1_500);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		expect(stripAnsi(summary.render(120).join("\n"))).toContain("1 步 [O]");
		summary.setQuiet(false);
		const legacy = stripAnsi(summary.render(120).join("\n"));
		expect(legacy).toContain("⚙ 1 步");
		expect(legacy).not.toContain("[O]");
	});

	it("freezes the settled footnote line: repeated renders reuse one array", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: {}, status: "done" });
		// Live turn (no end stamp): every render recomputes - fresh arrays.
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const firstLive = summary.render(120);
		const secondLive = summary.render(120);
		expect(secondLive).not.toBe(firstLive);
		// Settled + ended: the line freezes (O(this line) redraw contract).
		state.markTurnEnded(2_000);
		const firstSettled = summary.render(120);
		expect(summary.render(120)).toBe(firstSettled);
	});
});

describe("process block key-steps fold (TUI v4 T6)", () => {
	beforeAll(() => initTheme("dark"));

	function foldableState(count: number, errorAt?: number): TurnActivityState {
		const state = new TurnActivityState(1_000);
		for (let i = 1; i <= count; i++) {
			state.addStep({
				toolCallId: `t${i}`,
				toolName: "bash",
				args: {},
				status: i === errorAt ? "error" : "done",
			});
		}
		state.markTurnEnded(2_000);
		// The fold only arms through the quiet Ctrl+O cycle (legacy never
		// folds); these state tests arm it directly.
		state.setProcessKeySteps(true);
		return state;
	}

	it("folds the middle of a >8 step turn while edges and errors stay", () => {
		const state = foldableState(14, 7);
		state.setCollapsed(false); // the process block is open
		for (const id of ["t1", "t2", "t3", "t12", "t13", "t14"]) {
			expect(state.isStepFolded(id)).toBe(false);
		}
		// The settled middle folds; the failed step never folds (✗ 永保留).
		for (const id of ["t4", "t5", "t6", "t8", "t9", "t10", "t11"]) {
			expect(state.isStepFolded(id)).toBe(true);
		}
		expect(state.isStepFolded("t7")).toBe(false);
		// The first folded step carries the fold row; 7 steps fold away.
		expect(state.isProcessFoldRowCarrier("t4")).toBe(true);
		expect(state.isProcessFoldRowCarrier("t5")).toBe(false);
		expect(state.processFoldHiddenCount()).toBe(7);
	});

	it("does not arm below the threshold, and lifts on request", () => {
		const small = foldableState(8);
		small.setCollapsed(false);
		expect(small.processKeyStepsView).toBe(false);
		expect(small.isStepFolded("t4")).toBe(false);

		const big = foldableState(14);
		big.setCollapsed(false);
		expect(big.processKeyStepsView).toBe(true);
		big.setProcessKeySteps(false);
		expect(big.processKeyStepsView).toBe(false);
		expect(big.isStepFolded("t5")).toBe(false);
		expect(big.processFoldHiddenCount()).toBe(0);
	});

	it("the fold row renders from the carrying tool component", () => {
		const state = foldableState(14);
		state.setCollapsed(false);
		const tool = new ToolExecutionComponent(
			"bash",
			"t4",
			{},
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			"/tmp",
		);
		tool.setTurnActivity(state);
		tool.setExpanded(false);
		const rendered = tool
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		expect(rendered).toContain("⋯ 中间 8 步");

		const middle = new ToolExecutionComponent(
			"bash",
			"t5",
			{},
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			"/tmp",
		);
		middle.setTurnActivity(state);
		middle.setExpanded(false);
		expect(middle.render(120)).toEqual([]);
	});

	it("re-arming the key-steps view after lifting works", () => {
		const state = foldableState(14);
		state.setCollapsed(false);
		state.setProcessKeySteps(false);
		state.setProcessKeySteps(true);
		expect(state.processKeyStepsView).toBe(true);
		expect(state.isStepFolded("t5")).toBe(true);
	});
});

describe("turn comm counter (TUI v4 T6)", () => {
	beforeAll(() => initTheme("dark"));

	it("lives on the turn state and feeds the quiet footnote", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: {}, status: "done" });
		state.markTurnEnded(1_500);
		state.addCommMessage();
		state.addCommMessage();
		state.addCommMessage();

		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		// The component facade routes into the same counter.
		summary.addCommMessage();
		const line = summary
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		expect(line).toContain("→ 通讯 4 条");
		expect(state.commMessageCount).toBe(4);
	});
});
