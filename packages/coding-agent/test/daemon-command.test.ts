import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This module is the internal client behind the public agent commands
// (`prime-agent list|stop|rename|send|schedule`), which public-command.ts routes
// here with a synthesized "daemon" prefix. The user-facing `prime-agent daemon ...`
// surface was removed upstream; subcommands no public command routes to are rejected.
const daemonClientMock = vi.hoisted(() => {
	type Command = {
		type: string;
		name?: string;
		activeSessionId?: string;
		targetActiveSessionId?: string;
		fromActiveSessionId?: string;
		deliveryMode?: string;
		message?: string;
		schedule?: string;
		prompt?: string;
		includeInactive?: boolean;
		all?: boolean;
	};
	type Response =
		| { type: "response"; command: string; success: true; data?: unknown }
		| { type: "response"; command: string; success: false; error: string };

	const instances: MockDaemonClient[] = [];
	const behavior = {
		sessions: [] as Array<Record<string, unknown>>,
		/** Server capabilities the mocked daemon hello advertises. */
		serverCapabilities: ["send_message_delivery_mode"] as string[],
	};

	class MockDaemonClient {
		readonly requests: Command[] = [];

		constructor(readonly socketPath: string) {
			instances.push(this);
		}

		async connect(): Promise<void> {}

		async waitForHello(): Promise<void> {}

		supportsServerCapability(capability: string): boolean {
			return behavior.serverCapabilities.includes(capability);
		}

		async request(command: Command): Promise<Response> {
			this.requests.push(command);
			if (command.type === "list") {
				return { type: "response", command: command.type, success: true, data: { sessions: behavior.sessions } };
			}
			return { type: "response", command: command.type, success: true };
		}

		close(): void {}
	}

	return { MockDaemonClient, behavior, instances };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: daemonClientMock.MockDaemonClient,
}));

import { handleDaemonCommand } from "../src/cli/daemon-command.js";

describe("daemon command", () => {
	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		process.exitCode = undefined;
		daemonClientMock.instances.length = 0;
		daemonClientMock.behavior.sessions = [];
		daemonClientMock.behavior.serverCapabilities = ["send_message_delivery_mode"];
		consoleErrorMessages = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
			consoleErrorMessages.push(...messages);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("rejects removed daemon subcommands with the remediation instead of running them (R6-M3)", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "attach", "active-1"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances).toHaveLength(0);
		expect(process.exitCode).toBe(1);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Unknown daemon command: attach"),
			),
		).toBe(true);
	});

	it("lists sessions through the public list alias path", async () => {
		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "list"])).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([{ type: "list", all: false }]);
		expect(process.exitCode).toBeUndefined();
	});

	it("kills a session through the public stop alias path", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "kill", "active-1"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([{ type: "kill", activeSessionId: "active-1" }]);
		expect(process.exitCode).toBeUndefined();
	});

	it("renames a session through the public rename alias path", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "rename", "active-1", "new name"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([
			{ type: "rename", activeSessionId: "active-1", name: "new name" },
		]);
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects unknown send options instead of folding them into the message", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", "--bogus", "hello"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Unknown option for send: --bogus"),
			),
		).toBe(true);
	});

	it("supports send separator after the target for flag-like message text", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"worker",
				"--",
				"--from",
				"literal",
				"--steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			message: "--from literal --steer",
		});
	});

	it("supports send separator before a flag-like target or message", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--",
				"--target-like",
				"--from",
				"literal",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toMatchObject({
			type: "send_message",
			targetActiveSessionId: "--target-like",
			message: "--from literal",
		});
	});

	it("parses send message text from an explicit --message value", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--from",
				"planner",
				"worker",
				"--message",
				"please keep --from literal --steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: "planner",
			message: "please keep --from literal --steer",
		});
	});

	it("passes send --steer through as a send_message deliveryMode", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", "--steer", "hello"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			message: "hello",
			deliveryMode: "steer",
		});
	});

	it("passes send --follow-up through as a send_message deliveryMode", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "--follow-up", "worker", "hello"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			message: "hello",
			deliveryMode: "follow_up",
		});
	});

	it("rejects send with both --steer and --follow-up", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"worker",
				"--steer",
				"--follow-up",
				"hello",
			]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) =>
					typeof message === "string" && message.includes("--steer and --follow-up cannot be used together"),
			),
		).toBe(true);
	});

	it.each(["--follow-up", "--steer"] as const)(
		"refuses send %s against a daemon without send_message_delivery_mode",
		async (flag) => {
			daemonClientMock.behavior.serverCapabilities = [];

			await expect(
				handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", flag, "hello"]),
			).resolves.toBe(true);

			expect(daemonClientMock.instances[0]?.requests).toEqual([]);
			expect(process.exitCode).toBe(1);
			expect(
				consoleErrorMessages.some(
					(message) =>
						typeof message === "string" &&
						message.includes(`too old to honor ${flag}`) &&
						message.includes("send_message_delivery_mode"),
				),
			).toBe(true);
		},
	);

	it("keeps bare send on the legacy path against a daemon without send_message_delivery_mode", async () => {
		daemonClientMock.behavior.serverCapabilities = [];

		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", "hello"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			message: "hello",
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("preserves cron add separator before the scheduled prompt", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"cron",
				"add",
				"active-1",
				"in 5m",
				"--",
				"check status",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "cron_add",
			activeSessionId: "active-1",
			schedule: "in 5m",
			prompt: "check status",
		});
	});

	it("resolves agent names before filtering scheduled prompts", async () => {
		daemonClientMock.behavior.sessions = [makeSessionSummary("active-1", "session-1", "alpha")];

		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "--json", "cron", "list", "alpha"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([
			{ type: "list" },
			{ type: "cron_list", activeSessionId: "active-1", includeInactive: false },
		]);
	});
});

function makeSessionSummary(activeSessionId: string, sessionId: string, sessionName: string): Record<string, unknown> {
	return {
		id: activeSessionId,
		activeSessionId,
		sessionId,
		sessionName,
		cwd: "/tmp/project",
		lifecycle: "ready",
		activity: "idle",
		isSessionActive: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}
