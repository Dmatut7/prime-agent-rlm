import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

function transcriptOf(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("harness session is not persisted");
	return readFileSync(file, "utf8");
}

function recordedBashRows(harness: Harness): unknown[] {
	return transcriptOf(harness)
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { type: string; message?: { role?: string; output?: string } })
		.filter((entry) => entry.type === "message" && entry.message?.role === "bashExecution");
}

/** A tool that parks the turn so bash results can be recorded while streaming. */
function createBlockingTool(onEntered: () => void): { tool: AgentTool; release: () => void } {
	let releaseExecution: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		releaseExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			onEntered();
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, release: releaseExecution };
}

describe("deferred bash results outside a turn boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists a streaming-time bash result when the session is disposed before the next turn", async () => {
		let sawToolStart: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => {
			sawToolStart = resolve;
		});
		const { tool, release } = createBlockingTool(() => sawToolStart?.());
		const harness = await createHarness({ persistSession: true, tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");
		promptPromise.catch(() => undefined);
		await toolStarted;
		harness.session.recordBashResult("echo hi", {
			output: "hi from the deferred command",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		expect(harness.session.hasPendingBashMessages).toBe(true);

		release();
		await promptPromise;

		// The turn boundary alone still does not flush: that is _prepareForCommit's job.
		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(recordedBashRows(harness)).toHaveLength(0);

		await harness.session.disposeAsync();

		expect(harness.session.hasPendingBashMessages).toBe(false);
		const rows = recordedBashRows(harness);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0])).toContain("hi from the deferred command");
	});

	it("does not splice a deferred bash result into an unfinished tool pair on dispose", async () => {
		let sawToolStart: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => {
			sawToolStart = resolve;
		});
		const { tool, release } = createBlockingTool(() => sawToolStart?.());
		const harness = await createHarness({ persistSession: true, tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");
		promptPromise.catch(() => undefined);
		await toolStarted;
		harness.session.recordBashResult("echo hi", {
			output: "mid tool pair",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		expect(harness.session.hasPendingBashMessages).toBe(true);

		// Dispose while the run is still streaming: appending here would land the
		// bashExecution between the assistant tool call and its tool result.
		await harness.session.disposeAsync();

		expect(recordedBashRows(harness)).toHaveLength(0);
		expect(harness.session.hasPendingBashMessages).toBe(true);

		release();
		await promptPromise.catch(() => undefined);
	});

	it("control: a bash result recorded while idle is persisted immediately", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");

		harness.session.recordBashResult("echo hi", {
			output: "idle command",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(recordedBashRows(harness)).toHaveLength(1);
	});
});
