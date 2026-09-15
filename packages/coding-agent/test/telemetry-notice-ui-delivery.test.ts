import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionServices,
	markTelemetryNoticeShown,
	TELEMETRY_NOTICE_MESSAGE,
} from "../src/core/agent-session-services.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * TEL-4: the one-time telemetry disclosure had exactly one delivery path (a
 * stderr line) and one global one-shot flag that every process creating session
 * services spent - including daemon workers and `--print` runs a human never
 * looks at. The interactive user therefore saw nothing. The flag is now spent
 * only by a caller that really puts the notice in front of the user.
 */
describe("telemetry disclosure delivery", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (unregisters.length > 0) unregisters.pop()?.();
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	async function makeServices(options: { settingsManager?: SettingsManager } = {}) {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-telemetry-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());
		const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		return { services, settingsManager };
	}

	it("offers the notice without spending the one-time flag", async () => {
		const { services, settingsManager } = await makeServices();

		expect(services.telemetryNotice).toBe(TELEMETRY_NOTICE_MESSAGE);
		// Still printable for print/RPC/daemon clients...
		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ type: "info", message: TELEMETRY_NOTICE_MESSAGE }),
		);
		// ...but a process that only prints it must not consume the disclosure the
		// interactive user is owed.
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);
	});

	it("survives a worker or --print run so the next interactive start still shows it", async () => {
		const settingsManager = SettingsManager.inMemory();
		const first = await makeServices({ settingsManager });
		expect(first.services.telemetryNotice).toBeDefined();

		// The same agent dir, a later interactive start: the notice is still owed.
		const second = await makeServices({ settingsManager });
		expect(second.services.telemetryNotice).toBe(TELEMETRY_NOTICE_MESSAGE);

		markTelemetryNoticeShown(settingsManager);
		const third = await makeServices({ settingsManager });
		expect(third.services.telemetryNotice).toBeUndefined();
	});
});
