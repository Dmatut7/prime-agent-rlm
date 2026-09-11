import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { ExecuteResult, KernelClient } from "../src/core/kernel/index.js";
import {
	assembleIpythonToolResult,
	createIpythonToolDefinition,
	type IpythonKernelProvisioner,
} from "../src/core/tools/ipython.js";

const NOTICE = [
	"<ipython_kernel_reset>",
	"The Python kernel process died unexpectedly (code=9, signal=null, origin=unknown).",
	"Side effects were not rolled back.",
	"</ipython_kernel_reset>",
].join("\n");

function executeResult(overrides?: Partial<ExecuteResult>): ExecuteResult {
	return { stdout: "", stderr: "", status: "ok", durationMs: 5, ...overrides };
}

function fakeProvisioner(manager: Partial<KernelClient>): IpythonKernelProvisioner {
	return { ensure: vi.fn(async () => manager as KernelClient) } as unknown as IpythonKernelProvisioner;
}

describe("ipython reset notice (I-16)", () => {
	it("carries the notice in the tool result head and asks for it with the cell source", async () => {
		const consume = vi.fn(() => NOTICE);
		const tool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner({
				execute: vi.fn(async () => executeResult({ stdout: "2" })),
				consumeRestartNotice: consume,
			} as Partial<KernelClient>),
		});

		const result = await tool.execute("tool-call", { code: "1 + 1" }, undefined, undefined, {} as ExtensionContext);

		expect(consume).toHaveBeenCalledWith("1 + 1");
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text.startsWith("<ipython_kernel_reset>")).toBe(true);
		expect(text).toContain("2");
		expect(result.details.kernelReset).toBeDefined();
	});

	it("does not swallow the notice when the cell itself fails to run", async () => {
		const consume = vi.fn(() => NOTICE);
		const tool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner({
				execute: vi.fn(async () => {
					throw new Error("Python kernel exited unexpectedly (code=9)");
				}),
				consumeRestartNotice: consume,
			} as Partial<KernelClient>),
		});

		await expect(
			tool.execute("tool-call", { code: "1 + 1" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/exited unexpectedly/);
		// The notice stays pending for the next cell instead of being consumed by a throw.
		expect(consume).not.toHaveBeenCalled();
	});

	it("keeps the assembly pure: a notice is prepended, its absence changes nothing", () => {
		const withNotice = assembleIpythonToolResult(executeResult({ stdout: "ok" }), {
			kernelRestarted: false,
			resetNotice: NOTICE,
		});
		expect(withNotice.content[0]?.type).toBe("text");
		if (withNotice.content[0]?.type === "text") {
			expect(withNotice.content[0].text).toBe(`${NOTICE}\n\nok`);
		}

		const without = assembleIpythonToolResult(executeResult({ stdout: "ok" }), { kernelRestarted: false });
		expect(without.content).toEqual([{ type: "text", text: "ok" }]);
		expect(without.details.kernelReset).toBeUndefined();
	});
});
