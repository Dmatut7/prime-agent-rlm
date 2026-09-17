import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * Block-7 union (案A): a descriptor-known but unhydrated root reports a *typed*
 * recovering error (clients deserialize code "session_recovering" and retry), while
 * the adoption-window fallback keeps the fork's string contract verbatim
 * ("Session worker is recovering" — daemon-client-transient-retry pins its budget).
 */

type FakeWorker = {
	descriptor: {
		workerId: string;
		rootActiveSessionId: string;
		rootSessionId?: string;
		sessionFile?: string;
		lifecycle: string;
		stopRequestedAt?: string;
	};
	intentionalStop: boolean;
	client: undefined;
	summaries: Map<string, unknown>;
};

function fakeWorker(workerId: string, rootActiveSessionId: string): FakeWorker {
	return {
		descriptor: { workerId, rootActiveSessionId, lifecycle: "recovering" },
		intentionalStop: false,
		client: undefined,
		summaries: new Map(),
	};
}

function supervisorWith(workers: FakeWorker[], adoptionPendingCount = 0) {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map(workers.map((worker) => [worker.descriptor.workerId, worker])),
		shuttingDown: false,
		adoptionPendingCount,
		matchWorkers: () => [],
		refreshWorkerSummaries: vi.fn(async () => {}),
		// The roster is exercised elsewhere; here the claim check is the unit under test.
		findSummaryInWorker: (_worker: unknown, selector: string) => selector === "child-active-1",
	}) as {
		findWorker(selector: string): Promise<unknown>;
	};
}

describe("daemon supervisor recovering contract", () => {
	it("answers a descriptor-known unhydrated root with the typed recovering error", async () => {
		const supervisor = supervisorWith([fakeWorker("w1", "active-gap")]);
		await expect(supervisor.findWorker("active-gap")).rejects.toMatchObject({
			name: "DaemonSessionRecoveringError",
			code: "session_recovering",
			activeSessionId: "active-gap",
		});
	});

	it("follows roster addressing: an unambiguous hex suffix of a recovering root is recovering", async () => {
		const supervisor = supervisorWith([fakeWorker("w1", "00ff77aa11bb22cc")]);
		await expect(supervisor.findWorker("77aa11bb22cc")).rejects.toMatchObject({
			code: "session_recovering",
			activeSessionId: "00ff77aa11bb22cc",
		});
	});

	it("keeps a failed worker terminal so clients take the create fallback", async () => {
		const worker = fakeWorker("w1", "active-gap");
		worker.descriptor.lifecycle = "failed";
		const supervisor = supervisorWith([worker]);
		await expect(supervisor.findWorker("active-gap")).rejects.toThrow("Unknown active session: active-gap");
	});

	it("keeps the fork's string contract for the adoption window (child selector claimed via summaries)", async () => {
		const worker = fakeWorker("w1", "active-root");
		// The selector is a child session: no descriptor root matches it, so the typed
		// path cannot fire; the coarse adoption-window check claims it via summaries.
		const supervisor = supervisorWith([worker], 1);
		await expect(supervisor.findWorker("child-active-1")).rejects.toThrow(/^Session worker is recovering$/);
	});

	it("answers unknown outside the adoption window (terminal, not recovering)", async () => {
		const worker = fakeWorker("w1", "active-root");
		const supervisor = supervisorWith([worker], 0);
		await expect(supervisor.findWorker("child-active-1")).rejects.toThrow("Unknown active session: child-active-1");
		// Positive control: a matching worker resolves instead of throwing.
		const supervisor2 = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map(),
			shuttingDown: false,
			adoptionPendingCount: 0,
			matchWorkers: () => [{ descriptor: { rootActiveSessionId: "active-root" } }],
			refreshWorkerSummaries: vi.fn(async () => {}),
		}) as { findWorker(selector: string): Promise<unknown> };
		await expect(supervisor2.findWorker("active-root")).resolves.toMatchObject({
			descriptor: { rootActiveSessionId: "active-root" },
		});
	});
});
