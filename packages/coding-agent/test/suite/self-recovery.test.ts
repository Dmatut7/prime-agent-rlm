import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TOOL_TIMEOUT_CAUSE_PREFIX } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DUTY_EVENT_CUSTOM_TYPE } from "../../src/core/duty-log.js";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import { AUTO_CONTINUE_CUSTOM_TYPE } from "../../src/core/messages.js";
import { readSelfRecoveryRecords } from "../../src/core/self-recovery.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * Self-recovery for unattended runs: a silent step is stopped (a busy one never
 * is), a turn that stops right after announcing its next step is continued at most
 * twice, a subagent that finishes without replying is asked once to reply, and every
 * action lands in the transcript for the duty log.
 */

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		receivedAt: Date.now(),
		tick: 10,
		intervalMs: 5_000,
		cellId: "cell-1",
		cpuMs: 1_000,
		streamBytes: 0,
		cellsDone: 0,
		hostRequests: 0,
		bashHandles: 0,
		bashCellHandles: 0,
		bashBufferedBytes: 0,
		bashPipePending: 0,
		...overrides,
	};
}

/**
 * A responsive kernel holding a live command handle whose output counters never move:
 * the process exists, nothing it produces reaches anyone (a hung `await bash(...)`).
 */
function wedgedKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10, bashHandles: 1 }),
		latest: sample({ tick: 40, bashHandles: 1 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

/** A command-like tool with a 30ms deadline that settles after `settleMs`, optionally printing as it goes. */
function commandTool(settleMs: number, printEveryMs?: number): AgentTool {
	return {
		name: "run_command",
		label: "Run Command",
		description: "Runs a command",
		parameters: Type.Object({ command: Type.String() }),
		executionTimeoutMs: 30,
		execute: async (_id, _args, signal, onUpdate) => {
			const timer =
				printEveryMs === undefined
					? undefined
					: setInterval(
							() => onUpdate?.({ content: [{ type: "text", text: "line" }], details: {} }),
							printEveryMs,
						);
			try {
				await new Promise<void>((resolve, reject) => {
					const done = setTimeout(resolve, settleMs);
					signal?.addEventListener("abort", () => {
						clearTimeout(done);
						reject(new Error("aborted"));
					});
				});
			} finally {
				if (timer) clearInterval(timer);
			}
			return { content: [{ type: "text", text: "command finished" }], details: {} };
		},
	};
}

function toolResultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			(message as { content: Array<{ type: string; text?: string }> }).content
				.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
				.join("\n"),
		);
}

function autoContinues(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === AUTO_CONTINUE_CUSTOM_TYPE,
	);
}

function dutyEvents(harness: Harness): Array<{ kind: string; [key: string]: unknown }> {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === DUTY_EVENT_CUSTOM_TYPE)
		.map((entry) => (entry as { data: { kind: string } }).data);
}

describe("self-recovery: silent steps", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function stuckHarness(
		tool: AgentTool,
		stepCpuProbe: () => number | undefined = () => 1_000,
	): Promise<Harness> {
		const harness = await createHarness({
			tools: [tool],
			settings: { tools: { timeout: { silentStuckSeconds: 1 } } },
			stallKernelLivenessFacts: () => wedgedKernelFacts(),
			stepCpuProbe,
		});
		harnesses.push(harness);
		return harness;
	}

	it("stops a step that stays silent past the threshold and tells the model which one", async () => {
		const harness = await stuckHarness(commandTool(5_000));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "sleep 999" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("换了个办法，已完成。"),
		]);
		const started = Date.now();
		await harness.session.promptAndWait("run it");

		const [result] = toolResultTexts(harness);
		expect(result).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(result).toContain("Stuck step: `sleep 999`");
		expect(result).toContain("was stopped");
		// Stopped by the one-second silence rule: not at the 30ms deadline, not at the 5s settle.
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(Date.now() - started).toBeLessThan(4_500);
		const records = readSelfRecoveryRecords(harness.sessionManager.getBranch());
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ kind: "stuck_step_stopped", step: "sleep 999", repeated: false });
		expect(dutyEvents(harness)).toContainEqual(
			expect.objectContaining({ kind: "step_stuck_stopped", tool: "sleep 999" }),
		);
	});

	it("never stops a step whose output keeps flowing", async () => {
		const harness = await stuckHarness(commandTool(2_500, 200));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("测试通过。"),
		]);
		await harness.session.promptAndWait("run the tests");

		const [result] = toolResultTexts(harness);
		expect(result).toContain("command finished");
		expect(result).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toHaveLength(0);
	});

	it("counts a command writing to its handle as output even when the cell prints nothing", async () => {
		let written = 0;
		const harness = await createHarness({
			tools: [commandTool(2_500)],
			settings: { tools: { timeout: { silentStuckSeconds: 1 } } },
			stallKernelLivenessFacts: () => {
				written += 512;
				return {
					...wedgedKernelFacts(),
					previous: sample({
						receivedAt: Date.now() - 5_000,
						tick: 10,
						bashHandles: 1,
						bashBufferedBytes: written - 512,
					}),
					latest: sample({ tick: 40, bashHandles: 1, bashBufferedBytes: written }),
				};
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "make build" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("构建完成。"),
		]);
		await harness.session.promptAndWait("build it");

		expect(toolResultTexts(harness)[0]).toContain("command finished");
	});

	it("never stops a silent step whose process tree keeps burning CPU", async () => {
		let cpu = 0;
		const harness = await stuckHarness(commandTool(2_500), () => {
			cpu += 1_500;
			return cpu;
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "pytest -q" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("测试跑完了。"),
		]);
		await harness.session.promptAndWait("run the tests quietly");

		expect(toolResultTexts(harness)[0]).toContain("command finished");
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toHaveLength(0);
	});

	it("stops a silent step with flat CPU, and falls back to output alone when CPU is unknown", async () => {
		for (const probe of [() => 5_000, () => undefined]) {
			const harness = await stuckHarness(commandTool(5_000), probe);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("run_command", { command: "sleep 999" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("换了个办法。"),
			]);
			await harness.session.promptAndWait("run it");
			expect(toolResultTexts(harness)[0]).toContain("Stuck step: `sleep 999`");
		}
	}, 15_000);

	it("honours a longer timeout the model gave the call", async () => {
		const harness = await stuckHarness(commandTool(2_500));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "timeout 4 ./long-quiet-job" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("完成。"),
		]);
		await harness.session.promptAndWait("run the job");

		expect(toolResultTexts(harness)[0]).toContain("command finished");
	});

	it("calls out a step that gets stuck twice in one run", async () => {
		const harness = await stuckHarness(commandTool(5_000));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "sleep 999" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("run_command", { command: "sleep 999" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("不再重试这条命令了。"),
		]);
		await harness.session.promptAndWait("run it");

		const results = toolResultTexts(harness);
		expect(results).toHaveLength(2);
		expect(results[0]).not.toContain("got stuck before");
		expect(results[1]).toContain("got stuck before in this run: do not run it again");
		const records = readSelfRecoveryRecords(harness.sessionManager.getBranch());
		expect(records.map((record) => record.kind === "stuck_step_stopped" && record.repeated)).toEqual([false, true]);
	}, 15_000);
});

describe("self-recovery: announced-but-undone steps", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function quickTool(): AgentTool {
		return {
			name: "read_file",
			label: "Read",
			description: "Reads",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "file body" }], details: {} }),
		};
	}

	async function harnessWith(settings = {}): Promise<Harness> {
		const harness = await createHarness({ tools: [quickTool()], settings });
		harnesses.push(harness);
		return harness;
	}

	it("continues once when the turn stops right after announcing the next step", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("第一个文件看完了，接下来我去改第二个文件"),
			fauxAssistantMessage("两个文件都改好了，全部完成。"),
		]);
		await harness.session.promptAndWait("fix both files");

		expect(harness.faux.state.callCount).toBe(3);
		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		expect(String((nudges[0] as { content: unknown }).content)).toContain("接下来我去改第二个文件");
		const records = readSelfRecoveryRecords(harness.sessionManager.getBranch());
		expect(records).toMatchObject([{ kind: "auto_continue", ordinal: 1 }]);
		expect(dutyEvents(harness)).toContainEqual(expect.objectContaining({ kind: "auto_continue" }));
	});

	it("stops after two automatic continues for one request", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
		]);
		await harness.session.promptAndWait("check the files");

		expect(autoContinues(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(4);
	});

	it.each([
		["a final answer", "两个文件都改好了，结论是配置写错了。"],
		["a question to the user", "改之前要不要我先备份？"],
		["waiting on children", "子代理已派出，等待子代理回复。"],
	])("never continues %s", async (_name, reply) => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(reply),
		]);
		await harness.session.promptAndWait("look at it");

		expect(autoContinues(harness)).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("never continues a pure chat answer with no tool work", async () => {
		const harness = await harnessWith();
		harness.setResponses([fauxAssistantMessage("让我想想，接下来我会先看配置")]);
		await harness.session.promptAndWait("how would you start?");

		expect(autoContinues(harness)).toHaveLength(0);
	});

	it("is off when selfRecovery.autoContinue is false", async () => {
		const harness = await harnessWith({ selfRecovery: { autoContinue: false } });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("接下来我去改第二个文件"),
		]);
		await harness.session.promptAndWait("fix both files");

		expect(autoContinues(harness)).toHaveLength(0);
	});
});

describe("self-recovery: subagent finished without replying", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function quickTool(): AgentTool {
		return {
			name: "read_file",
			label: "Read",
			description: "Reads",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "file body" }], details: {} }),
		};
	}

	it("asks a child once to send its result, and never again in the same run", async () => {
		const harness = await createHarness({ tools: [quickTool()], rlmDepth: 1 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("数好了，共 3 个文件。"),
			fauxAssistantMessage("这个任务不需要回复。"),
		]);
		await harness.session.promptAndWait("[task from parent] count the files");

		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		expect(String((nudges[0] as { content: unknown }).content)).toContain("agent_message.send");
		expect(harness.faux.state.callCount).toBe(3);
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toMatchObject([
			{ kind: "child_reply_nudge" },
		]);
	});

	it("is off when selfRecovery.childReplyNudge is false", async () => {
		const harness = await createHarness({
			tools: [quickTool()],
			rlmDepth: 1,
			settings: { selfRecovery: { childReplyNudge: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("数好了，共 3 个文件。"),
		]);
		await harness.session.promptAndWait("[task from parent] count the files");

		expect(autoContinues(harness)).toHaveLength(0);
	});
});
