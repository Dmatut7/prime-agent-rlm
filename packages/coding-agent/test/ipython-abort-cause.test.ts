import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { ExecuteResult, KernelClient } from "../src/core/kernel/index.js";
import {
	assembleIpythonToolResult,
	createIpythonToolDefinition,
	formatIpythonAbortCause,
	IPYTHON_ABORTED_CELL_NOTICE,
	type IpythonAbortCause,
	type IpythonKernelProvisioner,
} from "../src/core/tools/ipython.js";

function executeResult(overrides?: Partial<ExecuteResult>): ExecuteResult {
	return {
		stdout: "",
		stderr: "",
		status: "ok",
		durationMs: 12,
		...overrides,
	};
}

function fakeProvisioner(execute: KernelClient["execute"]): IpythonKernelProvisioner {
	const manager = { execute } as unknown as KernelClient;
	const ensure = vi.fn(async () => manager);
	const kill = vi.fn(async () => {});
	return { ensure, kill } as unknown as IpythonKernelProvisioner;
}

/** `execute()` is typed as `AgentToolResult`, which does not declare the error flag the tool sets. */
function isErrorFlag(result: unknown): boolean {
	return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
}

const abortedCell: ExecuteResult = executeResult({
	stdout: "step 1 done\nstep 2 running...",
	status: "aborted",
	durationMs: 900_000,
});

const stallCause: IpythonAbortCause = {
	silentMs: 900_000,
	reasons: ["stall_watchdog", "live_bash_handles"],
	kernelPid: 4242,
	at: 1_700_000_000_000,
};

describe("ipython aborted-cell evidence (T1-5)", () => {
	it("attaches the structured abort cause and the busy-kernel hint to an aborted cell", async () => {
		const execute = vi.fn<KernelClient["execute"]>().mockResolvedValue(abortedCell);
		const getAbortCause = vi.fn(() => stallCause);
		const tool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner(execute),
			getAbortCause,
		});

		const result = await tool.execute(
			"tool-call",
			{ code: "await bash('sleep 900')" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(getAbortCause).toHaveBeenCalledTimes(1);
		expect(isErrorFlag(result)).toBe(true);
		expect(result.details.status).toBe("aborted");
		expect(result.details.abortCause).toEqual(stallCause);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		// The partial output survives, and the model is told what happens next.
		expect(text).toContain("step 2 running...");
		expect(text).toContain(IPYTHON_ABORTED_CELL_NOTICE);
		expect(text).toContain("900s of session silence");
		expect(text).toContain("stall_watchdog, live_bash_handles");
		expect(text).toContain("kernel pid 4242");
	});

	it("does not consult the abort-cause provider for a cell that was not aborted", async () => {
		const execute = vi
			.fn<KernelClient["execute"]>()
			.mockResolvedValue(executeResult({ stdout: "all good", status: "ok" }));
		const getAbortCause = vi.fn(() => stallCause);
		const tool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner(execute),
			getAbortCause,
		});

		const result = await tool.execute("tool-call", { code: "1 + 1" }, undefined, undefined, {} as ExtensionContext);

		expect(getAbortCause).not.toHaveBeenCalled();
		expect(isErrorFlag(result)).toBe(false);
		expect(result.details.abortCause).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "all good" }]);
	});

	it("explains an aborted cell even when the host has no recorded cause", async () => {
		const execute = vi.fn<KernelClient["execute"]>().mockResolvedValue(abortedCell);
		const tool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner(execute),
			getAbortCause: () => undefined,
		});

		const result = await tool.execute("tool-call", { code: "x = 1" }, undefined, undefined, {} as ExtensionContext);

		expect(result.details.abortCause).toBeUndefined();
		expect(isErrorFlag(result)).toBe(true);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain(IPYTHON_ABORTED_CELL_NOTICE);
		expect(text).not.toContain("Abort cause:");
	});
});

describe("assembleIpythonToolResult (positive controls for the extracted assembly)", () => {
	it("keeps the ok/error/background-output/restart shapes unchanged", () => {
		expect(assembleIpythonToolResult(executeResult({ stdout: "ok" }), { kernelRestarted: false }).content).toEqual([
			{ type: "text", text: "ok" },
		]);
		expect(
			assembleIpythonToolResult(executeResult({ stdout: "ok", backgroundOutput: "bg-line" }), {
				kernelRestarted: false,
			}).content,
		).toEqual([{ type: "text", text: "ok\n[background output (unattributed)]\nbg-line" }]);

		const errored = assembleIpythonToolResult(
			executeResult({
				stdout: "before",
				status: "error",
				error: { ename: "ValueError", evalue: "bad", traceback: ["Traceback", "ValueError: bad"] },
			}),
			{ kernelRestarted: false },
		);
		expect(errored.isError).toBe(true);
		expect(errored.details.errorEname).toBe("ValueError");
		expect(errored.content).toEqual([{ type: "text", text: "before\nTraceback\nValueError: bad" }]);

		const restarted = assembleIpythonToolResult(executeResult({ stdout: "ok" }), { kernelRestarted: true });
		expect(restarted.content[0]?.type).toBe("text");
		if (restarted.content[0]?.type === "text") {
			expect(restarted.content[0].text.startsWith("<ipython_kernel_reset>")).toBe(true);
			expect(restarted.content[0].text.endsWith("ok")).toBe(true);
		}
		expect(restarted.details.kernelRestarted).toBe(true);
	});

	it("appends the abort notice after the partial output of an aborted cell", () => {
		const assembled = assembleIpythonToolResult(abortedCell, { kernelRestarted: false, abortCause: stallCause });
		expect(assembled.isError).toBe(true);
		expect(assembled.details.abortCause).toEqual(stallCause);
		expect(assembled.details.durationMs).toBe(900_000);
		const text = assembled.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text.indexOf("step 1 done")).toBeLessThan(text.indexOf("<ipython_cell_aborted>"));
	});

	it("formats the abort cause for the model", () => {
		expect(formatIpythonAbortCause(undefined)).toBeUndefined();
		expect(formatIpythonAbortCause({})).toBeUndefined();
		expect(formatIpythonAbortCause({ silentMs: 900_000 })).toBe(
			"Abort cause: the turn was aborted after 900s of session silence.",
		);
		expect(formatIpythonAbortCause({ reasons: ["loop_stalled"], kernelPid: 7 })).toBe(
			"Abort cause: reasons: loop_stalled; kernel pid 7.",
		);
		expect(formatIpythonAbortCause(stallCause)).toBe(
			"Abort cause: the turn was aborted after 900s of session silence; reasons: stall_watchdog, live_bash_handles; kernel pid 4242.",
		);
	});
});
