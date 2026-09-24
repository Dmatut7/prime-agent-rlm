import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ImageContent,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * An image-routed run exists so the image model can read the images. Once it has put
 * what it saw into words, the rest of the run goes back to the session model: a
 * screenshot must not move a long task onto the image model. New images mid-run go
 * to the image model again, and a handback never leaks into the next run.
 */

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const MODELS = [
	{ id: "faux-1", input: ["text"] as ("text" | "image")[] },
	{ id: "faux-vision", input: ["text", "image"] as ("text" | "image")[] },
];

function tool(name: string, withImage = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({
			content: withImage ? [{ type: "text", text: "screenshot" }, IMAGE] : [{ type: "text", text: `${name} ok` }],
			details: {},
		}),
	};
}

/** Each call answers from the next scripted message and records which model served it. */
function recorded(script: ReturnType<typeof fauxAssistantMessage>[], served: string[]): FauxResponseStep {
	return (_context, _options, _state, model) => {
		served.push(model.id);
		const next = script.shift();
		if (!next) throw new Error("no scripted answer left");
		return next;
	};
}

describe("image-routed runs hand back to the session model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness({
			models: MODELS,
			settings: { imageModel: "faux/faux-vision" },
			tools: [tool("run_step"), tool("take_screenshot", true)],
		});
		harnesses.push(created);
		return created;
	}

	it("lets the image model read the screenshot, then the session model does the work", async () => {
		const h = await harness();
		const served: string[] = [];
		const script = [
			fauxAssistantMessage([fauxText("截图里是登录页，按钮错位了。"), fauxToolCall("run_step", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("run_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("按钮位置修好了。"),
		];
		const step = recorded(script, served);
		h.setResponses([step, step, step]);

		await h.session.prompt("看一下这个截图，把问题修掉", { images: [IMAGE] });

		expect(served).toEqual(["faux-vision", "faux-1", "faux-1"]);
		expect(h.session.agent.modelOverride).toBeUndefined();
	});

	it("keeps the image model while its first response is only a tool call", async () => {
		const h = await harness();
		const served: string[] = [];
		const script = [
			fauxAssistantMessage(fauxToolCall("run_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("看到了：页面空白。"), fauxToolCall("run_step", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("处理完了。"),
		];
		const step = recorded(script, served);
		h.setResponses([step, step, step]);

		await h.session.prompt("看图", { images: [IMAGE] });

		expect(served).toEqual(["faux-vision", "faux-vision", "faux-1"]);
	});

	it("goes back to the image model when a tool result brings a new image", async () => {
		const h = await harness();
		const served: string[] = [];
		const script = [
			fauxAssistantMessage([fauxText("第一张看完了，再截一张。"), fauxToolCall("take_screenshot", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("新截图里按钮对齐了。"), fauxToolCall("run_step", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("完成。"),
		];
		const step = recorded(script, served);
		h.setResponses([step, step, step]);

		await h.session.prompt("看图", { images: [IMAGE] });

		expect(served).toEqual(["faux-vision", "faux-vision", "faux-1"]);
	});

	it("does not let a handback left from the last run take the next image run", async () => {
		const h = await harness();
		const served: string[] = [];
		const script = [fauxAssistantMessage("第一张：登录页。"), fauxAssistantMessage("第二张：设置页。")];
		const step = recorded(script, served);
		h.setResponses([step, step]);

		await h.session.prompt("看图一", { images: [IMAGE] });
		await h.session.prompt("看图二", { images: [IMAGE] });

		expect(served).toEqual(["faux-vision", "faux-vision"]);
	});
});
