import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";

/**
 * Characterization pins for AgentDaemon.handleCommand's non-standard dispatch
 * edges: envelope validation runs before the handler for every command type,
 * supervisor-only command types fall through unanswered, ack_result answers with
 * no response, and the prompt handlers take over admission ownership and answer
 * asynchronously. Every test drives a prototype-only daemon (no constructor), the
 * shape the daemon test harnesses use.
 */

type DispatchHarness = {
	handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
		onPromptHandlerOwnsAdmission?: () => void,
	): Promise<DaemonResponse | undefined>;
};

function createDaemon(overrides: Record<string, unknown> = {}): DispatchHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		log: vi.fn(),
		...overrides,
	}) as DispatchHarness;
}

function createClient(): DaemonSocketClient {
	return { id: "client-1" } as unknown as DaemonSocketClient;
}

describe("agent daemon command dispatch", () => {
	it("rejects an empty agentMessageId before dispatching any command type", async () => {
		const daemon = createDaemon();
		const command = { id: "ack-1", type: "ack_result", commandId: "cmd-1", agentMessageId: "" };

		await expect(daemon.handleCommand(createClient(), command as unknown as DaemonCommand)).rejects.toThrow(
			"agentMessageId must not be empty",
		);
	});

	it("rejects an empty admissionId before dispatching any command type", async () => {
		const daemon = createDaemon();
		const command = { id: "ack-2", type: "ack_result", commandId: "cmd-1", admissionId: "" };

		await expect(daemon.handleCommand(createClient(), command as unknown as DaemonCommand)).rejects.toThrow(
			"admissionId must not be empty",
		);
	});

	it("runs envelope validation before the handler's own session resolution", async () => {
		const daemon = createDaemon({
			getSessionState: vi.fn(() => {
				throw new Error("Unknown active session: active-1");
			}),
		});
		const command = { id: "kill-1", type: "kill", activeSessionId: "active-1", agentMessageId: "" };

		await expect(daemon.handleCommand(createClient(), command as unknown as DaemonCommand)).rejects.toThrow(
			"agentMessageId must not be empty",
		);
	});

	it("rejects steer replay fields before session resolution unless template expansion is off", async () => {
		const daemon = createDaemon({
			getBoundSessionState: vi.fn(() => {
				throw new Error("must not reach session resolution");
			}),
		});
		const steer = {
			id: "steer-1",
			type: "steer",
			activeSessionId: "active-1",
			message: "hello",
			content: [{ type: "text", text: "replay" }],
		};
		await expect(daemon.handleCommand(createClient(), steer as unknown as DaemonCommand)).rejects.toThrow(
			"steer replay fields (content) require expandPromptTemplates=false",
		);

		const followUp = {
			id: "follow-1",
			type: "follow_up",
			activeSessionId: "active-1",
			message: "hello",
			customMessage: { role: "custom" },
		};
		await expect(daemon.handleCommand(createClient(), followUp as unknown as DaemonCommand)).rejects.toThrow(
			"follow_up replay fields (customMessage) require expandPromptTemplates=false",
		);
	});

	it("answers ack_result with no response", async () => {
		const daemon = createDaemon();

		const response = await daemon.handleCommand(createClient(), {
			id: "ack-3",
			type: "ack_result",
			commandId: "cmd-1",
		});

		expect(response).toBeUndefined();
	});

	it("leaves supervisor-only command types unanswered instead of rejecting them", async () => {
		const daemon = createDaemon({
			getSessionState: vi.fn(() => {
				throw new Error("must not reach session resolution");
			}),
		});

		const response = await daemon.handleCommand(createClient(), {
			id: "reattach-1",
			type: "reattach",
			activeSessionId: "active-1",
			targetActiveSessionId: "active-2",
		});

		expect(response).toBeUndefined();
	});

	it("rejects retry_worker without touching session state", async () => {
		const daemon = createDaemon();

		await expect(
			daemon.handleCommand(createClient(), { id: "retry-1", type: "retry_worker", activeSessionId: "active-1" }),
		).rejects.toThrow("Worker retry is only available through the daemon supervisor");
	});

	it("records declared capabilities on the client and echoes them", async () => {
		const daemon = createDaemon();
		const client = createClient();

		const response = await daemon.handleCommand(client, {
			id: "caps-1",
			type: "declare_client_capabilities",
			capabilities: ["chunked_snapshot", "chunked_snapshot", "not-a-capability" as never],
		});

		expect(response).toMatchObject({
			id: "caps-1",
			command: "declare_client_capabilities",
			success: true,
			data: { declared: ["chunked_snapshot"] },
		});
		expect(client.declaredCapabilities).toBe(true);
		expect([...(client.declaredCommandCapabilities ?? [])]).toEqual(["chunked_snapshot"]);
	});

	it("hands admission ownership to the prompt handler and answers asynchronously", async () => {
		const write = vi.fn();
		const recordWorkerRecoveryState = vi.fn();
		const noteExternalSessionInput = vi.fn();
		const promptUntilAccepted = vi.fn(
			(_message: string, options: { preflightResult?: (didSucceed: boolean) => void }): Promise<void> => {
				options.preflightResult?.(true);
				return Promise.resolve();
			},
		);
		const state = {
			activeSessionId: "active-1",
			runtime: { session: { promptUntilAccepted } },
		};
		const daemon = createDaemon({
			promptAdmissions: new Map(),
			getBoundSessionState: vi.fn(() => state),
			noteExternalSessionInput,
			recordWorkerRecoveryState,
			write,
			broadcastToSession: vi.fn(),
		});
		const ownAdmission = vi.fn();

		const response = await daemon.handleCommand(
			createClient(),
			{ id: "prompt-1", type: "prompt", activeSessionId: "active-1", message: "hello" },
			ownAdmission,
		);

		expect(response).toBeUndefined();
		expect(ownAdmission).toHaveBeenCalledTimes(1);
		expect(noteExternalSessionInput).toHaveBeenCalledWith(state);
		expect(promptUntilAccepted).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(recordWorkerRecoveryState).toHaveBeenCalledWith(state, "prompt_accepted", true);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[1]).toMatchObject({ id: "prompt-1", command: "prompt", success: true });
	});

	it("writes a failure when the prompt preflight rejects", async () => {
		const write = vi.fn();
		const promptUntilAccepted = vi.fn(
			(_message: string, options: { preflightResult?: (didSucceed: boolean) => void }): Promise<void> => {
				options.preflightResult?.(false);
				return Promise.resolve();
			},
		);
		const state = {
			activeSessionId: "active-1",
			runtime: { session: { promptUntilAccepted } },
		};
		const daemon = createDaemon({
			promptAdmissions: new Map(),
			getBoundSessionState: vi.fn(() => state),
			noteExternalSessionInput: vi.fn(),
			recordWorkerRecoveryState: vi.fn(),
			write,
			broadcastToSession: vi.fn(),
		});

		const response = await daemon.handleCommand(
			createClient(),
			{ id: "prompt-2", type: "prompt", activeSessionId: "active-1", message: "hello" },
			() => {},
		);

		expect(response).toBeUndefined();
		await Promise.resolve();
		await Promise.resolve();
		expect(write).toHaveBeenCalledTimes(1);
		const written = write.mock.calls[0]?.[1] as { success: boolean; error?: string };
		expect(written.success).toBe(false);
		expect(written.error).toBe("Prompt was not accepted by the session.");
	});

	it("prompt_and_wait resolves with a success response after the turn completes", async () => {
		const promptAndWait = vi.fn(async () => undefined);
		const state = {
			activeSessionId: "active-1",
			runtime: { session: { promptAndWait } },
		};
		const daemon = createDaemon({
			promptAdmissions: new Map(),
			getBoundSessionState: vi.fn(() => state),
			noteExternalSessionInput: vi.fn(),
			recordWorkerRecoveryState: vi.fn(),
		});
		const ownAdmission = vi.fn();

		const response = await daemon.handleCommand(
			createClient(),
			{ id: "pw-1", type: "prompt_and_wait", activeSessionId: "active-1", message: "hello" },
			ownAdmission,
		);

		expect(response).toMatchObject({ id: "pw-1", command: "prompt_and_wait", success: true });
		expect(ownAdmission).toHaveBeenCalledTimes(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);
	});
});
