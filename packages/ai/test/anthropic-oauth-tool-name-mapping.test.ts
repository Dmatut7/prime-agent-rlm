import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, Tool } from "../src/types.js";

/**
 * OAuth ("Claude Code stealth") requests rewrite local tool names to the canonical Claude Code
 * names before they go on the wire. Two distinct local tools must never be folded onto one wire
 * name, and a tool_use name coming back must be attributed to the tool that actually declared it.
 */

const OAUTH_TOKEN = "sk-ant-oat01-probe-token";

function tool(name: string): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({ command: Type.String() }),
	};
}

function sse(events: Array<{ event: string; data: unknown }>): string {
	return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const messageStart = {
	event: "message_start",
	data: {
		type: "message_start",
		message: {
			id: "msg_probe",
			type: "message",
			role: "assistant",
			model: "probe",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		},
	},
};

const messageStop = { event: "message_stop", data: { type: "message_stop" } };

function textStream(): string {
	return sse([
		messageStart,
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
		},
		messageStop,
	]);
}

function toolUseStream(name: string): string {
	return sse([
		messageStart,
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_probe", name, input: {} },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
			},
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
		},
		messageStop,
	]);
}

interface FakeAnthropic {
	model: Model<"anthropic-messages">;
	capturedRequests: Array<Record<string, any>>;
	close: () => Promise<void>;
}

async function startFakeAnthropic(body: () => string): Promise<FakeAnthropic> {
	const capturedRequests: Array<Record<string, any>> = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			try {
				capturedRequests.push(JSON.parse(raw) as Record<string, any>);
			} catch {
				capturedRequests.push({ unparsed: raw });
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(body());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	const model = {
		id: "claude-probe",
		name: "probe",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: `http://127.0.0.1:${port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
	} as Model<"anthropic-messages">;

	return {
		model,
		capturedRequests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function contextWith(tools: Tool[]): Context {
	return {
		messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
		tools,
	};
}

async function wireToolNames(fake: FakeAnthropic, tools: Tool[]): Promise<string[]> {
	const stream = streamAnthropic(fake.model, contextWith(tools), { apiKey: OAUTH_TOKEN });
	for await (const _event of stream) {
		// drain
	}
	await stream.result();
	const request = fake.capturedRequests[0];
	return ((request?.tools ?? []) as Array<{ name: string }>).map((definition) => definition.name);
}

async function reportedToolCallNames(fake: FakeAnthropic, tools: Tool[]): Promise<string[]> {
	const stream = streamAnthropic(fake.model, contextWith(tools), { apiKey: OAUTH_TOKEN });
	const names: string[] = [];
	for await (const event of stream) {
		if (event.type === "toolcall_end") {
			const part = event.partial.content[event.contentIndex];
			if (part.type === "toolCall") names.push(part.name);
		}
	}
	await stream.result();
	return names;
}

describe("Anthropic OAuth tool name mapping", () => {
	it("still folds a lone lowercase tool onto its Claude Code alias", async () => {
		const fake = await startFakeAnthropic(textStream);
		try {
			expect(await wireToolNames(fake, [tool("bash"), tool("myCustomTool")])).toEqual(["Bash", "myCustomTool"]);
		} finally {
			await fake.close();
		}
	});

	it("never sends two distinct tools under the same wire name", async () => {
		const fake = await startFakeAnthropic(textStream);
		try {
			const names = await wireToolNames(fake, [tool("bash"), tool("Bash"), tool("myCustomTool")]);

			expect(new Set(names).size).toBe(names.length);
			expect(names).toContain("myCustomTool");
			expect(names.length).toBe(3);
		} finally {
			await fake.close();
		}
	});

	it("attributes a tool_use name to the tool that declared it", async () => {
		const fake = await startFakeAnthropic(() => toolUseStream("Bash"));
		try {
			const names = await reportedToolCallNames(fake, [tool("bash"), tool("Bash")]);

			expect(names).toEqual(["Bash"]);
		} finally {
			await fake.close();
		}
	});
});
