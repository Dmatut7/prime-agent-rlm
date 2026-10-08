import { type AssistantMessage, type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "../../../src/core/provider-fallback.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * wave-38 MODEL-PERSIST: a model the provider deterministically rejects (403
 * permission, model-not-found) must not stay on the books. The session model, the
 * session ledger, and the saved default all move back to a model that can actually
 * serve, with an owner-visible notice; a restart then resumes the serving model,
 * not the rejected one. Failures that say nothing about the model (transient
 * errors, refusals) must never rewrite a stored selection.
 */

const MODELS = [{ id: "faux-1" }, { id: "faux-bad" }];

function failure(errorMessage: string, details: Record<string, unknown>): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [{ type: "provider_stream_failure", timestamp: Date.now(), details }],
	};
}

const permissionRejected = () =>
	failure("Provider denied access to the requested resource (403): you do not have access to model faux-bad", {
		kind: "permission",
		status: 403,
	});
const modelNotFound = () =>
	failure("Provider rejected the request (not_found_error, 404): the model `faux-bad` does not exist", {
		kind: "invalid_request",
		status: 404,
	});
const transientError = () => failure("500 internal_server_error", { kind: "server_error", status: 500 });
const refusal = () => failure("Model refused to respond (refusal)", { kind: "refusal" });

interface Call {
	model: string;
}

/** Answers per model id; a model with no scripted answer left fails the test loudly. */
function perModel(script: Record<string, Array<AssistantMessage | (() => AssistantMessage)>>, calls: Call[]) {
	return (_context: Context, _options: unknown, _state: unknown, model: { id: string }) => {
		calls.push({ model: model.id });
		const next = script[model.id]?.shift();
		if (!next) throw new Error(`no scripted answer left for ${model.id}`);
		return typeof next === "function" ? next() : next;
	};
}

function rejectionNotices(harness: Harness): Array<{ text: string; kind: unknown }> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE)
		.map((entry) => {
			const message = entry as { content?: unknown; details?: { kind?: unknown } };
			return { text: String(message.content), kind: message.details?.kind };
		});
}

function recordedModel(harness: Harness): string | undefined {
	const model = harness.sessionManager.buildSessionContext().model;
	return model ? `${model.provider}/${model.modelId}` : undefined;
}

describe("model rejected by the provider does not stay persisted", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({
			models: MODELS,
			settings: { retry: { enabled: false } },
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	it("a /model pick the server rejects reverts to the last serving model, on disk and in settings", async () => {
		const harness = await harnessWith({ persistSession: true });
		harness.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		harness.setResponses([perModel({ "faux-1": [() => fauxAssistantMessage("served by one")] }, calls)]);
		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-1");

		await harness.session.setModel(harness.getModel("faux-bad")!);
		expect(recordedModel(harness)).toBe("faux/faux-bad");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-bad");

		harness.setResponses([perModel({ "faux-bad": [permissionRejected] }, calls)]);
		await harness.session.prompt("two");

		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-bad"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(recordedModel(harness)).toBe("faux/faux-1");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");
		const notices = rejectionNotices(harness);
		expect(notices.some((notice) => notice.kind === "rejected")).toBe(true);

		// A restart resumes the model that actually serves, not the rejected one.
		const sessionFile = harness.session.sessionFile!;
		harness.session.dispose();
		const restarted = await harnessWith({ existingSessionFile: sessionFile, restoreSessionModel: true });
		expect(restarted.session.model?.id).toBe("faux-1");
	});

	it("a first turn on a rejected model falls back to the available default, on disk and in settings", async () => {
		const harness = await harnessWith({ persistSession: true });
		harness.sessionManager.materializeSessionFile();
		await harness.session.setModel(harness.getModel("faux-bad")!);
		const calls: Call[] = [];
		harness.setResponses([perModel({ "faux-bad": [modelNotFound] }, calls)]);
		await harness.session.prompt("one");

		expect(calls.map((call) => call.model)).toEqual(["faux-bad"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(recordedModel(harness)).toBe("faux/faux-1");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");
		expect(rejectionNotices(harness).some((notice) => notice.kind === "rejected")).toBe(true);

		const sessionFile = harness.session.sessionFile!;
		harness.session.dispose();
		const restarted = await harnessWith({ existingSessionFile: sessionFile, restoreSessionModel: true });
		expect(restarted.session.model?.id).toBe("faux-1");
	});

	it("a transient failure never rewrites the selection (unknown is not a negative)", async () => {
		const harness = await harnessWith({ persistSession: true });
		harness.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		harness.setResponses([perModel({ "faux-1": [() => fauxAssistantMessage("served")] }, calls)]);
		await harness.session.prompt("one");
		await harness.session.setModel(harness.getModel("faux-bad")!);

		harness.setResponses([perModel({ "faux-bad": [transientError] }, calls)]);
		await harness.session.prompt("two");

		expect(harness.session.model?.id).toBe("faux-bad");
		expect(recordedModel(harness)).toBe("faux/faux-bad");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-bad");
		expect(rejectionNotices(harness)).toEqual([]);
	});

	it("a refusal is the model answering, not rejecting: the selection stays", async () => {
		const harness = await harnessWith({ persistSession: true });
		harness.sessionManager.materializeSessionFile();
		await harness.session.setModel(harness.getModel("faux-bad")!);
		const calls: Call[] = [];
		harness.setResponses([perModel({ "faux-bad": [refusal] }, calls)]);
		await harness.session.prompt("one");

		expect(harness.session.model?.id).toBe("faux-bad");
		expect(recordedModel(harness)).toBe("faux/faux-bad");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-bad");
		expect(rejectionNotices(harness)).toEqual([]);
	});

	it("washes a hostile rejection message before persisting the fallback notice (R4-M16)", async () => {
		// The notice is a persisted custom message: attach/resync/replay re-render
		// it every time, so an ESC surviving the 200-char detail slice replays
		// forever.
		const harness = await harnessWith({ persistSession: true });
		harness.sessionManager.materializeSessionFile();
		await harness.session.setModel(harness.getModel("faux-bad")!);
		const calls: Call[] = [];
		const hostile = () =>
			failure(
				`Provider denied access to the requested resource (403): ${String.fromCharCode(0x1b)}[2J${String.fromCharCode(0x07)}you do not have access to model faux-bad\nsecond line`,
				{ kind: "permission", status: 403 },
			);
		harness.setResponses([perModel({ "faux-bad": [hostile] }, calls)]);
		await harness.session.prompt("one");

		expect(harness.session.model?.id).toBe("faux-1");
		const rejected = rejectionNotices(harness).find((notice) => notice.kind === "rejected");
		expect(rejected).toBeDefined();
		expect(rejected!.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		// The readable words survive, flattened onto the one line the old
		// `\s+ → " "` collapse already produced.
		expect(rejected!.text).toContain("you do not have access to model faux-bad second line");
	});
});
