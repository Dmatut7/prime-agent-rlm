import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DaemonWorkerClient,
	type DaemonWorkerDispatchStage,
	DaemonWorkerNotConnectedError,
} from "../src/modes/daemon/daemon-worker-client.js";
import { type FakeWorkerHandle, type FakeWorkerSession, startFakeWorker } from "./fixtures/supervisor-fake-worker.js";

/**
 * #7. A delivery receipt has to tell "the frame never reached the socket" apart
 * from "the frame went out and only the answer was lost": the first is a bounce
 * the sender may re-send, the second is uncertain and must not be. The client is
 * where that fact is knowable, so it reports the two stages to the caller and
 * fails a request whose transport was already gone with a typed error before a
 * byte is encoded.
 */

const tempDirs: string[] = [];
let worker: FakeWorkerHandle | undefined;

const session: FakeWorkerSession = {
	activeSessionId: "active-dispatch",
	sessionId: "session-dispatch",
	sessionFile: "/tmp/does-not-matter.jsonl",
	cwd: "/tmp",
	messageCount: 1,
};

afterEach(async () => {
	await worker?.close();
	worker = undefined;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function startWorker(): Promise<FakeWorkerHandle> {
	const directory = mkdtempSync(join(tmpdir(), "prime-worker-client-dispatch-"));
	tempDirs.push(directory);
	worker = await startFakeWorker({ socketPath: join(directory, "worker.sock"), session });
	return worker;
}

const deliverBody = {
	type: "worker_deliver_message",
	targetActiveSessionId: "active-dispatch",
	message: "hello",
	sender: {
		activeSessionId: "active-sender",
		sessionId: "session-sender",
		runtimeKind: "top-level",
		clientId: "client-dispatch",
	},
} as const;

describe("DaemonWorkerClient dispatch reporting", () => {
	it("reports queued then written for a request that reaches the socket", async () => {
		const handle = await startWorker();
		const client = new DaemonWorkerClient(handle.socketPath);
		await client.connect(5_000);
		await client.waitForHello(5_000);
		expect(client.isConnected).toBe(true);

		const stages: DaemonWorkerDispatchStage[] = [];
		const response = await client.requestWorker(deliverBody, 5_000, { onDispatch: (stage) => stages.push(stage) });

		expect(response.success).toBe(true);
		expect(stages).toEqual(["queued", "written"]);
		expect(handle.commands).toContain("worker_deliver_message");
		client.close();
	});

	it("fails a closed client with the typed not-connected error and reports no dispatch", async () => {
		const handle = await startWorker();
		const client = new DaemonWorkerClient(handle.socketPath);
		await client.connect(5_000);
		await client.waitForHello(5_000);
		client.close();
		expect(client.isConnected).toBe(false);

		const stages: DaemonWorkerDispatchStage[] = [];
		const failure = await client
			.requestWorker(deliverBody, 5_000, { onDispatch: (stage) => stages.push(stage) })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DaemonWorkerNotConnectedError);
		// Nothing was encoded, let alone written: the caller may re-send.
		expect(stages).toEqual([]);
		expect(handle.commands).not.toContain("worker_deliver_message");
	});

	it("fails a client that never connected the same way", async () => {
		const handle = await startWorker();
		const client = new DaemonWorkerClient(handle.socketPath);

		const stages: DaemonWorkerDispatchStage[] = [];
		const failure = await client
			.requestWorker(deliverBody, 1_000, { onDispatch: (stage) => stages.push(stage) })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DaemonWorkerNotConnectedError);
		expect((failure as Error).message).toBe("Daemon worker client is not connected");
		expect(stages).toEqual([]);
		client.close();
	});

	it("reports a queued write that never completes as dispatched but not written", async () => {
		const handle = await startWorker();
		const client = new DaemonWorkerClient(handle.socketPath);
		await client.connect(5_000);
		await client.waitForHello(5_000);
		handle.hangCommand("worker_deliver_message");

		const stages: DaemonWorkerDispatchStage[] = [];
		// The worker never answers, so the request times out after the frame was
		// written: dispatched (non-delivery is not provable) and written.
		const failure = await client
			.requestWorker(deliverBody, 200, { onDispatch: (stage) => stages.push(stage) })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(stages).toEqual(["queued", "written"]);
		client.close();
	});
});
