import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SHORT_TARGET_WAIT_MS,
	DEFAULT_TARGET_WAIT_MS,
	formatWaitTimeoutMessage,
	WaitTimeoutError,
	withBound,
} from "../src/utils/bounded-wait.js";

/** One deferred, so a test decides when (or whether) the awaited operation settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve;
		reject = innerReject;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("withBound", () => {
	it("passes a value through when the operation settles in time", async () => {
		const pending = withBound(Promise.resolve("settled"), { timeoutMs: 1_000, phase: "bind", target: "t" });
		await expect(pending).resolves.toBe("settled");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("passes the operation's own error through untouched", async () => {
		const failure = new Error("target refused");
		const pending = withBound(Promise.reject(failure), { timeoutMs: 1_000, phase: "bind", target: "t" });
		await expect(pending).rejects.toBe(failure);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects with a retryable timeout and leaves the operation running", async () => {
		const operation = deferred<string>();
		let completed = false;
		void operation.promise.then(() => {
			completed = true;
		});

		const pending = withBound(operation.promise, {
			timeoutMs: 120_000,
			phase: "passivation",
			target: "/tmp/session.jsonl",
			targetState: () => "passivating since 130000ms",
		});
		const rejected = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(120_000);
		const error = await rejected;

		expect(error).toBeInstanceOf(WaitTimeoutError);
		if (!(error instanceof WaitTimeoutError)) throw new Error("expected a WaitTimeoutError");
		expect(error.retryable).toBe(true);
		expect(error.phase).toBe("passivation");
		expect(error.target).toBe("/tmp/session.jsonl");
		expect(error.waitedMs).toBe(120_000);
		expect(error.message).toContain("wait timed out after 120000ms");
		expect(error.message).toContain("passivating since 130000ms");
		expect(error.message).toContain("Nothing was cancelled");

		// The bound does not cancel: the operation still settles later, and its late result is
		// handled rather than surfacing as an unhandled rejection.
		expect(completed).toBe(false);
		operation.resolve("late");
		await vi.advanceTimersByTimeAsync(0);
		expect(completed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports the phase and target the caller named, so a retry knows what to check", () => {
		const message = formatWaitTimeoutMessage({ phase: "hydrate", target: "child-7", waitedMs: 60_000 });
		expect(message).toContain("Target wait timed out after 60000ms");
		expect(message).toContain("phase: hydrate");
		expect(message).toContain("child-7");
		expect(message).toContain("write your result to a file and end the turn");
	});

	it("ends the wait on an abort signal without touching the operation", async () => {
		const operation = deferred<string>();
		const controller = new AbortController();
		const pending = withBound(operation.promise, {
			timeoutMs: 60_000,
			phase: "publication",
			target: "child",
			signal: controller.signal,
		});
		const rejected = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		controller.abort(new Error("cell aborted"));
		await expect(rejected).resolves.toEqual(new Error("cell aborted"));
		expect(vi.getTimerCount()).toBe(0);
		operation.resolve("late");
		await vi.advanceTimersByTimeAsync(0);
	});

	it("rejects at once for an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const operation = deferred<string>();
		await expect(
			withBound(operation.promise, { timeoutMs: 60_000, phase: "bind", target: "t", signal: controller.signal }),
		).rejects.toThrow();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaks no timer for a promise that was already settled", async () => {
		const settled = Promise.resolve("done");
		await expect(withBound(settled, { timeoutMs: 60_000, phase: "bind", target: "t" })).resolves.toBe("done");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disables the bound for a non-finite timeout, which is the rollback lever", async () => {
		const operation = deferred<string>();
		const pending = withBound(operation.promise, { timeoutMs: Number.POSITIVE_INFINITY, phase: "bind", target: "t" });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(vi.getTimerCount()).toBe(0);
		let state = "pending";
		void pending.then(
			() => {
				state = "resolved";
			},
			() => {
				state = "rejected";
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(state).toBe("pending");
		operation.resolve("late");
		await expect(pending).resolves.toBe("late");
	});

	it("ships the tiers the decision fixed, so a caller cannot invent its own", () => {
		expect(DEFAULT_TARGET_WAIT_MS).toBe(120_000);
		expect(DEFAULT_SHORT_TARGET_WAIT_MS).toBe(60_000);
	});

	it("calls onTimeout once with the facts a log line needs", async () => {
		const seen: unknown[] = [];
		const operation = deferred<string>();
		const pending = withBound(operation.promise, {
			timeoutMs: 500,
			phase: "passivation",
			target: "session-1",
			onTimeout: (facts) => seen.push(facts),
		});
		void pending.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(500);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ phase: "passivation", target: "session-1", waitedMs: 500 });
		operation.resolve("late");
		await vi.advanceTimersByTimeAsync(0);
	});
});
