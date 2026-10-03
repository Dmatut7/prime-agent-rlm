import type { Context } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	type ImageContent,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * wave-40 secondary: when the provider rejects the session model itself, the
 * reconciliation moves the session (and a saved default pointing at the rejected
 * model) onto a model that can serve. The candidate scan used to happily land on
 * the configured image model - the cheap vision helper that only ever answered
 * routed image turns - so one rejected text model rewrote the user's default to a
 * picture reader. The image-route model is now skipped in both resolution paths.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const MODELS = [
	{ id: "faux-1", input: ["text" as const] },
	{ id: "faux-vision", input: ["text" as const, "image" as const] },
	{ id: "faux-glm", input: ["text" as const] },
];
const SETTINGS: Partial<Settings> = {
	imageModel: "faux/faux-vision",
	retry: { enabled: false },
};

/** The provider's deterministic verdict that the serving model cannot serve at all. */
const modelRejection = (): AssistantMessage => ({
	...fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "400 invalid_request_error: the model does not exist",
	}),
	diagnostics: [
		{
			type: "provider_stream_failure",
			timestamp: Date.now(),
			details: { kind: "invalid_request", status: 400 },
		},
	],
});

/** Answers from a per-model script, stamping the serving model like a real provider. */
function scripted(script: AssistantMessage[]): FauxResponseFactory {
	return (_context: Context, _options, _state, model) => {
		const next = script.shift();
		if (!next) throw new Error("no scripted answer left");
		return { ...next, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
	};
}

describe("rejected-model reconciliation vs the image model", () => {
	it("never moves the session default onto the configured image model", async () => {
		const harness = await createHarness({ models: MODELS, settings: SETTINGS });
		harnesses.push(harness);
		harness.settingsManager.setDefaultModelAndProvider("faux", "faux-1");

		// An image turn is routed to the vision helper, so the transcript's last
		// answering model besides the session model is faux-vision.
		const first = scripted([fauxAssistantMessage("图里是登录页。"), fauxAssistantMessage("已看完，登录页。")]);
		harness.setResponses([first, first]);
		await harness.session.prompt("看看这张图", { images: [IMAGE] });
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.model === "faux-vision"),
		).toBe(true);

		// The session model is then rejected outright: terminal, so the selection is
		// reconciled onto a model that can serve.
		harness.setResponses([scripted([modelRejection()])]);
		await harness.session.prompt("继续");

		// The vision helper answered most recently besides faux-1, but the session
		// must move to a general model, never to the picture reader.
		expect(harness.session.model?.id).toBe("faux-glm");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-glm");
		const notices = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message")
			.map((entry) => (entry.type === "custom_message" ? String(entry.content) : ""));
		expect(notices.some((text) => text.includes("faux-glm"))).toBe(true);
	});
});
