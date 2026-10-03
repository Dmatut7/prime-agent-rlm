import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isModelChangeMessage, MODEL_CHANGE_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

// W25-A: a mid-session model switch used to be invisible to the model itself -
// the transcript recorded model_change but the LLM context never carried it, so
// the model kept acting as the old model (the "kill and respawn" confusion).
describe("model change notice reaches the model context", () => {
	it("pushes a model-visible notice into the session state after setModel", async () => {
		const harness: Harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		harness.setResponses([fauxAssistantMessage("first answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.messages.some((m) => isModelChangeMessage(m))).toBe(false);

		const current = harness.session.model;
		expect(current).toBeDefined();
		const other = harness.modelRegistry
			.getAll()
			.find((m) => m.provider === current!.provider && m.id !== current!.id);
		expect(other).toBeDefined();
		await harness.session.setModel(other!);

		const notice = harness.session.messages.find((m) => isModelChangeMessage(m));
		expect(notice).toBeDefined();
		expect(notice!.role).toBe("custom");
		expect((notice as { customType?: string }).customType).toBe(MODEL_CHANGE_CUSTOM_TYPE);
		expect(JSON.stringify(notice)).toContain(other!.id);

		// The assembly path (resume/compaction) produces the same notice from the
		// durable model_change entry.
		const assembled = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "model_change")
			.map((e) => (e as { provider?: string; modelId?: string }).modelId);
		expect(assembled).toContain(other!.id);
		harness.cleanup();
	});

	it("does not turn the creation-prefix model_change into a notice on rebuild", async () => {
		const harness: Harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.prompt("hello");

		// A fresh session's context carries no model_change notice: the leading
		// entry is creation bookkeeping, not a switch.
		const rebuilt = harness.sessionManager.buildSessionContext();
		expect(rebuilt.messages.some((m) => isModelChangeMessage(m))).toBe(false);
		harness.cleanup();
	});
});
