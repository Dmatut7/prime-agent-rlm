import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
} from "../src/modes/agent-connection/types.js";
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

async function startRpcMode(): Promise<(event: AgentConnectionEvent) => void> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	let listener: AgentConnectionEventListener | undefined;
	const connection = {
		subscribe(next: AgentConnectionEventListener) {
			listener = next;
			return () => {};
		},
		async dispose() {},
	} as unknown as AgentConnection;
	void runRpcModeWithConnection(connection);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	return (event: AgentConnectionEvent) => {
		void listener?.(event);
	};
}

describe("RPC connection-level event forwarding", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("forwards quota park heartbeats as stdout JSON lines instead of dropping them", async () => {
		const emit = await startRpcMode();

		emit({
			type: "quota_park_status",
			parked: true,
			resumeAt: "2026-10-08T12:00:00.000Z",
			remainingMs: 86_400_000,
			parkCount: 2,
			provider: "anthropic",
		});

		await vi.waitFor(() => expect(parseOutputLines()).toHaveLength(1));
		// R5-M22: the payload is forwarded verbatim, the same `type` discriminator
		// the daemon wire uses, so an RPC consumer can see a park (up to 24h)
		// while its prompt hangs instead of watching a silent stream.
		expect(parseOutputLines()[0]).toEqual({
			type: "quota_park_status",
			parked: true,
			resumeAt: "2026-10-08T12:00:00.000Z",
			remainingMs: 86_400_000,
			parkCount: 2,
			provider: "anthropic",
		});
	});

	it("forwards daemon reconnect status and resync markers", async () => {
		const emit = await startRpcMode();

		emit({ type: "connection_status", status: "reconnecting", error: "socket hang up", backgroundAttempt: 3 });
		emit({
			type: "session_resynced",
			snapshot: { state: { cwd: process.cwd() }, messages: [] },
		} as unknown as AgentConnectionEvent);

		await vi.waitFor(() => expect(parseOutputLines()).toHaveLength(2));
		expect(parseOutputLines()[0]).toEqual({
			type: "connection_status",
			status: "reconnecting",
			error: "socket hang up",
			backgroundAttempt: 3,
		});
		expect(parseOutputLines()[1]).toMatchObject({
			type: "session_resynced",
			snapshot: { messages: [] },
		});
	});
});
