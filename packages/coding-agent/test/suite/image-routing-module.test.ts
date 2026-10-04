import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { batchCarriesImages, routeImagesOnAgentEvent, runModel } from "../../src/core/image-routing.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * The ninth AgentSession cut moves the image-routing cluster behind the
 * ImageRoutingHost seam in core/image-routing.ts. These pins drive the moved
 * functions with a live session as the host so the module owns the behavior the
 * shell's one-line forwarders delegate to.
 */

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const MODELS = [
	{ id: "faux-1", input: ["text"] as ("text" | "image")[], contextWindow: 200_000 },
	{ id: "faux-vision", input: ["text", "image"] as ("text" | "image")[], contextWindow: 200_000 },
];

function imageToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "take_screenshot",
		content: [IMAGE],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("image-routing module (the ninth cut's seam)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness({
			models: MODELS,
			settings: { imageModel: "faux/faux-vision", retry: { enabled: false } },
		});
		harnesses.push(created);
		return created;
	}

	it("moves the next request to the image model when a mid-run tool result carries images", async () => {
		const h = await harness();
		routeImagesOnAgentEvent(h.session, { type: "message_end", message: imageToolResult() });
		expect(h.session.agent.modelOverride?.model.id).toBe("faux-vision");
		expect(runModel(h.session)?.id).toBe("faux-vision");
	});

	it("hands the run back to the session model once the image model put the image into words", async () => {
		const h = await harness();
		routeImagesOnAgentEvent(h.session, { type: "message_end", message: imageToolResult() });
		expect(h.session.agent.modelOverride?.model.id).toBe("faux-vision");
		routeImagesOnAgentEvent(h.session, {
			type: "message_end",
			message: fauxAssistantMessage("图里是登录页，右下角写着 42。"),
		});
		expect(h.session.agent.modelOverride).toBeUndefined();
		expect(runModel(h.session)?.id).toBe("faux-1");
	});

	it("reads image content off the committed batch and its extra messages", () => {
		const withImage: AgentMessage = { role: "user", content: [IMAGE], timestamp: Date.now() };
		const textOnly: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		};
		expect(batchCarriesImages([], [withImage])).toBe(true);
		expect(batchCarriesImages([], [textOnly])).toBe(false);
		expect(batchCarriesImages([], [])).toBe(false);
	});
});
