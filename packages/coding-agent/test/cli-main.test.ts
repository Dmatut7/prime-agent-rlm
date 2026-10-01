import { describe, expect, it, vi } from "vitest";
import { DAEMON_SHUTDOWN_IN_PROGRESS_CLI_LINE, runMainWithDaemonShutdownRetry } from "../src/cli-main.js";

function shutdownAdmissionError(): Error {
	return new Error(
		"Prime Agent daemon exited during startup (code 1). Recent daemon log (/tmp/daemon.log):\n" +
			"DaemonShutdownAdmissionError: Daemon shutdown is in progress\n    at async main (chunk.js:1:1)",
	);
}

describe("runMainWithDaemonShutdownRetry", () => {
	it("passes a clean main() run through untouched", async () => {
		const main = vi.fn(async (_args: string[]) => undefined);
		const waitForClear = vi.fn(async () => true);
		await runMainWithDaemonShutdownRetry(main, ["--print", "hi"], { waitForClear });
		expect(main).toHaveBeenCalledTimes(1);
		expect(main).toHaveBeenCalledWith(["--print", "hi"]);
		expect(waitForClear).not.toHaveBeenCalled();
	});

	it("waits for the shutdown admission to clear, then retries main once", async () => {
		const main = vi
			.fn<(args: string[]) => Promise<void>>()
			.mockRejectedValueOnce(shutdownAdmissionError())
			.mockResolvedValueOnce(undefined);
		const waitForClear = vi.fn(async () => true);
		const report = vi.fn();
		const setExitCode = vi.fn();

		await runMainWithDaemonShutdownRetry(main, [], { waitForClear, report, setExitCode });

		expect(main).toHaveBeenCalledTimes(2);
		expect(waitForClear).toHaveBeenCalledTimes(1);
		expect(report).not.toHaveBeenCalled();
		expect(setExitCode).not.toHaveBeenCalled();
	});

	it("reports one clean line and no stack when the shutdown outlives the wait", async () => {
		const main = vi.fn<(args: string[]) => Promise<void>>().mockRejectedValue(shutdownAdmissionError());
		const waitForClear = vi.fn(async () => false);
		const report = vi.fn();
		const setExitCode = vi.fn();

		await runMainWithDaemonShutdownRetry(main, [], { waitForClear, report, setExitCode });

		expect(main).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledTimes(1);
		const line = report.mock.calls[0]?.[0] as string;
		expect(line).toBe(DAEMON_SHUTDOWN_IN_PROGRESS_CLI_LINE);
		expect(line).not.toContain("\n");
		expect(line).not.toContain(" at ");
		expect(setExitCode).toHaveBeenCalledWith(1);
	});

	it("reports one clean line when the retried main hits the same shutdown", async () => {
		const main = vi.fn<(args: string[]) => Promise<void>>().mockRejectedValue(shutdownAdmissionError());
		const waitForClear = vi.fn(async () => true);
		const report = vi.fn();
		const setExitCode = vi.fn();

		await runMainWithDaemonShutdownRetry(main, [], { waitForClear, report, setExitCode });

		expect(main).toHaveBeenCalledTimes(2);
		expect(report).toHaveBeenCalledTimes(1);
		expect(setExitCode).toHaveBeenCalledWith(1);
	});

	it("rethrows unrelated errors without waiting or reporting", async () => {
		const failure = new Error("provider quota exhausted");
		const main = vi.fn<(args: string[]) => Promise<void>>().mockRejectedValue(failure);
		const waitForClear = vi.fn(async () => true);
		const report = vi.fn();

		await expect(runMainWithDaemonShutdownRetry(main, [], { waitForClear, report })).rejects.toBe(failure);
		expect(waitForClear).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it("lets an unrelated error from the retried main propagate", async () => {
		const failure = new Error("second failure is different");
		const main = vi
			.fn<(args: string[]) => Promise<void>>()
			.mockRejectedValueOnce(shutdownAdmissionError())
			.mockRejectedValueOnce(failure);
		const waitForClear = vi.fn(async () => true);

		await expect(runMainWithDaemonShutdownRetry(main, [], { waitForClear })).rejects.toBe(failure);
	});
});
