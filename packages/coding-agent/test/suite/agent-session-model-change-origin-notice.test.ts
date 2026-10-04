import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionEvent,
	MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
	type ModelChangeOriginNoticeDetails,
} from "../../src/core/agent-session.js";
import type { CustomMessage } from "../../src/core/messages.js";
import type { CustomEntry } from "../../src/core/session-manager.js";
import type { ExtensionAPI } from "../../src/index.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * wave-42 SETMODEL-VIS: a model switch driven by a non-interactive caller (a
 * daemon set_model/cycle_model command from another attached client, or the
 * extension API) used to be half-silent for every other attached window: the
 * model-facing notice is display:false and no message event left the session,
 * so a second window only noticed on the next lazy footer refresh. The session
 * now emits a visible chat notice (display:true custom message over
 * message_start/message_end, the fallback-notice pattern) whenever the caller
 * passes changeNotice, and records the origin in the session ledger.
 *
 * The notice is deliberately kept out of the live context AND out of the
 * custom_message transcript form: convertToLlm passes an unknown customType
 * through to the model, so the only safe homes are the event stream and a
 * ledger-only custom entry.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const MODELS = [{ id: "faux-1" }, { id: "faux-2" }];

function originNoticeEvents(harness: Harness): Array<Extract<AgentSessionEvent, { type: "message_start" }>> {
	return harness
		.eventsOfType("message_start")
		.filter(
			(event) =>
				event.message.role === "custom" && event.message.customType === MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
		);
}

function originNoticeDetails(
	event: Extract<AgentSessionEvent, { type: "message_start" }>,
): ModelChangeOriginNoticeDetails {
	const details = (event.message as CustomMessage<ModelChangeOriginNoticeDetails>).details;
	if (!details) throw new Error("origin notice carries no details");
	return details;
}

function originLedgerEntries(harness: Harness): CustomEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry =>
				entry.type === "custom" && entry.customType === MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
		);
}

describe("model-change origin notice", () => {
	it("emits a visible chat notice for a daemon-command switch, keeps it out of the model context", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const next = harness.getModel("faux-2");
		if (!next) throw new Error("faux-2 missing");

		await harness.session.setModel(next, { changeNotice: { origin: "daemon_command", token: "tok-1" } });

		const starts = originNoticeEvents(harness);
		expect(starts).toHaveLength(1);
		const message = starts[0].message as CustomMessage<ModelChangeOriginNoticeDetails>;
		expect(message.display).toBe(true);
		expect(message.content).toContain("faux/faux-2");
		expect(originNoticeDetails(starts[0])).toEqual({
			provider: "faux",
			modelId: "faux-2",
			previousProvider: "faux",
			previousModelId: "faux-1",
			origin: "daemon_command",
			token: "tok-1",
		});
		// The message_end half closes the pair the TUI renders from.
		const ends = harness
			.eventsOfType("message_end")
			.filter(
				(event) =>
					event.message.role === "custom" && event.message.customType === MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
			);
		expect(ends).toHaveLength(1);

		// The model never learns the UI notice: it is neither in the live context
		// nor rebuilt from a custom_message row on reload.
		expect(
			harness.session.messages.some(
				(candidate) =>
					candidate.role === "custom" && candidate.customType === MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
			),
		).toBe(false);

		// The origin lands in the durable ledger without the wire-only token.
		const ledger = originLedgerEntries(harness);
		expect(ledger).toHaveLength(1);
		expect(ledger[0].data).toEqual({
			provider: "faux",
			modelId: "faux-2",
			previousProvider: "faux",
			previousModelId: "faux-1",
			origin: "daemon_command",
		});
	});

	it("emits no notice for an interactive-style call without changeNotice", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const next = harness.getModel("faux-2");
		if (!next) throw new Error("faux-2 missing");

		await harness.session.setModel(next);

		expect(originNoticeEvents(harness)).toHaveLength(0);
		expect(originLedgerEntries(harness)).toHaveLength(0);
	});

	it("emits no notice when the model did not change", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const current = harness.session.model;
		if (!current) throw new Error("no current model");

		await harness.session.setModel(current, { changeNotice: { origin: "daemon_command", token: "tok-noop" } });

		expect(originNoticeEvents(harness)).toHaveLength(0);
		expect(originLedgerEntries(harness)).toHaveLength(0);
	});

	it("emits the notice for a cycle_model switch from another client", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);

		const result = await harness.session.cycleModel("forward", {
			changeNotice: { origin: "daemon_command", token: "tok-cycle" },
		});
		expect(result?.model.id).toBe("faux-2");

		const starts = originNoticeEvents(harness);
		expect(starts).toHaveLength(1);
		expect(originNoticeDetails(starts[0])).toMatchObject({
			provider: "faux",
			modelId: "faux-2",
			previousModelId: "faux-1",
			origin: "daemon_command",
			token: "tok-cycle",
		});
	});

	it("marks extension-API switches with origin extension and no token", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		const next = harness.getModel("faux-2");
		if (!next) throw new Error("faux-2 missing");
		if (!api) throw new Error("extension api missing");

		const switched = await api.setModel(next);
		expect(switched).toBe(true);

		const starts = originNoticeEvents(harness);
		expect(starts).toHaveLength(1);
		expect(originNoticeDetails(starts[0])).toMatchObject({
			provider: "faux",
			modelId: "faux-2",
			origin: "extension",
		});
		expect(originNoticeDetails(starts[0]).token).toBeUndefined();
	});
});
