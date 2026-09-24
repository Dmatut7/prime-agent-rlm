/**
 * The duty log is what an owner who left for days reads first, so the session has to write the
 * facts it summarizes: a warn-only stall that never recovered, and which "user" messages were
 * /autonomous talking to itself rather than the owner coming back.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUTY_EVENT_CUSTOM_TYPE, formatDutyLog, summarizeDutyLog } from "../../src/core/duty-log.js";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, type Harness } from "./harness.js";

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang Forever",
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
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

function busyKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10, bashHandles: 1, bashCellHandles: 1 }),
		latest: sample({ tick: 40, bashHandles: 1, bashCellHandles: 1 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

function dutyKinds(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === DUTY_EVENT_CUSTOM_TYPE)
		.map((entry) => (entry as { data: { kind: string } }).data.kind);
}

describe("duty log facts written by an unattended session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records a warn-only stall, so a turn hung for days does not read as 没出问题", async () => {
		const harness = await createHarness({
			tools: [hangTool()],
			settings: {
				stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
				retry: { enabled: false },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("run the job").catch(() => {});

		await vi.waitFor(() => expect(dutyKinds(harness)).toContain("stall_warning"), { timeout: 15_000, interval: 20 });
		const summary = summarizeDutyLog({
			entries: harness.sessionManager.getEntries(),
			now: Date.now() + 48 * 3_600_000,
		});
		expect(summary?.incidents).toEqual([{ kind: "stall", count: 1, handled: 0 }]);
		expect(formatDutyLog(summary!, Date.now())).not.toContain("没出问题");
		await harness.session.abort();
	});

	it("does not record an excused stall: healthy long work is not an incident", async () => {
		const harness = await createHarness({
			tools: [hangTool()],
			settings: {
				stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
				retry: { enabled: false },
			},
			stallKernelLivenessFacts: () => busyKernelFacts(),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("run the job").catch(() => {});

		await vi.waitFor(() => expect(harness.eventsOfType("stall_warning").length).toBeGreaterThan(0), {
			timeout: 15_000,
			interval: 20,
		});
		expect(harness.eventsOfType("stall_warning")[0]?.diagnostics.exemption?.reason).toBe("vouched");
		expect(dutyKinds(harness)).not.toContain("stall_warning");
		await harness.session.abort();
	});

	it("marks /autonomous continuation prompts so the duty log measures the owner's real absence", async () => {
		const continuationPrompt = "Keep going on the migration until the verifier passes.";
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1, continuationPrompt },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Which database should I migrate first?"),
			fauxAssistantMessage("Migrated the users database."),
		]);
		await harness.session.prompt("migrate the databases");

		const entries = harness.sessionManager.getEntries();
		const userTexts = entries
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map((entry) => JSON.stringify((entry as { message: { content: unknown } }).message.content));
		expect(userTexts.some((text) => text.includes(continuationPrompt))).toBe(true);
		expect(dutyKinds(harness)).toContain("autonomous_continue");

		const owner = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		const ownerAt = owner?.type === "message" ? owner.message.timestamp : undefined;
		expect(ownerAt).toBeTypeOf("number");
		const now = Date.now() + 48 * 3_600_000;
		const summary = summarizeDutyLog({ entries, now });
		// Measured from "migrate the databases", not from the continuation that followed it.
		expect(summary?.awayMs).toBe(now - (ownerAt as number));
		expect(summary?.finishedTurns).toBe(2);
	});
});
