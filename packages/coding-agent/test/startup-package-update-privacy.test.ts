import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { checkForPackageUpdates } from "../src/modes/shared/startup-notices.js";

/**
 * U1/SEC-1: the startup package-update check is a background outbound path (it spawns
 * `npm view <pkg> version --json` and `git ls-remote origin`), so the standing privacy
 * switches must gate it the same way they gate the release check. The spawned child is
 * replaced with a mock that answers the registry lookup locally, so "an update check
 * happened" is observable as a recorded spawn with no real network.
 */
const spawnState = vi.hoisted(() => ({
	calls: [] as Array<{ command: string; args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn(command: string, args: string[], _options: unknown): ChildProcess {
			spawnState.calls.push({ command, args });
			const stdout = new EventEmitter() as unknown as Readable;
			const stderr = new EventEmitter() as unknown as Readable;
			const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() });
			// Answer `npm view <pkg> version --json` without a registry round-trip.
			queueMicrotask(() => {
				stdout.emit("data", '"9.9.9"');
				child.emit("close", 0, null);
			});
			return child as unknown as ChildProcess;
		},
	};
});

const PACKAGE_NAME = "pi-startup-gate-fixture";

const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalOffline = process.env.PI_OFFLINE;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

describe("startup package-update privacy gate", () => {
	let testDir = "";
	let projectDir = "";
	let agentDir = "";
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// The vitest config sets DO_NOT_TRACK=1 for the whole suite; these tests are
		// about the gate itself, so start from "no opt-out" and let each test set its own.
		process.env.DO_NOT_TRACK = "0";
		delete process.env.PI_OFFLINE;
		spawnState.calls = [];

		testDir = join(tmpdir(), `pi-startup-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(testDir, "project");
		agentDir = join(testDir, "agent");
		// A project-scoped installed npm package: settings declare it and the install
		// root holds a package.json, which is what drives the update-check spawn.
		const packageDir = join(projectDir, ".prime", "agent", "npm", "node_modules", PACKAGE_NAME);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ packages: [`npm:${PACKAGE_NAME}`] }),
		);
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0" }));
		mkdirSync(agentDir, { recursive: true });

		fetchMock = vi.fn(async () => {
			throw new Error("unexpected outbound fetch in startup gate test");
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		restoreEnv("DO_NOT_TRACK", originalDoNotTrack);
		restoreEnv("PI_OFFLINE", originalOffline);
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	async function runStartupCheck(): Promise<string[]> {
		return checkForPackageUpdates({
			cwd: projectDir,
			agentDir,
			settingsManager: SettingsManager.create(projectDir, agentDir),
		});
	}

	it("spawns no update-check subprocess when DO_NOT_TRACK=1", async () => {
		process.env.DO_NOT_TRACK = "1";
		delete process.env.PI_OFFLINE;

		await expect(runStartupCheck()).resolves.toEqual([]);
		expect(spawnState.calls).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("positive control: runs the npm update check when no opt-out is set", async () => {
		const updates = await runStartupCheck();

		expect(updates).toEqual([PACKAGE_NAME]);
		expect(spawnState.calls.some((call) => call.args.includes("view"))).toBe(true);
	});

	it("PI_OFFLINE=1 suppresses the update check", async () => {
		process.env.PI_OFFLINE = "1";

		await expect(runStartupCheck()).resolves.toEqual([]);
		expect(spawnState.calls).toHaveLength(0);
	});

	it("PI_OFFLINE=0 is an explicit not-offline and must not suppress the check", async () => {
		process.env.PI_OFFLINE = "0";

		const updates = await runStartupCheck();

		expect(updates).toEqual([PACKAGE_NAME]);
		expect(spawnState.calls.some((call) => call.args.includes("view"))).toBe(true);
	});
});
