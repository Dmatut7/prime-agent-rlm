import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonAttachResult, DaemonClientCapability } from "../src/modes/daemon/daemon-protocol.js";
import { DAEMON_COMMAND_MAX_LINE_BYTES } from "../src/modes/daemon/daemon-protocol.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * #10. Every other read side in the daemon is bounded — the private frame
 * transport caps a header at 1MB and a payload at 1GB, worker stderr at 64KB — but
 * the jsonl command reader accumulated segments until a newline arrived. A
 * same-user process (including bash code injected from a web page or a repository)
 * could therefore hold one connection open and grow the supervisor's heap without
 * ever sending a parseable command, and the supervisor is a global single point
 * this repo deliberately keeps alive through every internal fault.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

describe("daemon command read bounds", () => {
	it("destroys a connection that never terminates a line and keeps serving everybody else", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-line-bound-" });
		await harness.waitForWorkerReady();

		const socket: Socket = createConnection(harness.socketPath);
		socket.on("error", () => {
			// Expected once the supervisor destroys the connection mid-write.
		});
		await once(socket, "connect");
		// `once` rejects when an 'error' event lands first, and EPIPE is expected here.
		const closed = once(socket, "close").catch(() => undefined);
		const chunk = Buffer.alloc(1024 * 1024, 0x78);
		const total = DAEMON_COMMAND_MAX_LINE_BYTES + chunk.length;
		for (let written = 0; written < total; written += chunk.length) {
			if (socket.destroyed) {
				break;
			}
			// A callback keeps the write error off the socket's 'error' channel: the
			// supervisor destroys this connection mid-stream, which is the point.
			const flushed = await new Promise<boolean>((resolveWrite) => {
				socket.write(chunk, (error) => resolveWrite(error === undefined || error === null));
			});
			if (!flushed) {
				break;
			}
		}
		await closed;
		socket.destroy();

		// The overflow is visible, and the single point survived it: an ordinary
		// client on the same supervisor still gets a full answer.
		expect(harness.logText()).toContain("a command line exceeded");
		const sessions = await harness.listSessions();
		expect(sessions.length).toBeGreaterThan(0);
	}, 90_000);

	it("drops capabilities this build does not know instead of keeping them resident", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-capability-filter-", sessionCount: 2 });
		await harness.waitForWorkerReady();
		const child = harness.sessions[1];
		if (!child) throw new Error("Harness did not create a child session");

		// The wire is untyped: a peer can declare any string it likes, which is the
		// whole reason the reader filters.
		const declared = [
			"attach_snapshot",
			"event_sequence",
			"x".repeat(4096),
			"not-a-capability",
		] as unknown as DaemonClientCapability[];
		const response = await harness.request({
			type: "attach",
			activeSessionId: child.activeSessionId,
			capabilities: declared,
			supportsExtensionUi: false,
		});
		if (!response.success) {
			throw new Error(`Fixture attach failed: ${response.error}`);
		}
		const echoed = (response.data as DaemonAttachResult).client?.capabilities ?? [];

		// The worker side already filtered against the supported set; the supervisor
		// echoed whatever arrived, so an attach could park arbitrary strings in the
		// supervisor for the lifetime of the session.
		expect(echoed).toContain("attach_snapshot");
		expect(echoed).not.toContain("not-a-capability");
		expect(echoed.every((capability) => capability.length < 64)).toBe(true);
	}, 60_000);
});
