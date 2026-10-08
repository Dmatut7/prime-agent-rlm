import type * as ChildProcessModule from "child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";

const updateMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	launchCoordinator: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawnSync: updateMocks.spawnSync,
}));

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonUpdateRestartModule>()),
	launchDaemonUpdateRestartCoordinator: updateMocks.launchCoordinator,
}));

import { buildDaemonUpdateRestartReport } from "../src/cli/daemon-update-restart.js";
import { FORK_GATE_ENV_VAR } from "../src/fork-self-update.js";
import {
	buildExtensionsOnlyUpdateArgs,
	buildUpdateChildArgs,
	buildUpdateRelaunchArgs,
	formatDaemonReconnectBanner,
	InteractiveMode,
	resolveInteractiveUpdateDaemonSocketPath,
	tryExecUpdateRelaunch,
	updateArgsIncludeExtensions,
	updateArgsIncludeSelf,
	updateArgsRequestHelp,
} from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("buildUpdateRelaunchArgs", () => {
	it("relaunches the current session with the supported resume flag", () => {
		expect(buildUpdateRelaunchArgs(["--model", "gpt-5"], "/tmp/session.jsonl")).toEqual([
			"--model",
			"gpt-5",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("keeps an existing resume selection", () => {
		expect(buildUpdateRelaunchArgs(["--resume", "/tmp/other.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--resume",
			"/tmp/other.jsonl",
		]);
	});

	it("does not treat the unsupported session flag as an existing selection", () => {
		expect(buildUpdateRelaunchArgs(["--session", "/tmp/old.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--session",
			"/tmp/old.jsonl",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});
});

describe("tryExecUpdateRelaunch", () => {
	it("replaces the current process while preserving argv zero and the environment", () => {
		const environment = { PRIME_AGENT_CODING_AGENT_DIR: "/tmp/agent", OMITTED: undefined };
		const chdir = vi.fn();
		const execve = vi.fn(() => undefined as never);

		expect(
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["--trace-warnings", "/opt/prime-agent/cli.js", "--resume", "session"] },
				{
					platform: "darwin",
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment,
					chdir,
					execve,
				},
			),
		).toBe(true);
		expect(chdir).toHaveBeenCalledWith("/tmp/project");
		expect(execve).toHaveBeenCalledWith(
			"/usr/bin/node",
			["/usr/bin/node", "--trace-warnings", "/opt/prime-agent/cli.js", "--resume", "session"],
			{ PRIME_AGENT_CODING_AGENT_DIR: "/tmp/agent" },
		);

		// A thrown execve restores the previous cwd before the fallback runs.
		execve.mockImplementationOnce(() => {
			throw new Error("execve failed");
		});
		expect(() =>
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["cli.js"] },
				{
					platform: "darwin",
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment,
					chdir,
					execve,
				},
			),
		).toThrow("execve failed");
		expect(chdir).toHaveBeenLastCalledWith("/tmp/before");
	});

	it.each(["win32", "os400"])("keeps the compatible child relaunch on %s", (platform) => {
		const chdir = vi.fn();
		const execve = vi.fn(() => undefined as never);

		expect(
			tryExecUpdateRelaunch(
				{ command: "node", args: ["cli.js"] },
				{
					platform,
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment: {},
					chdir,
					execve,
				},
			),
		).toBe(false);
		expect(chdir).not.toHaveBeenCalled();
		expect(execve).not.toHaveBeenCalled();
	});

	it.each(["22.22.0", "24.13.0", "25.8.1", "26.0.0"])(
		"keeps the compatible child relaunch when execve failures abort Node %s",
		(nodeVersion) => {
			const chdir = vi.fn();
			const execve = vi.fn(() => undefined as never);

			expect(
				tryExecUpdateRelaunch(
					{ command: "/usr/bin/node", args: ["cli.js"] },
					{
						platform: "linux",
						nodeVersion,
						cwd: "/tmp/project",
						previousCwd: "/tmp/before",
						environment: {},
						chdir,
						execve,
					},
				),
			).toBe(false);
			expect(chdir).not.toHaveBeenCalled();
			expect(execve).not.toHaveBeenCalled();
		},
	);

	it("keeps the compatible child relaunch when execve is unavailable", () => {
		expect(
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["cli.js"] },
				{
					platform: "linux",
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment: {},
					chdir: vi.fn(),
				},
			),
		).toBe(false);
	});
});

describe("interactive self-update relaunch", () => {
	it.skipIf(process.platform === "win32")(
		"tears down and replaces the TUI process without waiting for a child TUI to quit",
		async () => {
			const events: string[] = [];
			updateMocks.spawnSync.mockReset();
			updateMocks.spawnSync.mockImplementation(() => {
				events.push("update");
				return { status: 0, signal: null } as never;
			});
			updateMocks.launchCoordinator.mockReset();
			updateMocks.launchCoordinator.mockImplementation(async () => {
				events.push("coordinator");
				return {
					version: 1,
					requestId: "test-request",
					socketPath: "/tmp/update.sock",
					phase: "complete",
					coordinator: { pid: process.pid },
					counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
					failures: [],
					startedAt: "2026-08-21T00:00:00.000Z",
					updatedAt: "2026-08-21T00:00:01.000Z",
				};
			});

			const updateProcess = process as NodeJS.Process & {
				execve?: (file: string, args: string[], environment: NodeJS.ProcessEnv) => never;
			};
			const originalExecve = updateProcess.execve;
			const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
			const execve = vi.fn((_file: string, _args: string[], _environment: NodeJS.ProcessEnv) => {
				events.push("execve");
				return undefined as never;
			});
			updateProcess.execve = execve;
			Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: "26.1.0" });

			const receiver = {
				connectionState: {
					activeSessionId: "active-session",
					sessionFile: "/tmp/session.jsonl",
				},
				fullscreenEnabled: false,
				options: {
					daemonSocketPath: "/tmp/update.sock",
					onShutdown: async () => events.push("shutdown"),
				},
				getCurrentCwd: () => process.cwd(),
				stopWorkingLoader: () => events.push("loader-stop"),
				stop: () => events.push("mode-stop"),
				ui: {
					terminal: { drainInput: async () => events.push("drain-input") },
					stop: () => events.push("ui-stop"),
				},
				agentConnection: {
					dispose: async () => events.push("connection-dispose"),
				},
			};
			const handleUpdateCommand = (
				InteractiveMode.prototype as unknown as {
					handleUpdateCommand(this: typeof receiver, args: string): Promise<void>;
				}
			).handleUpdateCommand;

			// This suite exercises the official self-update path, and the test run itself
			// lives inside a fork checkout: without the seam the in-session fork gate
			// (R6-M9) refuses before any spawn and the relaunch below never happens.
			const previousForkGate = process.env[FORK_GATE_ENV_VAR];
			process.env[FORK_GATE_ENV_VAR] = "off";
			try {
				await handleUpdateCommand.call(receiver, "");
			} finally {
				if (previousForkGate === undefined) {
					delete process.env[FORK_GATE_ENV_VAR];
				} else {
					process.env[FORK_GATE_ENV_VAR] = previousForkGate;
				}
				updateProcess.execve = originalExecve;
				if (originalNodeVersion) {
					Object.defineProperty(process.versions, "node", originalNodeVersion);
				}
			}

			expect(events).toEqual([
				"loader-stop",
				"drain-input",
				"ui-stop",
				"update",
				"mode-stop",
				"connection-dispose",
				"shutdown",
				"coordinator",
				"execve",
			]);
			expect(updateMocks.spawnSync).toHaveBeenCalledTimes(1);
			expect(execve.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--resume", "/tmp/session.jsonl"]));
		},
	);
});

describe("buildUpdateChildArgs", () => {
	it("passes the active custom socket to the deferred self-update child", () => {
		expect(buildUpdateChildArgs(["--self", "--force"], "/tmp/custom-daemon.sock")).toEqual([
			"--self",
			"--force",
			"--daemon-socket",
			"/tmp/custom-daemon.sock",
		]);
	});

	it("keeps an explicitly selected update socket", () => {
		expect(buildUpdateChildArgs(["--self", "--daemon-socket", "/tmp/explicit.sock"], "/tmp/active.sock")).toEqual([
			"--self",
			"--daemon-socket",
			"/tmp/explicit.sock",
		]);
		expect(
			resolveInteractiveUpdateDaemonSocketPath(
				["--self", "--daemon-socket", "/tmp/explicit.sock"],
				"/tmp/active.sock",
			),
		).toBe("/tmp/explicit.sock");
		expect(updateArgsIncludeSelf(["--daemon-socket", "/tmp/explicit.sock"])).toBe(true);
	});
});

describe("formatDaemonReconnectBanner", () => {
	it.each([
		[undefined, "1.2.3", "Daemon reconnected", "dim"],
		["1.2.3", "1.2.3", "Daemon restarted (v1.2.3) - reconnected", "dim"],
		[
			"2.0.0",
			"1.2.3",
			"Daemon restarted (v2.0.0), this window still runs v1.2.3 - restart the window to pick up the update.",
			"warning",
		],
		[
			"1.2.3",
			"1.2.3-beta.1",
			"Daemon restarted (v1.2.3), this window still runs v1.2.3-beta.1 - restart the window to pick up the update.",
			"warning",
		],
		["1.2.3-beta.1", "1.2.3", "Daemon restarted (v1.2.3-beta.1), this window runs v1.2.3.", "dim"],
	])("maps daemon version %s vs client %s to banner", (daemonVersion, clientVersion, message, tone) => {
		expect(formatDaemonReconnectBanner(daemonVersion, clientVersion)).toEqual({ message, tone });
	});
});

describe("buildDaemonUpdateRestartReport", () => {
	it("reports recovery results when the daemon restart fails", () => {
		const report = buildDaemonUpdateRestartReport({
			version: 1,
			requestId: "test-request",
			socketPath: "/tmp/custom-daemon.sock",
			phase: "failed",
			coordinator: { pid: process.pid },
			counts: { total: 3, restored: 2, resumed: 1, failed: 1 },
			failures: [{ sessionFile: "/tmp/failed.jsonl", message: "create failed" }],
			message: "could not stop predecessor",
			startedAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-14T00:00:01.000Z",
		});

		expect(report.info).toEqual(["Restored 2 daemon sessions", "Resumed 1 interrupted session"]);
		expect(report.warnings).toEqual([
			"Updated, but could not restart the daemon (could not stop predecessor).",
			"1 daemon session could not be restored.",
			"Could not restore /tmp/failed.jsonl: create failed",
		]);
	});
});

describe("opportunistic attach fallback", () => {
	it("recognizes the supervisor's unknown-session error (the relaunch TOCTOU)", async () => {
		const { isUnknownActiveSessionError } = await import("../src/main.js");
		// The update relaunch detaches, the supervisor evicts the empty session,
		// and the relaunched child's opportunistic by-file attach then races the
		// eviction: the daemon answers exactly this text. Falling through to
		// create (instead of crashing with a stack trace) keys on this predicate.
		expect(isUnknownActiveSessionError("Unknown active session: 4f6b0cda6887")).toBe(true);
		expect(isUnknownActiveSessionError("Unknown active session:abc")).toBe(true);
		expect(isUnknownActiveSessionError("daemon handshake failed")).toBe(false);
		expect(isUnknownActiveSessionError("")).toBe(false);
	});
});

describe("updateArgsRequestHelp / updateArgsIncludeExtensions / buildExtensionsOnlyUpdateArgs", () => {
	it("detects help requests", () => {
		expect(updateArgsRequestHelp(["--help"])).toBe(true);
		expect(updateArgsRequestHelp(["-h"])).toBe(true);
		expect(updateArgsRequestHelp(["--self", "--help"])).toBe(true);
		expect(updateArgsRequestHelp(["--self"])).toBe(false);
		expect(updateArgsRequestHelp([])).toBe(false);
	});

	it("detects the extensions half of an update target", () => {
		expect(updateArgsIncludeExtensions([])).toBe(true);
		expect(updateArgsIncludeExtensions(["--force"])).toBe(true);
		expect(updateArgsIncludeExtensions(["--extensions"])).toBe(true);
		expect(updateArgsIncludeExtensions(["--self", "--extensions"])).toBe(true);
		expect(updateArgsIncludeExtensions(["self", "--extensions"])).toBe(true);
		expect(updateArgsIncludeExtensions(["--self"])).toBe(false);
		expect(updateArgsIncludeExtensions(["self"])).toBe(false);
		expect(updateArgsIncludeExtensions(["pi"])).toBe(false);
		expect(updateArgsIncludeExtensions(["some-package"])).toBe(true);
		expect(updateArgsIncludeExtensions(["--extension", "some-package"])).toBe(true);
	});

	it("rewrites a refused self-update to its extensions half", () => {
		expect(buildExtensionsOnlyUpdateArgs([])).toEqual(["--extensions"]);
		expect(buildExtensionsOnlyUpdateArgs(["--force"])).toEqual(["--force", "--extensions"]);
		expect(buildExtensionsOnlyUpdateArgs(["--self", "--extensions"])).toEqual(["--extensions"]);
		expect(buildExtensionsOnlyUpdateArgs(["self", "--extensions"])).toEqual(["--extensions"]);
		expect(buildExtensionsOnlyUpdateArgs(["Prime-Agent", "--force"])).toEqual(["--force", "--extensions"]);
		expect(buildExtensionsOnlyUpdateArgs(["--daemon-socket", "/tmp/x.sock"])).toEqual([
			"--daemon-socket",
			"/tmp/x.sock",
			"--extensions",
		]);
	});
});

describe("interactive /update fork gate and help handling", () => {
	function makeReceiver(events: string[], copyTexts: string[]) {
		const receiver = {
			connectionState: {
				activeSessionId: "active-session",
				sessionFile: "/tmp/session.jsonl",
			},
			fullscreenEnabled: false,
			options: {
				daemonSocketPath: "/tmp/update.sock",
				onShutdown: async () => {
					events.push("shutdown");
				},
			},
			getCurrentCwd: () => process.cwd(),
			stopWorkingLoader: () => {
				events.push("loader-stop");
			},
			stop: () => {
				events.push("mode-stop");
			},
			handleReloadCommand: async () => {
				events.push("reload");
				return true;
			},
			chatContainer: {
				children: [] as unknown[],
				addChild(child: unknown) {
					this.children.push(child);
					const copy = (child as { getBlockCopyText?: () => string }).getBlockCopyText?.();
					if (copy !== undefined) copyTexts.push(copy);
				},
			},
			ui: {
				terminal: {
					drainInput: async () => {
						events.push("drain-input");
					},
				},
				stop: () => {
					events.push("ui-stop");
				},
				start: () => {
					events.push("ui-start");
				},
				requestRender: () => {
					events.push("render");
				},
			},
			agentConnection: {
				dispose: async () => {
					events.push("connection-dispose");
				},
			},
		};
		// The display half of the fixes is part of what is being asserted (the refusal/help
		// text must land in the chat), so the receiver binds the real methods rather than
		// stubbing the observation point.
		const proto = InteractiveMode.prototype as unknown as {
			showUpdateNoticeBlock(this: typeof receiver, lines: readonly string[], tone: "dim" | "warning"): void;
			showStatus(this: typeof receiver, message: string): void;
			showError(this: typeof receiver, message: string): void;
		};
		return Object.assign(receiver, {
			showUpdateNoticeBlock: proto.showUpdateNoticeBlock,
			showStatus: proto.showStatus,
			showError: proto.showError,
		});
	}

	function callHandleUpdate(receiver: ReturnType<typeof makeReceiver>, args: string): Promise<void> {
		const handleUpdateCommand = (
			InteractiveMode.prototype as unknown as {
				handleUpdateCommand(this: ReturnType<typeof makeReceiver>, args: string): Promise<void>;
			}
		).handleUpdateCommand;
		return handleUpdateCommand.call(receiver, args);
	}

	beforeEach(() => {
		initTheme("prime");
		updateMocks.spawnSync.mockReset();
		updateMocks.launchCoordinator.mockReset();
		delete process.env[FORK_GATE_ENV_VAR];
		delete process.env.PRIME_AGENT_INTERACTIVE_SELF_UPDATE;
	});

	it("answers /update --help in-session without touching the UI, the daemon, or the process", async () => {
		// R6-M10: the help run used to inherit the terminal and exit 0, which the relaunch
		// branch read as "updated" - /update --help restarted the daemon and relaunched.
		updateMocks.spawnSync.mockReturnValue({
			status: 0,
			signal: null,
			stdout: "Usage: prime-agent update [--self]\n\nUpdate Prime Agent or installed packages.",
		} as never);
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);

		await callHandleUpdate(receiver, "--help");

		expect(updateMocks.spawnSync).toHaveBeenCalledTimes(1);
		const [, argv, options] = updateMocks.spawnSync.mock.calls[0] as unknown as [
			string,
			string[],
			{ stdio: unknown; env: NodeJS.ProcessEnv },
		];
		expect(argv.slice(-2)).toEqual(["update", "--help"]);
		expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
		expect(options.env.PRIME_AGENT_INTERACTIVE_SELF_UPDATE).toBeUndefined();
		// Nothing was torn down: the UI never stopped, no dispose, no shutdown, no relaunch.
		expect(events).toEqual(["render"]);
		expect(copyTexts.join("\n")).toContain("Usage: prime-agent update");
	});

	it("treats the child's help exit code as 'nothing happened' even when the args branch missed it", async () => {
		// Fault injection for the brake half of R6-M10: a help exit code reaching the update
		// path (the args interception above somehow bypassed) must not relaunch anything.
		process.env[FORK_GATE_ENV_VAR] = "off";
		updateMocks.spawnSync.mockReturnValue({ status: 76, signal: null } as never);
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);

		await callHandleUpdate(receiver, "");

		expect(events).toEqual(["loader-stop", "drain-input", "ui-stop", "ui-start", "render", "render"]);
		expect(updateMocks.launchCoordinator).not.toHaveBeenCalled();
	});

	it("still relaunches on a real update failure exit code", async () => {
		// The brake is a single code, not "any non-zero": a genuine update failure keeps the
		// relaunch that brings the TUI back.
		process.env[FORK_GATE_ENV_VAR] = "off";
		updateMocks.spawnSync.mockReturnValue({ status: 2, signal: null } as never);
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);
		const updateProcess = process as NodeJS.Process & {
			execve?: (file: string, args: string[], environment: NodeJS.ProcessEnv) => never;
		};
		const originalExecve = updateProcess.execve;
		const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
		const execve = vi.fn((_file: string, _args: string[], _environment: NodeJS.ProcessEnv) => {
			events.push("execve");
			return undefined as never;
		});
		updateProcess.execve = execve;
		Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: "26.1.0" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await callHandleUpdate(receiver, "");
		} finally {
			errorSpy.mockRestore();
			updateProcess.execve = originalExecve;
			if (originalNodeVersion) {
				Object.defineProperty(process.versions, "node", originalNodeVersion);
			}
		}

		expect(events).toEqual([
			"loader-stop",
			"drain-input",
			"ui-stop",
			"mode-stop",
			"connection-dispose",
			"shutdown",
			"execve",
		]);
		// A failed update never coordinates a daemon restart.
		expect(updateMocks.launchCoordinator).not.toHaveBeenCalled();
	});

	it("refuses a fork self-update in-session without spawning or relaunching", async () => {
		// R6-M9: the refusal used to flash in the alt-screen gap on the child's stderr, read
		// as exit-1 failure, and relaunch the whole TUI. The test run lives inside a fork
		// checkout, so the gate fires against the real marker.
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);

		await callHandleUpdate(receiver, "--self");

		expect(updateMocks.spawnSync).not.toHaveBeenCalled();
		expect(events).toEqual(["render"]);
		const refusal = copyTexts.join("\n");
		expect(refusal).toContain("refusing to self-update a fork build");
		expect(refusal).toContain("git pull --rebase && npm run build");
	});

	it("still runs the extensions half of a bare /update on a fork, then shows the refusal", async () => {
		updateMocks.spawnSync.mockReturnValue({ status: 0, signal: null } as never);
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);

		await callHandleUpdate(receiver, "");

		expect(updateMocks.spawnSync).toHaveBeenCalledTimes(1);
		const [, argv, options] = updateMocks.spawnSync.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		expect(argv.slice(-2)).toEqual(["update", "--extensions"]);
		expect(argv).not.toContain("--self");
		expect(options.env.PRIME_AGENT_INTERACTIVE_SELF_UPDATE).toBeUndefined();
		const refusal = copyTexts.join("\n");
		expect(refusal).toContain("refusing to self-update a fork build");
		expect(refusal).toContain("Extensions were updated; only the self-update half was refused.");
		// The UI came back and the session reloaded; nothing relaunched.
		expect(events).toContain("ui-start");
		expect(events).toContain("reload");
		expect(events).not.toContain("mode-stop");
		expect(updateMocks.launchCoordinator).not.toHaveBeenCalled();
	});

	it("lets --allow-official through to the official self-update path on a fork", async () => {
		updateMocks.spawnSync.mockReturnValue({ status: 0, signal: null } as never);
		updateMocks.launchCoordinator.mockImplementation(async () => {
			events.push("coordinator");
			return {
				version: 1,
				requestId: "test-request",
				socketPath: "/tmp/update.sock",
				phase: "complete",
				coordinator: { pid: process.pid },
				counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
				failures: [],
				startedAt: "2026-08-21T00:00:00.000Z",
				updatedAt: "2026-08-21T00:00:01.000Z",
			} as never;
		});
		const events: string[] = [];
		const copyTexts: string[] = [];
		const receiver = makeReceiver(events, copyTexts);
		const updateProcess = process as NodeJS.Process & {
			execve?: (file: string, args: string[], environment: NodeJS.ProcessEnv) => never;
		};
		const originalExecve = updateProcess.execve;
		const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
		const execve = vi.fn((_file: string, _args: string[], _environment: NodeJS.ProcessEnv) => {
			events.push("execve");
			return undefined as never;
		});
		updateProcess.execve = execve;
		Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: "26.1.0" });

		try {
			await callHandleUpdate(receiver, "--self --allow-official");
		} finally {
			updateProcess.execve = originalExecve;
			if (originalNodeVersion) {
				Object.defineProperty(process.versions, "node", originalNodeVersion);
			}
		}

		expect(updateMocks.spawnSync).toHaveBeenCalledTimes(1);
		const [, argv, options] = updateMocks.spawnSync.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		expect(argv).toContain("--allow-official");
		expect(options.env.PRIME_AGENT_INTERACTIVE_SELF_UPDATE).toBe("1");
		expect(events).toEqual([
			"loader-stop",
			"drain-input",
			"ui-stop",
			"mode-stop",
			"connection-dispose",
			"shutdown",
			"coordinator",
			"execve",
		]);
		expect(copyTexts.join("\n")).not.toContain("refusing to self-update");
	});
});
