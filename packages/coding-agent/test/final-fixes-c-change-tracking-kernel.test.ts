import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKernelPython } from "./kernel-python.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

// FIX-10 end to end: a switch written the way a person types it in settings.json
// ("false" in quotes) has to reach the session's kernel as off, not as the "1" a
// truthy string used to be folded into.
const python = await resolveKernelPython("import rlm.repl, rlm.effects, dill");

describe.skipIf(python === null)("changeTracking.enabled written as a string reaches the kernel (FIX-10)", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
	});

	async function trackingInKernel(settingsJson: string): Promise<string> {
		vi.stubEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);
		harness = await createHarness({ settings: JSON.parse(settingsJson) });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: "import rlm.effects as _e\nprint('tracking-on' if _e.enabled() else 'tracking-off')",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("tracking state printed"),
		]);
		await harness.session.prompt("check the kernel");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		return getMessageText(results[0]);
	}

	it.each([
		'{"changeTracking":{"enabled":"false"},"selfRecovery":{"finishGate":false}}',
		'{"changeTracking":{"enabled":"off"},"selfRecovery":{"finishGate":false}}',
		'{"changeTracking":{"enabled":0},"selfRecovery":{"finishGate":false}}',
	])(
		"turns tracking off in the kernel for %s",
		async (settingsJson) => {
			// finishGate:false because a live finish gate keeps the kernel tracker
			// installed regardless of the display setting (W8 3.2); these cases pin
			// the string coercion, so they disable the gate to observe it.
			expect(await trackingInKernel(settingsJson)).toContain("tracking-off");
		},
		120_000,
	);

	it('leaves tracking on for "yes"', async () => {
		expect(await trackingInKernel('{"changeTracking":{"enabled":"yes"}}')).toContain("tracking-on");
	}, 120_000);
});
