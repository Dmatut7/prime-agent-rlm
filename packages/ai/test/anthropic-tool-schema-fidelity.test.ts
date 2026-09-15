import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, Tool } from "../src/types.js";

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

interface CaptureResult {
	/** Parsed request body, or null when the provider refused to send one. */
	body: Record<string, unknown> | null;
	/** Provider error message, or null when the request reached the wire. */
	error: string | null;
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function captureAnthropicRequest(tools: Tool[]): Promise<CaptureResult> {
	let captured: Record<string, unknown> | null = null;
	let error: string | null = null;

	const server = createServer(async (request, response: ServerResponse) => {
		captured = await readRequestBody(request);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
			tools,
		};
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});
		for await (const event of stream) {
			if (event.type === "error") error = event.error.errorMessage ?? "unknown provider error";
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((closeError) => (closeError ? reject(closeError) : resolve()));
		});
	}

	if (captured === null && error === null) {
		throw new Error("neither a request nor an error was observed");
	}
	return { body: captured, error };
}

function firstToolInputSchema(body: Record<string, unknown> | null): Record<string, unknown> {
	if (body === null) throw new Error("no request body was captured");
	const tools = body.tools;
	if (!Array.isArray(tools) || typeof tools[0] !== "object" || tools[0] === null) {
		throw new Error("expected a first tool in the request body");
	}
	const tool = tools[0] as Record<string, unknown>;
	const schema = tool.input_schema;
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		throw new Error("expected an input_schema object");
	}
	return schema as Record<string, unknown>;
}

/** Collect every `$ref` string in a schema, the way an interpreter would walk it. */
function collectRefs(value: unknown, refs: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectRefs(item, refs);
		return refs;
	}
	if (typeof value !== "object" || value === null) return refs;
	for (const [key, nested] of Object.entries(value)) {
		if (key === "$ref") {
			refs.push(typeof nested === "string" ? nested : JSON.stringify(nested));
			continue;
		}
		collectRefs(nested, refs);
	}
	return refs;
}

/** Resolve an in-document JSON Pointer (RFC 6901) against the schema. */
function resolvesInDocument(root: unknown, pointer: string): boolean {
	if (pointer === "#" || pointer === "") return true;
	if (!pointer.startsWith("#/")) return false;
	let node: unknown = root;
	for (const rawToken of pointer.slice(2).split("/")) {
		const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(node)) {
			if (!/^\d+$/.test(token)) return false;
			const index = Number.parseInt(token, 10);
			if (index >= node.length) return false;
			node = node[index];
			continue;
		}
		if (typeof node !== "object" || node === null || !Object.hasOwn(node, token)) return false;
		node = (node as Record<string, unknown>)[token];
	}
	return true;
}

function danglingRefs(schema: Record<string, unknown>): string[] {
	return [...new Set(collectRefs(schema))].filter((ref) => !resolvesInDocument(schema, ref));
}

describe("anthropic tool schema fidelity", () => {
	it("keeps $defs so every $ref in the converted schema still resolves", async () => {
		const tool: Tool = {
			name: "create_item",
			description: "Create an item",
			parameters: {
				type: "object",
				properties: {
					item: { $ref: "#/$defs/item" },
					note: { type: "string" },
				},
				required: ["item"],
				$defs: {
					item: {
						type: "object",
						properties: { id: { type: "number" }, parent: { $ref: "#/$defs/item" } },
						required: ["id"],
						additionalProperties: false,
					},
				},
			} as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);
		expect(error).toBeNull();
		const schema = firstToolInputSchema(body);

		expect(schema.$defs).toEqual({
			item: {
				type: "object",
				properties: { id: { type: "number" }, parent: { $ref: "#/$defs/item" } },
				required: ["id"],
				additionalProperties: false,
			},
		});
		expect(danglingRefs(schema)).toEqual([]);
	});

	it("keeps a legacy definitions block that $ref points at", async () => {
		const tool: Tool = {
			name: "create_item",
			description: "Create an item",
			parameters: {
				type: "object",
				properties: { item: { $ref: "#/definitions/item" } },
				required: ["item"],
				definitions: { item: { type: "object", properties: { id: { type: "number" } } } },
			} as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);
		expect(error).toBeNull();
		const schema = firstToolInputSchema(body);

		expect(schema.definitions).toEqual({
			item: { type: "object", properties: { id: { type: "number" } } },
		});
		expect(danglingRefs(schema)).toEqual([]);
	});

	it("keeps root composition keywords instead of silently widening the contract", async () => {
		const tool: Tool = {
			name: "submit",
			description: "Submit one of two shapes",
			parameters: {
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				anyOf: [{ required: ["a"] }, { required: ["b"] }],
				minProperties: 1,
				maxProperties: 2,
				propertyNames: { pattern: "^[ab]$" },
			} as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);
		expect(error).toBeNull();
		const schema = firstToolInputSchema(body);

		expect(schema.anyOf).toEqual([{ required: ["a"] }, { required: ["b"] }]);
		expect(schema.minProperties).toBe(1);
		expect(schema.maxProperties).toBe(2);
		expect(schema.propertyNames).toEqual({ pattern: "^[ab]$" });
		expect(schema.type).toBe("object");
	});

	it("still drops inert schema annotations", async () => {
		const tool: Tool = {
			name: "noop",
			description: "No-op",
			parameters: {
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$id: "urn:noop",
				$comment: "annotation",
				title: "Noop",
				default: { a: "b" },
				type: "object",
				properties: { a: { type: "string" } },
				required: ["a"],
			} as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);
		expect(error).toBeNull();
		const schema = firstToolInputSchema(body);

		expect(schema).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
	});

	it("refuses to send a tool whose $ref cannot be resolved instead of dropping $defs", async () => {
		const tool: Tool = {
			name: "create_item",
			description: "Create an item",
			parameters: {
				type: "object",
				properties: { item: { $ref: "#/$defs/missing" } },
				required: ["item"],
				$defs: { other: { type: "string" } },
			} as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);

		expect(body).toBeNull();
		expect(error).toContain("#/$defs/missing");
		expect(error).toContain("create_item");
	});

	it("refuses a root schema that is not an object schema", async () => {
		const tool: Tool = {
			name: "raw_value",
			description: "Take a raw string",
			parameters: { type: "string" } as unknown as Tool["parameters"],
		};

		const { body, error } = await captureAnthropicRequest([tool]);

		expect(body).toBeNull();
		expect(error).toContain("raw_value");
	});
});
