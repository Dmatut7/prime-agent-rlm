import { afterEach, describe, expect, it, vi } from "vitest";

// Load the platform-derived constants as Windows sees them without running Windows
// processes on the test host (same vi.hoisted shape as daemon-worker-windows-timeouts).
const hostPlatform = vi.hoisted(() => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	return descriptor;
});
Object.defineProperty(process, "platform", hostPlatform);

import {
	ADOPTION_WORKER_CONNECT_TIMEOUT_MS,
	RECOVERY_PROBE_CONNECT_TIMEOUT_MS,
} from "../src/modes/daemon/daemon-supervisor.js";

afterEach(() => {
	Object.defineProperty(process, "platform", hostPlatform);
});

describe("daemon supervisor connect budgets (win32)", () => {
	it("gives the adoption lane the full Windows connect budget", () => {
		// Windows antivirus can stall a named-pipe connect past 30s (#2036); a fast-fail
		// on the adoption lane would just burn the whole backoff ladder.
		expect(ADOPTION_WORKER_CONNECT_TIMEOUT_MS).toBe(90_000);
	});

	it("gives recovery probes 10s on Windows — room for antivirus without burning the ladder", () => {
		expect(RECOVERY_PROBE_CONNECT_TIMEOUT_MS).toBe(10_000);
	});
});
