import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_VERSION,
	type DaemonCommand,
} from "../src/modes/daemon/daemon-protocol.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * P1-7a server half: a transient worker state must reach the wire as
 * `retryAfterMs` on the failure response, because that field is the only thing
 * that tells a client how long "not now" lasts. Read over a raw socket on
 * purpose — a DaemonClient would honour the hint and retry, hiding the field.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

interface RawResponse {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	error?: string;
	retryAfterMs?: number;
}

function rawRequest(
	socketPath: string,
	command: DaemonCommand & { id: string },
	timeoutMs = 20_000,
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let helloSeen = false;
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out waiting for the raw response to ${command.type}`));
		}, timeoutMs);
		const finish = (error: Error | undefined, response?: RawResponse) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(response!);
		};
		socket.on("error", (error) => finish(error));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as RawResponse & { type?: string };
				if (!helloSeen) {
					helloSeen = message.type === "daemon_hello";
					if (helloSeen) {
						const envelope = createDaemonCommandEnvelope(
							command,
							command.id,
							"raw-probe-client",
							DAEMON_PROTOCOL_VERSION,
						);
						socket.write(`${JSON.stringify(envelope)}\n`);
					}
					continue;
				}
				if (message.type === "response" && message.id === command.id) {
					finish(undefined, message);
					return;
				}
			}
		});
	});
}

async function recoveringHarness(prefix: string): Promise<SupervisorHarness> {
	const harness = await startSupervisorHarness({ prefix });
	await harness.waitForWorkerReady();
	// The worker drops off the socket, so the supervisor flips it to recovering:
	// the state a forwarded command bounces off before it reaches anything.
	await harness.worker?.close();
	await harness.waitForDescriptorLifecycle("recovering");
	return harness;
}

describe("P1-7a retryAfterMs on the wire", () => {
	it("reports the recovery recheck interval when a command is deferred", async () => {
		const harness = await recoveringHarness("ma-t4-1-hint-recovering-");

		const response = await rawRequest(harness.socketPath, {
			id: "raw-recovering",
			type: "get_state",
			activeSessionId: harness.session.activeSessionId,
		});

		// RED on HEAD: the failure carried no retryAfterMs, so a client could only fail.
		expect(response).toMatchObject({
			success: false,
			error: "Session worker is recovering",
			retryAfterMs: 5_000,
		});
	});

	it("leaves a terminal lookup failure without a hint", async () => {
		const harness = await recoveringHarness("ma-t4-1-hint-terminal-");

		const response = await rawRequest(harness.socketPath, {
			id: "raw-unknown",
			type: "get_state",
			activeSessionId: "no-such-session",
		});

		expect(response.success).toBe(false);
		expect(response.error).toContain("Unknown active session");
		// Positive control: the hint is state-specific, not a blanket field on failures.
		expect(response).not.toHaveProperty("retryAfterMs");
	});
});
