import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RestoreResult } from "../../../src/core/kernel/state-snapshot.js";
import {
	type CustomMessage,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	type IpythonStateRestoredDetails,
} from "../../../src/core/messages.js";
import {
	InjectedPromptMessageComponent,
	isInjectedPromptMessage,
} from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

type StateRestoreHost = {
	_onIpythonStateRestored(result: RestoreResult): void;
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: InjectedPromptMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

function renderRaw(component: InjectedPromptMessageComponent): string {
	return component.render(120).join("\n");
}

/** The ANSI prefix `theme.fg` puts on a given color slot, probed instead of hardcoded. */
function colorPrefix(slot: "warning" | "systemNotice"): string {
	const probe = theme.fg(slot, "|");
	return probe.slice(0, probe.indexOf("|"));
}

describe("ENG-4530 IPython state restore message", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves restore context as a custom message when the next prompt is queued", async () => {
		let releaseToolExecution = () => {};
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		let providerSawRestoreContext = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				providerSawRestoreContext = context.messages.some((message) =>
					getMessageText(message).includes("These names are available again: alpha, beta."),
				);
				return fauxAssistantMessage("queued turn complete");
			},
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await toolStarted;
		(harness.session as unknown as StateRestoreHost)._onIpythonStateRestored({
			restored: ["alpha", "beta"],
			failed: [],
			path: "/tmp/kernel-state.dill",
		});
		await harness.session.prompt("stop the heartbeat", { streamingBehavior: "followUp" });

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(queued?.payload.kind === "turn" ? queued.payload.content : undefined).toEqual([
			{ type: "text", text: "stop the heartbeat" },
		]);
		const prefixMessages =
			queued?.payload.kind === "turn"
				? queued.payload.records.filter((record) => record.role === "prefix").map((record) => record.message)
				: [];
		expect(prefixMessages).toHaveLength(1);
		expect(prefixMessages[0]).toMatchObject({
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			display: true,
			details: { restored: true },
		});

		releaseToolExecution();
		await firstPrompt;

		expect(providerSawRestoreContext).toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", "stop the heartbeat"]);
		const restoreMessage = harness.session.messages.find(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
		);
		if (!restoreMessage || !isInjectedPromptMessage(restoreMessage)) {
			throw new Error("Expected an injected IPython restore message");
		}

		const component = new InjectedPromptMessageComponent(restoreMessage);
		expect(render(component).trim()).toBe("·  ◆ Python 环境已恢复  ·");
		expect(render(component)).not.toContain("alpha");
		component.setExpanded(true);
		expect(render(component)).toContain("◆ Python 环境已恢复");
		expect(render(component)).not.toContain("ipython_state_restored");
		// The expanded card answers "what came back": the notice prose, wrapper tags dropped.
		expect(render(component)).toContain("alpha, beta");
	});

	it("records the restore failure roster in the message details", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		// test-hygiene-allow: same frozen StateRestoreHost alias as this file's baseline entry; the hook is the only production entry mapping a real RestoreResult into the message
		(harness.session as unknown as StateRestoreHost)._onIpythonStateRestored({
			restored: ["alpha"],
			failed: [{ name: "big_df", reason: "payload exceeds per-variable limit" }],
			degraded: [{ name: "helper", reason: "by-value function" }],
			notSaved: [
				{ name: "cache", reason: "cannot pickle 'module' object" },
				{ name: "_scratch", reason: "private-name convention: leading-underscore names are not persisted" },
				{
					name: "_prime_agent_shell",
					reason: "private-name convention: leading-underscore names are not persisted",
				},
			],
			path: "/tmp/kernel-state.dill",
			snapshotPolicy: "preserve-names",
		});
		await harness.session.prompt("go");

		const message = harness.session.messages.find(
			(entry): entry is CustomMessage =>
				entry.role === "custom" && entry.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
		);
		if (!message) {
			throw new Error("Expected an injected IPython restore message");
		}
		// Routine skips are classified by name, not reason (w8): the bootstrap's own
		// internals fire on every healthy write and the owner can neither rebuild nor
		// avoid them, so they are filtered - but a user-bound `_scratch` is a real
		// lost name and stays in the roster (a reason-string match hid those).
		expect(message.details).toEqual({
			restored: true,
			failed: ["big_df"],
			degraded: [{ name: "helper", reason: "by-value function" }],
			notSaved: [
				{ name: "cache", reason: "cannot pickle 'module' object" },
				{ name: "_scratch", reason: "private-name convention: leading-underscore names are not persisted" },
			],
		});
		// The model-facing content keeps its machine-block wrapper and prose unchanged.
		const content = typeof message.content === "string" ? message.content : "";
		expect(content).toContain("<ipython_state_restored>");
		expect(content).toContain("available again: alpha");
		expect(content).toContain("big_df");
	});

	it("warns on a partial restore and lists the lost names when expanded", () => {
		const message: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content:
				"<ipython_state_restored>\nYour Python kernel state was revived from your previous session. These names are available again: alpha.\n</ipython_state_restored>",
			display: true,
			details: {
				restored: true,
				failed: ["big_df", "model"],
				degraded: [{ name: "helper", reason: "by-value function" }],
				notSaved: [{ name: "cache", reason: "cannot pickle 'module' object" }],
			},
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);

		const collapsed = render(component);
		expect(collapsed.trim()).toContain("◆ Python 环境部分恢复（3 个名字没回来）");
		expect(collapsed).not.toContain("big_df");
		// A partial restore must not wear the routine faint color: it is the only sign names were lost.
		expect(renderRaw(component)).toContain(colorPrefix("warning"));
		component.setExpanded(true);
		const expanded = render(component);
		expect(renderRaw(component)).toContain(colorPrefix("warning"));
		expect(expanded).toContain("◆ Python 环境部分恢复（3 个名字没回来）");
		expect(expanded).toContain("big_df、model");
		expect(expanded).toContain("cache");
		expect(expanded).toContain("helper");
		expect(expanded).not.toContain("<ipython_state_restored>");
		expect(expanded).not.toContain("available again");
		expect(component.getBlockCopyText()).toContain("big_df");
		expect(component.getBlockCopyText()).not.toContain("<ipython_state_restored>");
	});

	it("marks a restore that lost every name as a fresh kernel with the loss count", () => {
		const message: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content: "restore details",
			display: true,
			details: { restored: false, failed: ["big_df", "model"] },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);
		expect(render(component)).toContain("◆ 新开了 Python 环境（2 个名字没回来）");
		component.setExpanded(true);
		expect(render(component)).toContain("big_df、model");
	});

	it("marks a wholesale restore failure without names", () => {
		const message: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content:
				"<ipython_state_restored>\nYour previous Python kernel state could not be revived; the kernel is starting fresh.\nRestore failure: payload is corrupt.\n</ipython_state_restored>",
			display: true,
			details: { restored: false, restoreError: "payload is corrupt" },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);
		expect(render(component)).toContain("◆ 新开了 Python 环境（恢复失败）");
		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("恢复失败：payload is corrupt");
		expect(expanded).not.toContain("<ipython_state_restored>");
	});

	it("keeps the boolean labels for messages written before the roster details existed", () => {
		const legacy: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content:
				"<ipython_state_restored>\nYour Python kernel state was revived from your previous session. These names are available again: alpha.\nThese could not be restored and must be recreated if needed: old_df.\n</ipython_state_restored>",
			display: true,
			details: { restored: true },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(legacy);
		expect(render(component).trim()).toBe("·  ◆ Python 环境已恢复  ·");
		// The boolean fallback keeps the routine tone: no warning color without a roster.
		expect(renderRaw(component)).not.toContain(colorPrefix("warning"));
		component.setExpanded(true);
		const expanded = render(component);
		// No structured roster on an old message: the expanded card shows the notice prose.
		expect(expanded).toContain("old_df");
		expect(expanded).not.toContain("<ipython_state_restored>");
	});

	it("retries only undelivered input after partial scheduler delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: "restore context",
				display: true,
				details: { restored: true },
			},
			{ deliverAs: "nextTurn" },
		);
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		await harness.session.prompt("queued prompt", { streamingBehavior: "followUp" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		vi.spyOn(harness.session.agent, "prompt").mockImplementationOnce(async (messages) => {
			const batch = Array.isArray(messages) ? messages : [messages];
			harness.session.agent.state.messages.push(batch[0]);
			harness.session.acquireQueuedWorkPause();
			throw new Error("partial delivery failed");
		});

		harness.session.resumeQueuedWork();
		await harness.session.waitForSessionInputIdle();

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(queued?.payload).toMatchObject({ text: "queued prompt" });
		expect(
			queued?.payload.kind === "turn" ? queued.payload.records.filter((record) => record.role === "prefix") : [],
		).toEqual([]);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({ customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE }),
		]);
	});

	it("shows an accurate fixed label when restoration starts a fresh kernel", () => {
		const message: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content: "restore details",
			display: true,
			details: { restored: false },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);

		expect(render(component)).toContain("◆ 新开了 Python 环境");
		component.setExpanded(true);
		// Expanding shows the notice body, wrapper tags dropped - it is no longer a no-op.
		expect(render(component)).toContain("restore details");
	});
});
