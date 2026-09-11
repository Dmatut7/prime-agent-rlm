import { afterEach, describe, expect, it, vi } from "vitest";
import { installSupervisorCrashHandlers } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * T3-4 / P1-5-L6 unit half: the supervisor's process-level policy. An uncaught
 * exception means the process state cannot be trusted, so it is logged and the
 * process exits. An unhandled rejection is isolated instead — the supervisor is a
 * global single point, and one leaked promise must not take every session with it —
 * but it is counted over a sliding window and the count can be turned into an exit
 * by a settings threshold that ships disabled (C18).
 *
 * The subprocess half (real exit codes, and a supervisor that survives a read-only
 * descriptor directory) lives in daemon-supervisor-crash-handlers-process.test.ts.
 */

const uninstalls: Array<() => void> = [];

afterEach(() => {
	while (uninstalls.length > 0) {
		uninstalls.pop()?.();
	}
	vi.restoreAllMocks();
});

function emitRejection(reason: unknown): void {
	process.emit("unhandledRejection", reason, Promise.resolve());
}

function emitUncaught(error: Error): void {
	process.emit("uncaughtException", error);
}

describe("T3-4 supervisor crash handler policy", () => {
	it("isolates an unhandled rejection and counts it in the window", () => {
		const logged: string[] = [];
		const recorded: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installSupervisorCrashHandlers({
				log: (message) => logged.push(message),
				recordRejection: (detail) => recorded.push(detail),
				rejectionWindowMs: 60_000,
				exit,
			}),
		);

		emitRejection(new Error("leaked promise"));
		expect(exit).not.toHaveBeenCalled();
		expect(recorded).toHaveLength(1);
		expect(logged.join("\n")).toContain("supervisor unhandled rejection");
		expect(logged.join("\n")).toContain("count in the last 60000ms: 1");
		expect(logged.join("\n")).toContain("leaked promise");
	});

	it("keeps a rejection storm to a bounded number of log lines", () => {
		const logged: string[] = [];
		uninstalls.push(
			installSupervisorCrashHandlers({
				log: (message) => logged.push(message),
				rejectionLogThrottleMs: 60_000,
				exit: vi.fn(),
			}),
		);
		for (let index = 0; index < 25; index++) {
			emitRejection(new Error(`storm ${index}`));
		}
		const rejectionLines = logged.filter((line) => line.includes("supervisor unhandled rejection"));
		expect(rejectionLines).toHaveLength(1);
		expect(logged.filter((line) => line.includes("storm 24"))).toHaveLength(0);
	});

	it("counts the suppressed rejections into the next line", async () => {
		const logged: string[] = [];
		uninstalls.push(
			installSupervisorCrashHandlers({
				log: (message) => logged.push(message),
				rejectionLogThrottleMs: 5,
				exit: vi.fn(),
			}),
		);
		emitRejection(new Error("first"));
		emitRejection(new Error("suppressed one"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		emitRejection(new Error("third"));
		const lines = logged.filter((line) => line.includes("supervisor unhandled rejection"));
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("1 suppressed since the last line");
		expect(lines[1]).toContain("count in the last");
	});

	it("exits on an uncaught exception because the process state is untrustworthy", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(installSupervisorCrashHandlers({ log: (message) => logged.push(message), exit }));
		emitUncaught(new Error("fatal supervisor bug"));
		expect(exit).toHaveBeenCalledWith(1);
		expect(logged.join("\n")).toContain("supervisor uncaught exception");
		expect(logged.join("\n")).toContain("fatal supervisor bug");
	});

	it("exits on rejections only when the threshold is enabled and reached", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		uninstalls.push(
			installSupervisorCrashHandlers({
				log: (message) => logged.push(message),
				rejectionExitThreshold: 3,
				rejectionWindowMs: 60_000,
				rejectionLogThrottleMs: 0,
				exit,
			}),
		);
		emitRejection(new Error("one"));
		emitRejection(new Error("two"));
		expect(exit).not.toHaveBeenCalled();
		emitRejection(new Error("three"));
		expect(exit).toHaveBeenCalledWith(1);
		expect(logged.join("\n")).toContain("threshold 3");
	});

	it("drops rejections that age out of the window", () => {
		const exit = vi.fn();
		const logged: string[] = [];
		uninstalls.push(
			installSupervisorCrashHandlers({
				log: (message) => logged.push(message),
				rejectionExitThreshold: 2,
				rejectionWindowMs: 1,
				rejectionLogThrottleMs: 0,
				exit,
			}),
		);
		emitRejection(new Error("early"));
		// The window is 1ms, so a later rejection is the only one still counted.
		const wait = new Promise<void>((resolve) => setTimeout(resolve, 10));
		return wait.then(() => {
			emitRejection(new Error("late"));
			expect(exit).not.toHaveBeenCalled();
			expect(logged.join("\n")).toContain("count in the last 1ms: 1");
		});
	});

	it("stops handling once uninstalled", () => {
		const logged: string[] = [];
		const exit = vi.fn();
		const uninstall = installSupervisorCrashHandlers({ log: (message) => logged.push(message), exit });
		uninstall();
		// Something has to consume the event, or Node treats it as a real crash; the
		// consumer also proves the event was delivered and simply not to our handler.
		const consumed: unknown[] = [];
		const consumer = (reason: unknown): void => {
			consumed.push(reason);
		};
		process.on("unhandledRejection", consumer);
		try {
			emitRejection(new Error("after uninstall"));
		} finally {
			process.off("unhandledRejection", consumer);
		}
		expect(consumed).toHaveLength(1);
		expect(logged).toHaveLength(0);
		expect(exit).not.toHaveBeenCalled();
	});
});
