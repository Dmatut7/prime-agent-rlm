import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import { DAEMON_PROTOCOL_INFO } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";
import { DAEMON_WORKER_ROSTER_CAPABILITY } from "../src/modes/daemon/daemon-worker-protocol.js";
import * as childProcess from "../src/utils/child-process.js";

// Load the Windows timing constants without running Windows processes on the test host.
const hostPlatform = vi.hoisted(() => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	return descriptor;
});
Object.defineProperty(process, "platform", hostPlatform);

const hello = {
	type: "daemon_hello" as const,
	socketPath: "unused-test-socket",
	protocol: DAEMON_PROTOCOL_INFO,
	clientId: "test-client",
	serverCapabilities: [],
};

function createProbe() {
	const worker = {
		descriptor: { socketPath: hello.socketPath, authenticationToken: "test-token" },
		pendingClient: undefined,
	};
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		assertRecoveryAllowed: async () => {},
		supervisorAuthenticationClaim: () => ({}),
	}) as { connectWorker(candidate: typeof worker, timeout: number): Promise<DaemonWorkerClient> };
	return { worker, connect: (timeout = 100) => supervisor.connectWorker(worker, timeout) };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Object.defineProperty(process, "platform", hostPlatform);
});

describe("Windows worker connection timing", () => {
	it("gives hello and authentication the remaining budget, not fixed short probe caps", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const connect = vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += 1500;
		});
		const waitForHello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockImplementation(async () => {
			now += 20_000;
			return hello;
		});
		const authenticate = vi.spyOn(DaemonWorkerClient.prototype, "authenticateWorker").mockImplementation(async () => {
			now += 20_000;
			return {
				type: "response" as const,
				command: "worker_auth",
				success: true as const,
				data: { capabilities: [DAEMON_WORKER_ROSTER_CAPABILITY] },
			};
		});
		const probe = createProbe();
		const client = await probe.connect(90_000);
		expect(connect).toHaveBeenCalledWith(2000);
		expect(waitForHello).toHaveBeenCalledWith(88_500);
		expect(authenticate.mock.calls[0]?.[2]).toBe(68_500);
		expect(probe.worker.pendingClient).toBeUndefined();
		client.close();
	});

	it("backs off failed pipe probes up to two seconds without exceeding the outer deadline", async () => {
		vi.useFakeTimers();
		const started = Date.now();
		const attempts: number[] = [];
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			attempts.push(Date.now() - started);
			throw new Error("pipe not ready");
		});
		const failed = expect(createProbe().connect(7200)).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(7200);
		await failed;
		expect(attempts).toEqual([0, 25, 75, 175, 375, 775, 1575, 3175, 5175, 7175]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the 90-second budget when adopting a resident worker", async () => {
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockReturnValue("start-id");
		const worker = {
			descriptor: { pid: 123, processStartId: "start-id", rootActiveSessionId: "root", lifecycle: "recovering" },
		};
		const connectWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: async () => {},
			connectWorker,
			subscribeWorker: async () => {},
			refreshWorkerSummaries: async () => {},
			persistWorker: () => {},
			// The fork persists adoption bookkeeping through a counted, non-throwing wrapper.
			tryPersistWorker: () => true,
			broadcastHeartbeatsChanged: () => {},
		}) as { adoptOrRecoverWorker(candidate: typeof worker): Promise<void> };
		await supervisor.adoptOrRecoverWorker(worker);
		expect(connectWorker).toHaveBeenCalledWith(worker, 90_000);
		expect(worker.descriptor.lifecycle).toBe("ready");
	});

	// Dropped upstream case "throttles Windows identity checks but rechecks before
	// signalling": it pins upstream's sync getProcessStartId throttle cadence, but the
	// fork's finalizer probes identity via getProcessStartIdAsync with a 5s wedged-helper
	// bound (I-7) — a deliberately different shape, covered by daemon-supervisor-process.
});

// Dropped upstream describe "daemon request timeouts": it pins upstream's
// defaultDaemonRequestTimeout (win32 create = 120s), which lives in daemon-client.ts —
// a face this merge window did not take (the fork's client carries the P1-7a typed-timeout
// subsystem instead). Tracked as a deferred companion for the daemon-client face.

describe("daemon worker connection deadline", () => {
	it.each(["hello", "authentication"])("bounds %s by time remaining after earlier stages", async (stage) => {
		let now = Date.now();
		const started = now;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += 75;
		});
		const waitForHello = vi
			.spyOn(DaemonWorkerClient.prototype, "waitForHello")
			.mockImplementation(async (timeout = 0) => {
				if (stage === "hello") {
					now += timeout;
					throw new DaemonWorkerProbeTimeoutError("hello timed out");
				}
				now += 5;
				return hello;
			});
		const authenticate = vi
			.spyOn(DaemonWorkerClient.prototype, "authenticateWorker")
			.mockImplementation(async (_token, _owner, timeout = 0) => {
				now += timeout;
				throw new DaemonWorkerProbeTimeoutError("authentication timed out");
			});
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close");
		const probe = createProbe();
		await expect(probe.connect()).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(now - started).toBe(100);
		expect(waitForHello).toHaveBeenCalledWith(25);
		if (stage === "authentication") expect(authenticate.mock.calls[0]?.[2]).toBe(20);
		else expect(authenticate).not.toHaveBeenCalled();
		expect(probe.worker.pendingClient).toBeUndefined();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(["connect", "hello"])("does not start another stage after %s exhausts the budget", async (stage) => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += stage === "connect" ? 100 : 75;
		});
		const waitForHello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockImplementation(async () => {
			now += 25;
			return hello;
		});
		const authenticate = vi
			.spyOn(DaemonWorkerClient.prototype, "authenticateWorker")
			.mockRejectedValue(new Error("unexpected authentication"));
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close");
		await expect(createProbe().connect()).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		if (stage === "connect") expect(waitForHello).not.toHaveBeenCalled();
		expect(authenticate).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
