import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonRequestTimeoutError } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION } from "../src/modes/daemon/daemon-protocol.js";
import { DEFAULT_CLIENT_CATCHUP_RETRY_POLICY, transientRetryAfterMs } from "../src/modes/daemon/daemon-supervisor.js";
import { TRANSIENT_RETRY_MAX_ATTEMPTS, TRANSIENT_RETRY_WINDOW_MS } from "../src/modes/daemon/daemon-transient-retry.js";

const netMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class MockSocket {
		private readonly listeners = new Map<string, Set<Listener>>();
		readonly writes: string[] = [];
		destroyed = false;
		/** Test hook: called with every line the client puts on the wire. */
		onWrite?: (line: string) => void;

		constructor(readonly path: string) {}

		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? new Set<Listener>();
			listeners.add(listener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: Listener): this {
			const onceListener: Listener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event);
			if (!listeners) return this;
			listeners.delete(listener);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners) return false;
			for (const listener of [...listeners]) listener(...args);
			return true;
		}

		destroy(): this {
			this.destroyed = true;
			return this;
		}

		end(): this {
			return this;
		}

		removeAllListeners(): this {
			this.listeners.clear();
			return this;
		}

		write(chunk: string | Buffer): boolean {
			const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			this.writes.push(line);
			this.onWrite?.(line);
			return true;
		}
	}

	const sockets: MockSocket[] = [];
	const createConnection = vi.fn((path: string) => {
		const socket = new MockSocket(path);
		sockets.push(socket);
		return socket;
	});

	return { MockSocket, createConnection, sockets };
});

vi.mock("node:net", () => ({
	createConnection: netMock.createConnection,
}));

interface SentCommand {
	id: string;
	type: string;
	command: Record<string, unknown>;
}

interface FakeSupervisor {
	client: DaemonClient;
	socket: (typeof netMock.sockets)[number];
	/** Commands the client put on the wire, minus result acknowledgements. */
	sent: SentCommand[];
	respond(id: string, command: string, body: Record<string, unknown>): void;
}

/**
 * A daemon that answers from a script. `script` is called with the 1-based
 * attempt count for the command, so a test can defer first and succeed second.
 */
async function startFakeSupervisor(
	script: (command: Record<string, unknown>, attempt: number) => Record<string, unknown> | undefined,
): Promise<FakeSupervisor> {
	const client = new DaemonClient("/tmp/prime-agent-transient.sock");
	const connect = client.connect();
	netMock.sockets[netMock.sockets.length - 1]!.emit("connect");
	await connect;
	const socket = netMock.sockets[netMock.sockets.length - 1]!;
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent-transient.sock",
			protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
			clientId: "client-transient",
			serverCapabilities: ["session_input_admission"],
		})}\n`,
	);
	const sent: SentCommand[] = [];
	const attempts = new Map<string, number>();
	const supervisor: FakeSupervisor = {
		client,
		socket,
		sent,
		respond(id, command, body) {
			socket.emit("data", `${JSON.stringify({ id, type: "response", command, ...body })}\n`);
		},
	};
	socket.onWrite = (line) => {
		const envelope = JSON.parse(line.trim()) as {
			id?: string;
			command?: { id?: string; type?: string } & Record<string, unknown>;
		};
		const command = envelope.command;
		if (!envelope.id || !command || !command.type || command.type === "ack_result") return;
		const attempt = (attempts.get(command.type) ?? 0) + 1;
		attempts.set(command.type, attempt);
		sent.push({ id: envelope.id, type: command.type, command });
		const body = script(command, attempt);
		if (body) supervisor.respond(envelope.id, command.type, body);
	};
	return supervisor;
}

const deferred = { success: false, error: "Session worker is recovering", retryAfterMs: 50 };

describe("P1-7a transient retry hint", () => {
	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries inside the request budget when the daemon defers with retryAfterMs", async () => {
		const supervisor = await startFakeSupervisor((_command, attempt) =>
			attempt === 1 ? deferred : { success: true, data: { state: "ready" } },
		);

		// RED on HEAD: the client returned the first failure instead of retrying.
		const response = await supervisor.client.request({ type: "get_state", activeSessionId: "active-1" }, 5_000);

		expect(response).toMatchObject({ success: true, data: { state: "ready" } });
		expect(supervisor.sent).toHaveLength(2);
		// Each attempt is its own command id: the daemon already answered the first one.
		expect(supervisor.sent[0]!.id).not.toBe(supervisor.sent[1]!.id);
		supervisor.client.close();
	});

	it("returns a failure immediately when it carries no retry hint", async () => {
		const supervisor = await startFakeSupervisor(() => ({ success: false, error: "Unknown active session: x" }));

		const response = await supervisor.client.request({ type: "get_state", activeSessionId: "active-1" }, 5_000);

		expect(response).toMatchObject({ success: false, error: "Unknown active session: x" });
		expect(response).not.toHaveProperty("retryAfterMs");
		expect(supervisor.sent).toHaveLength(1);
		supervisor.client.close();
	});

	it("throws a typed timeout when the hint is longer than the budget left", async () => {
		const supervisor = await startFakeSupervisor(() => ({ ...deferred, retryAfterMs: 5_000 }));

		// MUTATION guard: an implementation that waits without checking the budget
		// would sit in the 5s hint instead of failing inside the 80ms budget.
		const error = await supervisor.client
			.request({ type: "get_state", activeSessionId: "active-1" }, 80)
			.then(() => undefined)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DaemonRequestTimeoutError);
		const timeout = error as DaemonRequestTimeoutError;
		expect(timeout.commandType).toBe("get_state");
		expect(timeout.timeoutMs).toBe(80);
		// The daemon rejected the command before running it, so re-issuing is safe.
		expect(timeout.retryable).toBe(true);
		expect(timeout.stateHint).toBe("transient_rejection");
		expect(supervisor.sent).toHaveLength(1);
		supervisor.client.close();
	});

	it("stops at the merged attempt bound and hands back the last failure", async () => {
		const supervisor = await startFakeSupervisor(() => ({ ...deferred, retryAfterMs: 1 }));

		const response = await supervisor.client.request({ type: "get_state", activeSessionId: "active-1" }, 60_000);

		expect(response).toMatchObject({ success: false, error: "Session worker is recovering" });
		expect(supervisor.sent).toHaveLength(TRANSIENT_RETRY_MAX_ATTEMPTS);
		supervisor.client.close();
	});

	it("caps the retry window even when the caller's budget is larger", async () => {
		vi.useFakeTimers();
		const supervisor = await startFakeSupervisor(() => ({ ...deferred, retryAfterMs: 60_000 }));

		const request = supervisor.client.request(
			{ type: "get_state", activeSessionId: "active-1" },
			TRANSIENT_RETRY_WINDOW_MS * 4,
		);
		const settled = request.then(
			(response) => ({ kind: "response" as const, response }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);
		// Five 60s hints fill the five-minute window; the sixth does not fit.
		await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_WINDOW_MS + 1_000);
		const outcome = await settled;

		expect(outcome.kind).toBe("error");
		expect(outcome.kind === "error" && outcome.error).toBeInstanceOf(DaemonRequestTimeoutError);
		expect(supervisor.sent).toHaveLength(Math.floor(TRANSIENT_RETRY_WINDOW_MS / 60_000));
		supervisor.client.close();
	});

	it("types a socket timeout with the command type and whether re-issuing is safe", async () => {
		vi.useFakeTimers();
		const cases = [
			{
				command: { type: "get_state", activeSessionId: "active-1" } as const,
				retryable: true,
				reason: "a read cannot have changed anything",
			},
			{
				command: { type: "prompt", activeSessionId: "active-1", message: "hi" } as const,
				retryable: false,
				reason: "a mutation may already be running server-side",
			},
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			const supervisor = await startFakeSupervisor(() => undefined);
			const settled = supervisor.client.request(testCase.command, 20).then(
				() => undefined,
				(caught: unknown) => caught as Error,
			);
			await vi.advanceTimersByTimeAsync(20);
			const error = await settled;

			expect(error, testCase.reason).toBeInstanceOf(DaemonRequestTimeoutError);
			const timeout = error as DaemonRequestTimeoutError;
			expect(timeout.commandType).toBe(testCase.command.type);
			expect(timeout.timeoutMs).toBe(20);
			expect(timeout.retryable).toBe(testCase.retryable);
			expect(timeout.stateHint).toBe("no_response");
			// The user-visible sentence predates the typing and must not change.
			expect(timeout.message).toContain(
				`Timed out after 20ms waiting for the Prime Agent daemon response to "${testCase.command.type}".`,
			);
			supervisor.client.close();
		}
	});

	it("stops a retry wait when the client is closed instead of parking the caller", async () => {
		vi.useFakeTimers();
		const supervisor = await startFakeSupervisor(() => ({ ...deferred, retryAfterMs: 60_000 }));

		const settled = supervisor.client.request({ type: "get_state", activeSessionId: "active-1" }, 600_000).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(supervisor.sent).toHaveLength(1);
		supervisor.client.close();
		const error = await settled;

		expect(error?.message).toContain("Prime Agent daemon client closed before the operation completed.");
		expect(supervisor.sent).toHaveLength(1);
	});

	it("hints the supervisor's own recheck interval per transient state and never for a terminal one", () => {
		const cases = [
			{ message: "Session worker is recovering", expected: 5_000 },
			{ message: "Session worker is recovering; cannot kill active-1 until it is reachable", expected: 5_000 },
			{ message: "Session worker is stopping", expected: 250 },
			{ message: "Session worker is stopping; retry after it finishes", expected: 250 },
			{ message: "Session worker is failed", expected: undefined },
			{ message: "Session worker is starting", expected: undefined },
			{ message: "Session worker is not connected", expected: undefined },
			{ message: "Unknown active session: active-1", expected: undefined },
			// A worker's own text is forwarded verbatim: anchored patterns must not claim it.
			{ message: "Cannot list heartbeats while session worker is recovering", expected: undefined },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(transientRetryAfterMs(new Error(testCase.message)), testCase.message).toBe(testCase.expected);
		}
	});

	it("keeps the client retry bound equal to the supervisor's catch-up bound", () => {
		// B9/L4: both sides of the same amplification share one merged bound.
		expect(DEFAULT_CLIENT_CATCHUP_RETRY_POLICY.maxAttempts).toBe(TRANSIENT_RETRY_MAX_ATTEMPTS);
		expect(DEFAULT_CLIENT_CATCHUP_RETRY_POLICY.deadlineMs).toBe(TRANSIENT_RETRY_WINDOW_MS);
	});
});
