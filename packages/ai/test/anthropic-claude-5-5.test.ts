/**
 * Claude Sonnet 5.5 / Opus 5.5 request shaping. Both models 400 on forced tool
 * use (`tool_choice` any/tool); Opus 5.5 rejects `thinking: disabled` and
 * `enabled` outright (always-on adaptive), while Sonnet 5.5 replaces `disabled`
 * with `between_tools` (its lowest thinking setting, rejected at xhigh/max
 * effort) and rejects non-default sampling params. Sources:
 * https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
 * https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5
 */
import { describe, expect, it } from "vitest";
import { getModel, modelCannotDisableThinking } from "../src/models.js";
import type { AnthropicOptions } from "../src/providers/anthropic.js";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, SimpleStreamOptions, Tool } from "../src/types.js";

interface AnthropicPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
	tool_choice?: { type: string; name?: string };
}

const bashTool: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
	} as Tool["parameters"],
};

function makeContext(withTools = false): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		...(withTools ? { tools: [bashTool] } : {}),
	};
}

async function captureSimplePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = { ...model, baseUrl: "http://127.0.0.1:9" };
	const s = streamSimpleAnthropic(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			return payload;
		},
	});
	await s.result();
	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = { ...model, baseUrl: "http://127.0.0.1:9" };
	const s = streamAnthropic(payloadCaptureModel, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			return payload;
		},
	});
	await s.result();
	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

describe("Claude 5.5 catalog entries", () => {
	it("registers claude-opus-5-5 as always-on thinking (off is not a level)", () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, xhigh: "xhigh", max: "max" });
		expect(modelCannotDisableThinking(model)).toBe(true);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
	});

	it("registers claude-sonnet-5-5 with xhigh/max efforts and thinking still switchable off", () => {
		const model = getModel("anthropic", "claude-sonnet-5-5");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
		expect(modelCannotDisableThinking(model)).toBe(false);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
	});
});

describe("Claude Opus 5.5 thinking shaping", () => {
	it("omits the thinking field when thinking is off (explicit disabled is a 400)", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-opus-5-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("drops temperature even with thinking off (always-on thinking rejects sampling params)", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-opus-5-5"), { temperature: 0.5 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("omits thinking for a direct thinkingEnabled=false call at low effort", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"), makeContext(), {
			thinkingEnabled: false,
			effort: "low",
		});

		expect(payload.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with effort for reasoning levels", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-opus-5-5"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});
});

describe("Claude Sonnet 5.5 thinking shaping", () => {
	it("sends thinking.type=between_tools instead of disabled when thinking is off", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-sonnet-5-5"));

		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config).toBeUndefined();
	});

	it("drops temperature when thinking is off (non-default sampling params are a 400)", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-sonnet-5-5"), { temperature: 0.5 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "between_tools" });
	});

	it("sends between_tools at high effort or below", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(), {
			thinkingEnabled: false,
			effort: "high",
		});

		expect(payload.thinking).toEqual({ type: "between_tools" });
	});

	it("omits the thinking field at xhigh effort (between_tools is a 400 there)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(), {
			thinkingEnabled: false,
			effort: "xhigh",
		});

		expect(payload.thinking).toBeUndefined();
	});

	it("omits the thinking field at max effort (between_tools is a 400 there)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(), {
			thinkingEnabled: false,
			effort: "max",
		});

		expect(payload.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with effort for reasoning levels", async () => {
		const payload = await captureSimplePayload(getModel("anthropic", "claude-sonnet-5-5"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});
});

describe("Claude 5.5 forced tool choice downgrade", () => {
	it("downgrades tool_choice any to auto on claude-sonnet-5-5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(true), {
			toolChoice: "any",
		});

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("downgrades a forced tool to auto on claude-sonnet-5-5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(true), {
			toolChoice: { type: "tool", name: "bash" },
		});

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("keeps tool_choice none on claude-sonnet-5-5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), makeContext(true), {
			toolChoice: "none",
		});

		expect(payload.tool_choice).toEqual({ type: "none" });
	});

	it("downgrades tool_choice any to auto on claude-opus-5-5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"), makeContext(true), {
			toolChoice: "any",
		});

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("downgrades a forced tool to auto on claude-fable-5-1", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), makeContext(true), {
			toolChoice: { type: "tool", name: "bash" },
		});

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("still sends tool_choice any to models that accept it", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"), makeContext(true), {
			toolChoice: "any",
		});

		expect(payload.tool_choice).toEqual({ type: "any" });
	});
});
