import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnection, AgentConnectionEventListener } from "../src/modes/agent-connection/types.js";
import { runRpcModeWithConnection } from "../src/modes/rpc/rpc-mode.js";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	restoreStdout: vi.fn(),
	isStdoutTakenOver: () => false,
	flushRawStdout: async () => {},
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: unknown, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type OutputRecord = Record<string, unknown>;

function parseOutputLines(): OutputRecord[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as OutputRecord);
}

function responses(): OutputRecord[] {
	return parseOutputLines().filter((record) => record.type === "response");
}

async function startRpcMode(): Promise<(line: string) => void> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	// The unknown-command path never reaches the connection, so a stub is enough.
	const connection = {
		subscribe(_listener: AgentConnectionEventListener) {
			return () => {};
		},
		async dispose() {},
	} as unknown as AgentConnection;
	void runRpcModeWithConnection(connection);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	return rpcIo.lineHandler!;
}

describe("RPC unknown command correlation", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("echoes the request id so the client can correlate the failure", async () => {
		const lineHandler = await startRpcMode();

		lineHandler(JSON.stringify({ id: "req_7", type: "not_a_command" }));

		await vi.waitFor(() => expect(responses()).toHaveLength(1));
		// RpcClient settles a pending request only for a `type: "response"` record that
		// carries the id it sent; an id-less error leaves it waiting out its 30s timeout.
		expect(responses()[0]).toEqual({
			id: "req_7",
			type: "response",
			command: "not_a_command",
			success: false,
			error: "Unknown command: not_a_command",
		});
	});

	it("keeps the error id-less when the request carried no id", async () => {
		const lineHandler = await startRpcMode();

		lineHandler(JSON.stringify({ type: "not_a_command" }));

		await vi.waitFor(() => expect(responses()).toHaveLength(1));
		expect(responses()[0]).toEqual({
			type: "response",
			command: "not_a_command",
			success: false,
			error: "Unknown command: not_a_command",
		});
		expect(Object.hasOwn(responses()[0], "id")).toBe(false);
	});
});
