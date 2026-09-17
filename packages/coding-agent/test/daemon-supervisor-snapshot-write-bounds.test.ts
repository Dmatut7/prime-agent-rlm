import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * Blocks 11-13 union: a snapshot write that the socket did not accept waits on TWO
 * independent bounds — the fork's drain timeout (terminal frames only) and #2260's
 * per-transfer AbortSignal. Either ends the wait exactly once, with no leaked timer
 * and no leaked abort listener. Data chunks stay unbounded (backpressure is real).
 */

type FakeSocket = EventEmitter & { destroyed: boolean };

function fakeSocket(): FakeSocket {
	return Object.assign(new EventEmitter(), { destroyed: false });
}

function supervisorWithDeadSocket() {
	const socket = fakeSocket();
	const client = { id: "client-1", socket };
	// writeSerialized reports backpressure: the frame never leaves the kernel buffer.
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		writeSerialized: () => false,
	}) as {
		writeSnapshotBuffer(
			client: unknown,
			buffer: Uint8Array,
			signal?: AbortSignal,
			drainTimeoutMs?: number,
		): Promise<boolean>;
	};
	return { supervisor, client, socket };
}

async function nextMacroTaskTurn(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("daemon supervisor snapshot write bounds", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("settles true when the socket drains", async () => {
		const { supervisor, client, socket } = supervisorWithDeadSocket();
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("x"), undefined, 60_000);
		socket.emit("drain");
		await expect(pending).resolves.toBe(true);
	});

	it("stays pending while neither bound fires (positive control)", async () => {
		const { supervisor, client } = supervisorWithDeadSocket();
		let settled = false;
		void supervisor.writeSnapshotBuffer(client, Buffer.from("x")).then(() => {
			settled = true;
		});
		await nextMacroTaskTurn();
		await nextMacroTaskTurn();
		expect(settled).toBe(false);
	});

	it("drain timeout settles false and clears the timer", async () => {
		vi.useFakeTimers();
		const { supervisor, client, socket } = supervisorWithDeadSocket();
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("x"), undefined, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(0);
		expect(socket.listenerCount("error")).toBe(0);
	});

	it("an abort settles false at once and clears the drain timer", async () => {
		vi.useFakeTimers();
		const { supervisor, client, socket } = supervisorWithDeadSocket();
		const controller = new AbortController();
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("x"), controller.signal, 60_000);
		controller.abort(new Error("superseded"));
		await expect(pending).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
	});

	it("both bounds armed: whichever fires first settles exactly once", async () => {
		vi.useFakeTimers();
		const { supervisor, client } = supervisorWithDeadSocket();
		const controller = new AbortController();
		let settles = 0;
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("x"), controller.signal, 1_000);
		void pending.then(() => {
			settles++;
		});
		// Timeout first, then a late abort: the promise settles once and the abort
		// listener is already detached (a leak would keep the signal referencing it).
		await vi.advanceTimersByTimeAsync(1_000);
		controller.abort(new Error("late"));
		await vi.advanceTimersByTimeAsync(0);
		expect(settles).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		await expect(pending).resolves.toBe(false);
	});

	it("both bounds armed: an early abort also settles exactly once", async () => {
		vi.useFakeTimers();
		const { supervisor, client } = supervisorWithDeadSocket();
		const controller = new AbortController();
		let settles = 0;
		const pending = supervisor.writeSnapshotBuffer(client, Buffer.from("x"), controller.signal, 60_000);
		void pending.then(() => {
			settles++;
		});
		controller.abort(new Error("superseded"));
		await vi.advanceTimersByTimeAsync(120_000);
		expect(settles).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		await expect(pending).resolves.toBe(false);
	});

	it("an already-aborted signal short-circuits before any wait", async () => {
		const { supervisor, client } = supervisorWithDeadSocket();
		const controller = new AbortController();
		controller.abort(new Error("superseded"));
		await expect(supervisor.writeSnapshotBuffer(client, Buffer.from("x"), controller.signal, 1_000)).resolves.toBe(
			false,
		);
	});
});
