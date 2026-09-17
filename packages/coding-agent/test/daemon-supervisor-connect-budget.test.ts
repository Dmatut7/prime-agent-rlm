import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import {
	ADOPTION_WORKER_CONNECT_TIMEOUT_MS,
	DaemonSupervisor,
	RECOVERY_PROBE_CONNECT_TIMEOUT_MS,
} from "../src/modes/daemon/daemon-supervisor.js";
import * as childProcess from "../src/utils/child-process.js";

/**
 * #2036 meets F14: upstream raised every connect site to the full 30s/90s worker
 * connect budget; the fork keeps tight budgets on the adoption/recovery lanes so a
 * wedged worker parks failed fast instead of holding startup (or a stop) hostage.
 * These pins assert which budget each lane actually passes.
 */

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("daemon supervisor connect budgets", () => {
	it("adopts with the adoption connect budget and the injected subscribe budget", async () => {
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockReturnValue("start-id");
		const worker = {
			descriptor: { pid: 123, processStartId: "start-id", rootActiveSessionId: "root", lifecycle: "recovering" },
		};
		const connectWorker = vi.fn(async () => undefined);
		const subscribeWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: async () => {},
			connectWorker,
			subscribeWorker,
			refreshWorkerSummaries: async () => {},
			tryPersistWorker: () => true,
			broadcastHeartbeatsChanged: () => {},
			adoptionRequestTimeoutMs: 12_345,
		}) as { adoptOrRecoverWorker(candidate: typeof worker): Promise<void> };
		await supervisor.adoptOrRecoverWorker(worker);
		expect(connectWorker).toHaveBeenCalledWith(worker, ADOPTION_WORKER_CONNECT_TIMEOUT_MS);
		// The fork's tight POSIX value; the win32 branch is pinned by
		// daemon-supervisor-connect-budget-windows.test.ts.
		expect(ADOPTION_WORKER_CONNECT_TIMEOUT_MS).toBe(process.platform === "win32" ? 90_000 : 2_000);
		expect(subscribeWorker).toHaveBeenCalledWith(worker, "root", 12_345);
		expect(worker.descriptor.lifecycle).toBe("ready");
	});

	it("probes a recovering worker with the recovery connect budget, not the adoption one", async () => {
		vi.useFakeTimers();
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockReturnValue("start-id");
		const worker = {
			descriptor: { pid: 123, processStartId: "start-id", rootActiveSessionId: "root", lifecycle: "recovering" },
			recovery: undefined,
		};
		const connectWorker = vi.fn(async () => undefined);
		const subscribeWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			isWorkerRecoveryCancelled: () => false,
			assertRecoveryAllowed: async () => {},
			processIdentity: () => "current",
			connectWorker,
			subscribeWorker,
			refreshWorkerSummaries: async () => {},
			tryPersistWorker: () => true,
			broadcastHeartbeatsChanged: () => {},
			adoptionRequestTimeoutMs: 54_321,
			log: () => {},
		}) as { recoverWorker(candidate: typeof worker): Promise<void> };
		const done = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await done;
		expect(connectWorker).toHaveBeenCalledWith(worker, RECOVERY_PROBE_CONNECT_TIMEOUT_MS);
		expect(RECOVERY_PROBE_CONNECT_TIMEOUT_MS).toBe(process.platform === "win32" ? 10_000 : 1_500);
		expect(subscribeWorker).toHaveBeenCalledWith(worker, "root", 54_321);
		expect(worker.descriptor.lifecycle).toBe("ready");
	});
});
