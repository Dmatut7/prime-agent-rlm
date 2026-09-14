/**
 * H-2: a settings write that fails is recorded, never thrown, and the interactive UI used to print
 * a green "saved" regardless. `persistenceFailure()` is the channel that lets a call site tell the
 * truth: it waits for the queued writes and returns the reason nothing landed, so the copy can say
 * "not saved" with the reason instead. Both failure shapes are driven against real disk state.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

const scratchDirs: string[] = [];
/** A filesystem an unprivileged process cannot write into; root ignores the mode, so no assertion. */
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(() => {
	while (scratchDirs.length > 0) {
		const dir = scratchDirs.pop();
		if (!dir) continue;
		// Restore the mode first so the cleanup can remove an unwritable agentDir.
		chmodSync(join(dir, "agent"), 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
});

function workspace(settingsContent?: string): { cwd: string; agentDir: string; settingsPath: string } {
	const root = mkdtempSync(join(tmpdir(), "settings-persistence-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	if (settingsContent !== undefined) writeFileSync(settingsPath, settingsContent);
	scratchDirs.push(root);
	return { cwd, agentDir, settingsPath };
}

describe("SettingsManager persistence failure reporting", () => {
	it("names the unparseable file when every write this session was skipped", async () => {
		const { cwd, agentDir, settingsPath } = workspace('{ "theme": "dark", oops }\n');
		const manager = SettingsManager.create(cwd, agentDir);
		// The startup load error is drained once by main.ts before the session starts.
		expect(manager.drainErrors("global")).toHaveLength(1);
		const before = readFileSync(settingsPath, "utf-8");

		manager.setEnabledModels(["bailian/kimi-k3"]);
		const failure = await manager.persistenceFailure();

		expect(failure).toBeDefined();
		expect(failure).toContain("Global settings not saved");
		expect(failure).toContain("failed to parse");
		// The claim "Model selection saved to settings" would be false: nothing reached the file.
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		expect(before).toContain("oops");
	});

	it.skipIf(runningAsRoot)("returns the write error when the settings directory is not writable", async () => {
		// No settings.json yet, so the startup load succeeds (reading an absent file needs no lock)
		// and the first failure is the write itself - the shape probe B2 observed.
		const { cwd, agentDir, settingsPath } = workspace();
		chmodSync(agentDir, 0o555);
		const manager = SettingsManager.create(cwd, agentDir);
		expect(await manager.persistenceFailure()).toBeUndefined();

		manager.setAgentTracesEnabled(false);
		const failure = await manager.persistenceFailure();

		expect(failure).toBeDefined();
		expect(failure).toContain("EACCES");
		// Nothing landed, so "Trace sharing disabled." would have been a green lie.
		expect(existsSync(settingsPath)).toBe(false);
	});

	it.skipIf(runningAsRoot)(
		"reports the load failure that also blocks every write in an unwritable directory",
		async () => {
			// Locking an existing settings file needs a sibling .lock directory, so an agentDir nobody can
			// write into surfaces as a load error before it ever reaches a write.
			const { cwd, agentDir, settingsPath } = workspace('{\n  "theme": "dark"\n}\n');
			chmodSync(agentDir, 0o555);
			const manager = SettingsManager.create(cwd, agentDir);
			const failure = await manager.persistenceFailure();

			expect(failure).toContain("EACCES");
			expect(readFileSync(settingsPath, "utf-8")).toContain("dark");
		},
	);

	it("stays silent and reports nothing once every recorded failure has been handed out (positive control)", async () => {
		const { cwd, agentDir, settingsPath } = workspace();
		const manager = SettingsManager.create(cwd, agentDir);

		expect(await manager.persistenceFailure()).toBeUndefined();
		manager.setEnabledModels(["bailian/kimi-k3"]);
		expect(await manager.persistenceFailure()).toBeUndefined();
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).enabledModels).toEqual(["bailian/kimi-k3"]);
		// A reported failure is consumed: the next call reports only new ones.
		expect(await manager.persistenceFailure()).toBeUndefined();
	});

	it("scopes the report to one scope when a scope is given", async () => {
		const { cwd, agentDir, settingsPath } = workspace('{ "theme": "dark", oops }\n');
		const manager = SettingsManager.create(cwd, agentDir);
		manager.drainErrors();
		manager.setEnabledModels(["bailian/kimi-k3"]);

		expect(await manager.persistenceFailure("project")).toBeUndefined();
		expect(await manager.persistenceFailure("global")).toContain("failed to parse");
		expect(readFileSync(settingsPath, "utf-8")).toContain("oops");
	});
});
