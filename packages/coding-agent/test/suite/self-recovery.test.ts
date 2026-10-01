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
 * is), a turn that stops right after announcing its next step - or whose output the
 * token budget cut off - is continued within the per-prompt budget
 * (`selfRecovery.maxAutoContinues`, default 4), a subagent that finishes without
 * replying is asked once to reply, and every action lands in the transcript for the
 * duty log.
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
			fauxAssistantMessage("换了个办法，这次跑通了。"),
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
			fauxAssistantMessage("长任务跑完了，输出正常。"),
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

/**
 * A synchronous cell freezes the kernel loop, so the kernel cannot vouch for it; the
 * watchdog may be off, or give no evidence at all. Missing evidence is not a hang: the
 * silent-step rule still decides, so a call that keeps working survives the per-call
 * deadline and only a call silent past the threshold is stopped.
 */
describe("self-recovery: calls the kernel cannot vouch for", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	let streamBytes = 0;
	/** A synchronous cell: frames arrive, the loop tick is frozen, stream bytes grow. */
	function syncCellFacts(): TurnLivenessKernelFacts {
		streamBytes += 1000;
		return {
			protocol: 4,
			previous: sample({ receivedAt: Date.now() - 5_000, tick: 10, streamBytes: streamBytes - 1000 }),
			latest: sample({ tick: 10, streamBytes }),
			rejectedFrames: 0,
			consecutiveRejectedFrames: 0,
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		};
	}

	/** A cell awaiting a host request (rlm.collect on a child): loop alive, nothing printed. */
	function awaitingHostRequestFacts(): TurnLivenessKernelFacts {
		return {
			protocol: 4,
			previous: sample({ receivedAt: Date.now() - 5_000, tick: 10 }),
			latest: sample({ tick: 40 }),
			rejectedFrames: 0,
			consecutiveRejectedFrames: 0,
			hostRequestCount: 1,
			hostRequestOldestAgeMs: 1_000,
			kernelPid: 4242,
			hasActiveExecution: true,
		};
	}

	async function runOne(
		options: Parameters<typeof createHarness>[0],
		tool: AgentTool,
		command = "python train.py",
	): Promise<string> {
		const harness = await createHarness({ tools: [tool], ...options });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("命令输出已拿到。"),
		]);
		await harness.session.promptAndWait("go");
		return toolResultTexts(harness)[0] ?? "";
	}

	const quick = { tools: { timeout: { silentStuckSeconds: 1 } } };

	it("keeps a synchronous cell that prints and burns CPU", async () => {
		let cpu = 0;
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: syncCellFacts, stepCpuProbe: () => (cpu += 5_000) },
			commandTool(2_500, 100),
		);
		expect(result).toContain("command finished");
	});

	it("keeps a call that streams output when the kernel gives no facts at all", async () => {
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: () => undefined, stepCpuProbe: () => undefined },
			commandTool(2_500, 100),
		);
		expect(result).toContain("command finished");
	});

	it("keeps a call that streams output with the stall watchdog disabled", async () => {
		const result = await runOne(
			{
				settings: { ...quick, stallWatchdog: { enabled: false } },
				stallKernelLivenessFacts: syncCellFacts,
				stepCpuProbe: () => undefined,
			},
			commandTool(2_500, 100),
		);
		expect(result).toContain("command finished");
	});

	it("keeps a quiet cell whose process tree keeps burning CPU and cannot be vouched for", async () => {
		let cpu = 0;
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: () => undefined, stepCpuProbe: () => (cpu += 5_000) },
			commandTool(2_500),
		);
		expect(result).toContain("command finished");
	});

	it("keeps a cell silently awaiting a host request", async () => {
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: awaitingHostRequestFacts, stepCpuProbe: () => 1_000 },
			commandTool(3_000),
		);
		expect(result).toContain("command finished");
	});

	it("honours the call's own explicit timeout without evidence", async () => {
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: () => undefined, stepCpuProbe: () => 1_000 },
			commandTool(2_500),
			"subprocess.run(['npm', 'run', 'build'], timeout=900)",
		);
		expect(result).toContain("command finished");
	});

	it("still stops a call with no output and flat CPU at the silent threshold, not at the deadline", async () => {
		const started = Date.now();
		const result = await runOne(
			{ settings: quick, stallKernelLivenessFacts: () => undefined, stepCpuProbe: () => 1_000 },
			commandTool(8_000),
			"sleep 999",
		);
		expect(result).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(result).toContain("Stuck step: `sleep 999`");
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(Date.now() - started).toBeLessThan(6_000);
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
			fauxAssistantMessage("两个文件都改好了，测试全部通过。"),
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

	it("stops at the configured automatic-continue budget for one request", async () => {
		const harness = await harnessWith({ selfRecovery: { maxAutoContinues: 2 } });
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

	it("allows four automatic continues per request by default", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
			fauxAssistantMessage("Let me check the next file."),
		]);
		await harness.session.promptAndWait("check the files");

		expect(autoContinues(harness)).toHaveLength(4);
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("continues from where it stopped when the output budget cuts the turn off", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("分析到一半", { stopReason: "length" }),
			fauxAssistantMessage("两个文件都改好了，测试全部通过。"),
		]);
		await harness.session.promptAndWait("fix both files");

		expect(harness.faux.state.callCount).toBe(3);
		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		expect(String((nudges[0] as { content: unknown }).content)).toContain("Continue from where you stopped");
		const records = readSelfRecoveryRecords(harness.sessionManager.getBranch());
		expect(records).toMatchObject([{ kind: "auto_continue", ordinal: 1 }]);
	});

	it("counts a truncation continue into the same per-prompt budget", async () => {
		const harness = await harnessWith({ selfRecovery: { maxAutoContinues: 2 } });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("分析到一半", { stopReason: "length" }),
			fauxAssistantMessage("还是写不完", { stopReason: "length" }),
			fauxAssistantMessage("终于写完了。"),
		]);
		await harness.session.promptAndWait("fix both files");

		expect(autoContinues(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("continues a truncated pure-text answer with no tool work", async () => {
		// N6: a long answer the output budget cut off mid-sentence is unfinished
		// whether or not the turn ran tools, so the truncation continue no longer
		// requires tool work (the per-prompt budget still caps it).
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage("半截回答", { stopReason: "length" }),
			fauxAssistantMessage("补完了。"),
		]);
		await harness.session.promptAndWait("hi");

		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		expect(String((nudges[0] as { content: unknown }).content)).toContain("Continue from where you stopped");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("caps pure-text truncation continues at the per-prompt budget", async () => {
		const harness = await harnessWith({ selfRecovery: { maxAutoContinues: 2 } });
		harness.setResponses([
			fauxAssistantMessage("第一段", { stopReason: "length" }),
			fauxAssistantMessage("第二段", { stopReason: "length" }),
			fauxAssistantMessage("第三段", { stopReason: "length" }),
			fauxAssistantMessage("never called"),
		]);
		await harness.session.promptAndWait("hi");

		expect(autoContinues(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("resumes a subagent cut off mid-answer while it still owes the parent a reply", async () => {
		const harness = await createHarness({ rlmDepth: 1 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("半截报告", { stopReason: "length" }),
			fauxAssistantMessage("写完了"),
		]);
		await harness.session.promptAndWait("do the task");

		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		const content = String((nudges[0] as { content: unknown }).content);
		expect(content).toContain("Continue from where you stopped");
		// A subagent's prose is not the deliverable: the continue says the result
		// must reach the parent before the run stops.
		expect(content).toContain("agent_message.send");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("leaves a resumed subagent's truncated turn alone when its pre-restart reply state is unknown", async () => {
		const first = await createHarness({ rlmDepth: 1, persistSession: true });
		harnesses.push(first);
		first.sessionManager.materializeSessionFile();
		first.setResponses([fauxAssistantMessage("some earlier work")]);
		await first.session.promptAndWait("earlier task");
		const sessionFile = first.session.sessionFile!;
		first.session.dispose();

		// A child resumed with messages on the branch may have replied before the
		// restart, so a truncated turn is not continued on this signal alone.
		const resumed = await createHarness({ rlmDepth: 1, existingSessionFile: sessionFile });
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("半截报告", { stopReason: "length" })]);
		await resumed.session.promptAndWait("new task");

		expect(autoContinues(resumed)).toHaveLength(0);
		expect(resumed.faux.state.callCount).toBe(1);
	});

	it("continues a turn that announced work but ended in a question once tools ran", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("第一个文件看完了，接下来我改第二个文件，可以吗？"),
			fauxAssistantMessage("两个文件都改好了，测试全部通过。"),
		]);
		await harness.session.promptAndWait("fix both files");

		expect(autoContinues(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it.each([
		["a final answer", "两个文件都改好了，测试全部通过；结论是配置写错了。"],
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

describe("self-recovery: finish gate", () => {
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

	function commandTool(): AgentTool {
		return {
			name: "run_command",
			label: "Run Command",
			description: "Runs a command",
			parameters: Type.Object({ command: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "command finished" }], details: {} }),
		};
	}

	async function harnessWith(settings = {}, tools: AgentTool[] = [quickTool()]): Promise<Harness> {
		const harness = await createHarness({ tools, settings });
		harnesses.push(harness);
		return harness;
	}

	it("asks for the proof when a run ends on a bare completion claim", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
			fauxAssistantMessage("修好了，测试全部通过：47 个用例全绿。"),
		]);
		await harness.session.promptAndWait("fix it");

		expect(harness.faux.state.callCount).toBe(3);
		const nudges = autoContinues(harness);
		expect(nudges).toHaveLength(1);
		const content = String((nudges[0] as { content: unknown }).content);
		expect(content).toContain("[finish gate]");
		expect(content).toContain("1 of at most 4");
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toMatchObject([
			{ kind: "auto_continue", ordinal: 1 },
		]);
	});

	it("releases after two nudges when the claim stays bare, and says so on the record", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
			fauxAssistantMessage("搞定了。"),
			fauxAssistantMessage("全部完成。"),
		]);
		await harness.session.promptAndWait("fix it");

		// Two nudges, then the run is let go instead of nudging forever.
		expect(autoContinues(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(4);
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toMatchObject([
			{ kind: "auto_continue", ordinal: 1 },
			{ kind: "auto_continue", ordinal: 2 },
			{ kind: "finish_gate_released", strikes: 2 },
		]);
		expect(dutyEvents(harness)).toContainEqual(expect.objectContaining({ kind: "decision_needed" }));
	});

	it("never gates a claim that cites its evidence", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了，测试全部通过。"),
		]);
		await harness.session.promptAndWait("fix it");

		expect(autoContinues(harness)).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("never gates a claim backed by a verification command that ran green", async () => {
		const harness = await harnessWith({}, [commandTool()]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
		]);
		await harness.session.promptAndWait("fix it");

		expect(autoContinues(harness)).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("gates a claim made with no tool work at all when the prompt asked for work", async () => {
		const harness = await harnessWith();
		harness.setResponses([
			fauxAssistantMessage("修好了。"),
			fauxAssistantMessage("这里无法验证：需要你本地跑 npm test。"),
		]);
		await harness.session.promptAndWait("修复这个崩溃");

		expect(autoContinues(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("leaves pure chat alone", async () => {
		const harness = await harnessWith();
		harness.setResponses([fauxAssistantMessage("搞定了。")]);
		await harness.session.promptAndWait("你好");

		expect(autoContinues(harness)).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("is off when selfRecovery.finishGate is false", async () => {
		const harness = await harnessWith({ selfRecovery: { finishGate: false } });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
		]);
		await harness.session.promptAndWait("fix it");

		expect(autoContinues(harness)).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("counts gate nudges into the per-prompt budget", async () => {
		const harness = await harnessWith({ selfRecovery: { maxAutoContinues: 1 } });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
			fauxAssistantMessage("搞定了。"),
		]);
		await harness.session.promptAndWait("fix it");

		// The one budgeted continue went to the gate; the second bare claim ends the run.
		expect(autoContinues(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(3);
		// The budget running out on a bare claim is a finish-gate release too:
		// recorded with its cause and announced, not silently let go.
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toMatchObject([
			{ kind: "auto_continue", ordinal: 1 },
			{ kind: "finish_gate_released", strikes: 1, cause: "budget_exhausted" },
		]);
		expect(dutyEvents(harness)).toContainEqual(expect.objectContaining({ kind: "decision_needed" }));
		const notices = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "finish_gate_released");
		expect(notices).toHaveLength(1);
		expect(String((notices[0] as { content: unknown }).content)).toContain("budget is spent");
	});

	it("keeps the strike count through red re-checks, so the escape chain reaches the release record", async () => {
		// A tool result after a nudge used to reset the strike count: "run the
		// check, watch it go red, claim done anyway" drew a fresh nudge every time
		// and never reached the release record. Tool work no longer resets the
		// count; a red check is not evidence either way.
		const failingTestTool = (): AgentTool => ({
			name: "run_command",
			label: "Run Command",
			description: "Runs a command",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_toolCallId, params) => {
				const command = String((params as { command?: unknown }).command ?? "");
				if (command.includes("npm test")) throw new Error("exit code 1: 2 failed, 47 passed");
				return { content: [{ type: "text", text: "command finished" }], details: {} };
			},
		});
		const harness = await harnessWith({}, [failingTestTool()]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("修好了。"),
			fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("搞定了。"),
			fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("全部完成。"),
		]);
		await harness.session.promptAndWait("fix it");

		// Two challenges, then the release goes on the record instead of a third nudge.
		expect(autoContinues(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(6);
		expect(readSelfRecoveryRecords(harness.sessionManager.getBranch())).toMatchObject([
			{ kind: "auto_continue", ordinal: 1 },
			{ kind: "auto_continue", ordinal: 2 },
			{ kind: "finish_gate_released", strikes: 2 },
		]);
		expect(dutyEvents(harness)).toContainEqual(expect.objectContaining({ kind: "decision_needed" }));
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
		const harness = await createHarness({
			tools: [quickTool()],
			rlmDepth: 1,
			settings: { selfRecovery: { childReplyNudge: true } },
		});
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

	it("is off by default: the parent already gets the child's answer with its completion notice", async () => {
		const harness = await createHarness({ tools: [quickTool()], rlmDepth: 1 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("数好了，共 3 个文件。"),
		]);
		await harness.session.promptAndWait("[task from parent] count the files");

		expect(autoContinues(harness)).toHaveLength(0);
	});
});
