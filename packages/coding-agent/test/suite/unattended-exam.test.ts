import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TOOL_TIMEOUT_CAUSE_PREFIX } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { formatDutyLog, summarizeDutyLog } from "../../src/core/duty-log.js";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import { AUTO_CONTINUE_CUSTOM_TYPE } from "../../src/core/messages.js";
import { readProviderFallbackEntries } from "../../src/core/provider-fallback.js";
import type { Settings } from "../../src/core/settings-manager.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

/**
 * The unattended exam: one owner prompt, nobody watching, and every fault the
 * recovery lanes exist for happening in the same run. The run must reach its
 * final answer on its own, and the duty log the owner reads on return must say
 * what happened and that it was handled.
 */

const MODELS = [{ id: "faux-1" }, { id: "faux-kimi" }, { id: "faux-qwen" }];
const CHAIN = ["faux/faux-1", "faux/faux-kimi", "faux/faux-qwen"];

function serverError(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal_server_error" }),
		diagnostics: [
			{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "server_error", status: 500 } },
		],
	};
}

/** Each call is answered from the serving model's queue, in order. */
function scripted(script: Record<string, AssistantMessage[]>, served: string[]): FauxResponseStep {
	return (_context, _options, _state, model) => {
		served.push(model.id);
		const next = script[model.id]?.shift();
		if (!next) throw new Error(`no scripted answer left for ${model.id}`);
		return next;
	};
}

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

/** A live kernel holding a command handle whose output never moves: a hung `await bash(...)`. */
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

/** `sleep ...` never returns on its own; anything else finishes at once. */
const commandTool: AgentTool = {
	name: "run_command",
	label: "Run Command",
	description: "Runs a command",
	parameters: Type.Object({ command: Type.String() }),
	executionTimeoutMs: 30,
	execute: async (_id, args, signal) => {
		const command = String((args as { command: string }).command);
		if (command.startsWith("sleep")) {
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		}
		return { content: [{ type: "text", text: `ran ${command}` }], details: {} };
	},
};

function settings(overrides: Partial<Settings> = {}): Partial<Settings> {
	return {
		providerFallbackModels: CHAIN,
		tools: { timeout: { silentStuckSeconds: 1 } },
		retry: {
			enabled: true,
			maxRetries: 2,
			baseDelayMs: 1,
			provider: {
				waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
				fallbackLongWait: { baseDelayMs: 5, maxDelayMs: 10, maxRounds: 6 },
			},
		},
		...overrides,
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

function dutyLogLines(harness: Harness): string[] {
	const now = Date.now();
	const summary = summarizeDutyLog({ entries: harness.sessionManager.getEntries(), now });
	expect(summary).toBeDefined();
	return formatDutyLog(summary as NonNullable<typeof summary>, now);
}

describe("unattended exam", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function examHarness(overrides?: Partial<Settings>, rlmDepth?: number): Promise<Harness> {
		const harness = await createHarness({
			models: MODELS,
			tools: [commandTool],
			settings: settings(overrides),
			stallKernelLivenessFacts: () => wedgedKernelFacts(),
			stepCpuProbe: () => 1_000,
			...(rlmDepth === undefined ? {} : { rlmDepth }),
		});
		harnesses.push(harness);
		return harness;
	}

	it("a 500 storm, a hung command and an early stop in one run: finishes alone and the duty log says so", async () => {
		const harness = await examHarness();
		const served: string[] = [];
		const step = scripted(
			{
				"faux-1": [serverError(), serverError(), serverError()],
				"faux-kimi": [
					fauxAssistantMessage(fauxToolCall("run_command", { command: "sleep 999" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("run_command", { command: "npm test -- --bail" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("测试跑通了，接下来我去改配置"),
					fauxAssistantMessage("配置已改好，全部完成。"),
				],
			},
			served,
		);
		harness.setResponses(Array.from({ length: 7 }, () => step));

		await harness.session.promptAndWait("把项目修好");

		// Provider storm: three failures on the primary, then the rest on the fallback.
		expect(served).toEqual(["faux-1", "faux-1", "faux-1", "faux-kimi", "faux-kimi", "faux-kimi", "faux-kimi"]);
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toContainEqual(
			expect.objectContaining({ kind: "switch" }),
		);
		// Hung command: stopped with a reason the model can act on; the next command ran.
		const results = toolResultTexts(harness);
		expect(results[0]).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(results[0]).toContain("Stuck step: `sleep 999`");
		expect(results[1]).toContain("ran npm test");
		// Early stop: continued once, never as a user message.
		const nudges = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === AUTO_CONTINUE_CUSTOM_TYPE,
		);
		expect(nudges).toHaveLength(1);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("配置已改好，全部完成。");

		const lines = dutyLogLines(harness);
		expect(lines.length).toBeLessThanOrEqual(6);
		const text = lines.join("\n");
		expect(text).toContain("都已自动处理");
		expect(text).toContain("自动换到 faux-kimi");
		expect(text).not.toContain("可能没做完");
		expect(text).toContain("配置已改好");
	}, 20_000);

	it("every model down for a while: waits in rounds instead of ending, then finishes when one comes back", async () => {
		const harness = await examHarness();
		let calls = 0;
		// One full round of the chain (primary 3, kimi 2, qwen 3) fails; after the long
		// wait the primary answers again.
		const outageCalls = 8;
		const step: FauxResponseStep = () => {
			calls++;
			return calls <= outageCalls ? serverError() : fauxAssistantMessage("恢复后已完成。");
		};
		harness.setResponses(Array.from({ length: 40 }, () => step));

		await harness.session.promptAndWait("做完这件事");

		expect(calls).toBe(outageCalls + 1);
		expect(getAssistantTexts(harness).at(-1)).toBe("恢复后已完成。");
		const kinds = readProviderFallbackEntries(harness.sessionManager.getEntries()).map((entry) => entry.kind);
		expect(kinds).toContain("long_wait");
		const text = dutyLogLines(harness).join("\n");
		expect(text).toContain("都已自动处理");
		expect(text).toContain("已换回 faux-1");
	}, 20_000);

	it("an empty reply is not the end of the task", async () => {
		const harness = await examHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_command", { command: "ls" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(""),
			fauxAssistantMessage("列完了，共 3 个文件。"),
		]);

		await harness.session.promptAndWait("列一下文件");

		expect(getAssistantTexts(harness).at(-1)).toBe("列完了，共 3 个文件。");
	}, 20_000);
});
