import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool, ToolCall } from "../types.js";

/**
 * A loopback MCP server (streamable HTTP, JSON responses only) that serves a session's
 * tools to the Claude Code CLI. Claude Code never runs the tools itself: each
 * `tools/call` is held open until the session executes the call and hands the result
 * back through {@link ClaudeCodeToolServer.deliver}. Claude Code names the tool_use a
 * call belongs to in `_meta`, which is what pairs a held request with its result.
 */

export type ClaudeCodeToolResultContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface ClaudeCodeToolResult {
	content: ClaudeCodeToolResultContent[];
	isError: boolean;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

type JsonRpcResponse =
	| { jsonrpc: "2.0"; id: string | number | null; result: unknown }
	| { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

function errorResult(text: string): ClaudeCodeToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** A call from a CLI that sends no tool_use id, waiting until the calls it may belong to are known. */
interface UnmatchedCall {
	name: unknown;
	args: string;
	resolve: (toolUseId: string | undefined) => void;
}

export class ClaudeCodeToolServer {
	private readonly token = randomUUID();
	private readonly results = new Map<string, ClaudeCodeToolResult>();
	private readonly waiting = new Map<string, (result: ClaudeCodeToolResult) => void>();
	private expected: ToolCall[] = [];
	private unmatched: UnmatchedCall[] = [];
	private closed = false;

	/** Told about every call with a tool_use id, so the session can check it against the turn it knows. */
	onCall?: (toolUseId: string) => void;

	private constructor(
		private readonly server: Server,
		private readonly tools: Tool[],
	) {}

	static async start(tools: Tool[]): Promise<ClaudeCodeToolServer> {
		let instance: ClaudeCodeToolServer | undefined;
		const server = createServer((request, response) => {
			instance?.handle(request, response);
		});
		// A held tools/call can legitimately stay open for as long as the tool runs.
		server.requestTimeout = 0;
		server.timeout = 0;
		instance = new ClaudeCodeToolServer(server, tools);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		return instance;
	}

	get url(): string {
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}/mcp/${this.token}`;
	}

	/** Register the calls of the assistant message that just ended, for requests that lack a tool_use id. */
	expect(calls: ToolCall[]): void {
		this.expected = [...calls];
		const unmatched = this.unmatched;
		this.unmatched = [];
		for (const call of unmatched) call.resolve(this.claimExpected(call.name, call.args));
	}

	deliver(toolUseId: string, result: ClaudeCodeToolResult): void {
		const waiter = this.waiting.get(toolUseId);
		if (waiter) {
			this.waiting.delete(toolUseId);
			waiter(result);
			return;
		}
		this.results.set(toolUseId, result);
	}

	/** Whether the process should stay alive for this server; an idle session's server must not hold it. */
	setKeepAlive(keepAlive: boolean): void {
		if (keepAlive) this.server.ref();
		else this.server.unref();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const abandoned = errorResult("The session ended before this tool call finished.");
		for (const waiter of this.waiting.values()) waiter(abandoned);
		this.waiting.clear();
		for (const call of this.unmatched) call.resolve(undefined);
		this.unmatched = [];
		this.server.closeAllConnections();
		this.server.close();
	}

	private handle(request: IncomingMessage, response: ServerResponse): void {
		if (request.url !== `/mcp/${this.token}`) {
			response.writeHead(404).end();
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		if (request.method !== "POST") {
			// No server-initiated stream: every response is a plain JSON reply.
			response.writeHead(405, { allow: "POST, DELETE" }).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				this.reply(response, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
				return;
			}
			const items = Array.isArray(parsed) ? parsed : [parsed];
			if (items.length === 0 || !items.every((item) => typeof item === "object" && item !== null)) {
				this.reply(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
				return;
			}
			Promise.all((items as JsonRpcRequest[]).map((item) => this.dispatch(item, response)))
				.then((replies) => {
					const answered = replies.filter((reply): reply is JsonRpcResponse => reply !== undefined);
					if (response.writableEnded || response.destroyed) return;
					if (answered.length === 0) {
						response.writeHead(202).end();
					} else {
						this.reply(response, Array.isArray(parsed) ? answered : answered[0]);
					}
				})
				.catch((error: unknown) => {
					this.reply(response, {
						jsonrpc: "2.0",
						id: null,
						error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
					});
				});
		});
	}

	private reply(response: ServerResponse, payload: JsonRpcResponse | JsonRpcResponse[]): void {
		if (response.writableEnded || response.destroyed) return;
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
	}

	private async dispatch(request: JsonRpcRequest, response: ServerResponse): Promise<JsonRpcResponse | undefined> {
		const id = request.id;
		if (id === undefined) return undefined;
		const result = (value: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result: value });
		switch (request.method) {
			case "initialize":
				return result({
					protocolVersion:
						typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "prime", version: "1" },
				});
			case "ping":
				return result({});
			case "tools/list":
				return result({
					tools: this.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.parameters,
					})),
				});
			case "tools/call":
				return result(await this.call(request.params ?? {}, response));
			default:
				return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
		}
	}

	private async call(params: Record<string, unknown>, response: ServerResponse): Promise<ClaudeCodeToolResult> {
		const toolUseId = await this.resolveToolUseId(params);
		if (!toolUseId) {
			return errorResult("This tool call could not be matched to a tool use in the conversation.");
		}
		this.onCall?.(toolUseId);
		const ready = this.results.get(toolUseId);
		if (ready) {
			this.results.delete(toolUseId);
			return ready;
		}
		if (this.closed) return errorResult("The session ended before this tool call finished.");
		return new Promise((resolve) => {
			this.waiting.set(toolUseId, resolve);
			response.on("close", () => {
				if (this.waiting.get(toolUseId) === resolve) this.waiting.delete(toolUseId);
			});
		});
	}

	private resolveToolUseId(params: Record<string, unknown>): Promise<string | undefined> {
		const meta = params._meta;
		if (meta && typeof meta === "object") {
			const id = (meta as Record<string, unknown>)[TOOL_USE_ID_META_KEY];
			if (typeof id === "string" && id.length > 0) {
				this.expected = this.expected.filter((call) => call.id !== id);
				return Promise.resolve(id);
			}
		}
		// Older CLIs send no tool_use id: pair the call with an expected call of the same
		// name and input, waiting for the message that makes it expected if it is not yet.
		const args = JSON.stringify(params.arguments ?? {});
		const claimed = this.claimExpected(params.name, args);
		if (claimed || this.closed) return Promise.resolve(claimed);
		return new Promise((resolve) => {
			this.unmatched.push({ name: params.name, args, resolve });
		});
	}

	private claimExpected(name: unknown, args: string): string | undefined {
		const index = this.expected.findIndex(
			(call) => call.name === name && JSON.stringify(call.arguments ?? {}) === args,
		);
		if (index === -1) return undefined;
		const [match] = this.expected.splice(index, 1);
		return match.id;
	}
}
