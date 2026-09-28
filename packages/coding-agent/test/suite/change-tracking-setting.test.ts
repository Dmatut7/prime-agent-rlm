import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKernelPython } from "../kernel-python.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

// The session's own ipython tool and kernel (no tool override), so the setting travels the same path
// it does in the product: settings -> the session's kernel environment -> the runtime.
const python = await resolveKernelPython("import rlm.repl, rlm.effects, dill");

describe.skipIf(python === null)("changeTracking.enabled reaches the session's kernel", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
	});

	async function trackingInKernel(enabled: boolean | undefined): Promise<string> {
		vi.stubEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);
		harness = await createHarness(enabled === undefined ? {} : { settings: { changeTracking: { enabled } } });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: "import rlm.effects as _e\nprint('tracking-on' if _e.enabled() else 'tracking-off')",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("check the kernel");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		return getMessageText(results[0]);
	}

	it("turns tracking off in the kernel when the setting is false", async () => {
		expect(await trackingInKernel(false)).toContain("tracking-off");
	}, 120_000);

	it("leaves tracking on by default", async () => {
		expect(await trackingInKernel(undefined)).toContain("tracking-on");
	}, 120_000);
});
