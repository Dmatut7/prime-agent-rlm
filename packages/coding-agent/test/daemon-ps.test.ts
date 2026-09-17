import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DaemonInfo,
	evaluateShutdownQuietPeriod,
	isWorkerSocketPath,
	mergeDiscoveredDaemonProcesses,
	parseLsofListeners,
	parsePrimeAgentProcessIds,
	parsePsProcessStats,
	parseSsListeners,
	planReap,
	planShutdownAll,
	planShutdownConfirmation,
	sortDaemons,
	verifyHelloSupervisorPid,
} from "../src/cli/daemon-ps.js";
import { MACHINE_STOP_SELECTION } from "../src/cli/daemon-stop-scope.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";

describe("worker socket classification", () => {
	it.runIf(process.platform !== "win32")("recognizes only worker sockets in the default service directory", () => {
		expect(isWorkerSocketPath(join(defaultDaemonSocketDir(), "worker-abc.sock"))).toBe(true);
		expect(isWorkerSocketPath(join(defaultDaemonSocketDir(), "daemon.sock"))).toBe(false);
		expect(isWorkerSocketPath("/tmp/worker-abc.sock")).toBe(false);
	});
});

describe("parseSsListeners", () => {
	const stdout = [
		"Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
		'u_str LISTEN 0      511    /tmp/custom.sock 10147608 * 0 users:(("prime-agent",pid=1234,fd=22))',
		'u_str LISTEN 0      511    /tmp/prime-agent-1000/daemon.sock 79453846 * 0 users:(("prime-agent",pid=5678,fd=24))',
		'u_str LISTEN 0      4096   /run/dbus/system_bus_socket 123 * 0 users:(("dbus-daemon",pid=900,fd=3))',
		'u_str ESTAB  0      0      /tmp/other.sock 456 * 0 users:(("prime-agent",pid=4321,fd=9))',
		"",
	].join("\n");

	it("extracts socket + pid for prime-agent LISTEN sockets only", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons).toEqual([
			{ pid: 1234, socketPath: "/tmp/custom.sock" },
			{ pid: 5678, socketPath: "/tmp/prime-agent-1000/daemon.sock" },
		]);
	});

	it("ignores sockets owned by other processes and non-LISTEN states", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons.some((daemon) => daemon.socketPath.includes("dbus"))).toBe(false);
		expect(daemons.some((daemon) => daemon.pid === 4321)).toBe(false);
	});

	it("honors a different app name", () => {
		expect(parseSsListeners(stdout, "pi")).toEqual([]);
	});
});

describe("parseLsofListeners", () => {
	it("pairs each pid with its listening unix socket paths", () => {
		const stdout = ["p1234", "fu", "n/tmp/a.sock", "p5678", "n/tmp/b.sock", "n0x0 (not a path)", ""].join("\n");
		expect(parseLsofListeners(stdout)).toEqual([
			{ pid: 1234, socketPath: "/tmp/a.sock" },
			{ pid: 5678, socketPath: "/tmp/b.sock" },
		]);
	});
});

describe("parsePrimeAgentProcessIds", () => {
	it("finds process.title names even when lsof reports the executable as node", () => {
		const stdout = [
			"  123 node prime-agent --mode daemon",
			"  456 prime-agent prime-agent",
			"  789 /usr/local/bin/prime-agent prime-agent",
			"  900 node unrelated.js",
			"",
		].join("\n");
		expect(parsePrimeAgentProcessIds(stdout, "prime-agent")).toEqual([123, 456, 789]);
	});
});

describe("mergeDiscoveredDaemonProcesses", () => {
	it("keeps process-title discoveries when lsof by name returned only a partial set", () => {
		expect(
			mergeDiscoveredDaemonProcesses(
				[
					{ pid: 123, socketPath: "/tmp/by-name.sock" },
					{ pid: 456, socketPath: "/tmp/shared.sock" },
				],
				[
					{ pid: 456, socketPath: "/tmp/shared.sock" },
					{ pid: 789, socketPath: "/tmp/by-pid.sock" },
				],
			),
		).toEqual([
			{ pid: 123, socketPath: "/tmp/by-name.sock" },
			{ pid: 456, socketPath: "/tmp/shared.sock" },
			{ pid: 789, socketPath: "/tmp/by-pid.sock" },
		]);
	});
});

it("recognizes Windows worker named pipes on every platform", () => {
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee")).toBe(true);
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-daemon")).toBe(false);
});

describe("evaluateShutdownQuietPeriod", () => {
	it("requires a full quiet period independently of the convergence window", () => {
		expect(evaluateShutdownQuietPeriod(10_500, 10_000)).toBe("waiting");
		expect(evaluateShutdownQuietPeriod(11_000, 10_000)).toBe("complete");
	});
});

describe("verifyHelloSupervisorPid", () => {
	it("accepts the hello pid only while its process identity still matches", () => {
		const processStartId = getProcessStartId(process.pid);
		expect(verifyHelloSupervisorPid(process.pid, processStartId)).toBe(process.pid);
		if (processStartId) {
			expect(verifyHelloSupervisorPid(process.pid, `${processStartId}-stale`)).toBeUndefined();
		}
	});
});

describe("parsePsProcessStats", () => {
	it("maps pid to elapsed seconds and sampled cpu", () => {
		const stats = parsePsProcessStats("  1234 1-02:03:04    7.6\n  5678       04:21    0.0\n");
		expect(stats.get(1234)).toEqual({ uptimeSeconds: 93784, cpuPercent: 7.6 });
		expect(stats.get(5678)).toEqual({ uptimeSeconds: 261, cpuPercent: 0 });
		expect(stats.size).toBe(2);
	});

	it("keeps the uptime when a platform refuses the cpu column", () => {
		expect(parsePsProcessStats("  1234  42\n").get(1234)).toEqual({ uptimeSeconds: 42 });
	});

	it("drops a line whose elapsed column is not a duration", () => {
		expect(parsePsProcessStats("ps: etimes: keyword not found\n").size).toBe(0);
	});
});

describe("sortDaemons", () => {
	it("orders default first, then by status, then socket", () => {
		const daemons: DaemonInfo[] = [
			makeDaemon({ socketPath: "/tmp/z.sock", status: "orphan-file" }),
			makeDaemon({ socketPath: "/tmp/a.sock", status: "stale" }),
			makeDaemon({ socketPath: "/tmp/default.sock", status: "current", isDefault: true }),
			makeDaemon({ socketPath: "/tmp/b.sock", status: "current" }),
			makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" }),
		];
		expect(sortDaemons(daemons).map((daemon) => daemon.socketPath)).toEqual([
			"/tmp/default.sock",
			"/tmp/b.sock",
			"/tmp/a.sock",
			"/tmp/c.sock",
			"/tmp/z.sock",
		]);
	});
});

describe("planReap", () => {
	it("never touches the default daemon or daemons with live sessions", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "stale", isDefault: true, sessionCount: 0, pid: 1 }),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
			],
			true,
			MACHINE_STOP_SELECTION,
		);
		expect(plan.map((action) => action.kind)).toEqual(["skip", "skip"]);
	});

	it("removes orphan files and stops reachable idle non-default daemons", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/idle.sock", status: "current", sessionCount: 0, pid: 5 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			false,
			MACHINE_STOP_SELECTION,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "remove-file"]);
	});

	it("removes a stale default socket file", () => {
		const plan = planReap(
			[makeDaemon({ socketPath: "/tmp/default.sock", status: "orphan-file", isDefault: true })],
			true,
			MACHINE_STOP_SELECTION,
		);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("only kills unreachable daemons with --force", () => {
		const daemon = makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 });
		const skipped = planReap([daemon], false, MACHINE_STOP_SELECTION)[0]!;
		expect(skipped.kind).toBe("skip");
		expect(skipped.kind === "skip" ? skipped.reason : "").toContain("prime-agent shutdown --force");
		expect(planReap([daemon], true, MACHINE_STOP_SELECTION)[0]!.kind).toBe("kill");
	});

	it("refuses to kill a pid that backs more than one discovered daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/listening.sock", status: "current", sessionCount: 4, pid: 99 }),
				makeDaemon({ socketPath: "/tmp/phantom.sock", status: "unreachable", pid: 99 }),
			],
			true,
			MACHINE_STOP_SELECTION,
		);
		const phantom = plan.find((action) => action.daemon.socketPath === "/tmp/phantom.sock");
		expect(phantom?.kind).toBe("skip");
		expect(phantom && phantom.kind === "skip" ? phantom.reason : "").toContain("also backs another daemon");
	});
});

describe("planReap startup grace (DS-4)", () => {
	it("leaves a just-started service out of the destroy plan", () => {
		const fresh = makeDaemon({
			socketPath: "/tmp/fresh.sock",
			status: "current",
			sessionCount: 0,
			pid: 5,
			uptimeSeconds: 2,
		});
		const settled = makeDaemon({
			socketPath: "/tmp/settled.sock",
			status: "current",
			sessionCount: 0,
			pid: 6,
			uptimeSeconds: 3600,
		});
		const plan = planReap([fresh, settled], false, { scope: { kind: "machine" }, orphansOnly: false });
		const freshAction = plan.find((action) => action.daemon.socketPath === "/tmp/fresh.sock");
		expect(freshAction?.kind).toBe("skip");
		expect(freshAction && freshAction.kind === "skip" ? freshAction.reason : "").toContain("startup grace");
		expect(plan.find((action) => action.daemon.socketPath === "/tmp/settled.sock")?.kind).toBe("shutdown");
	});

	it("still cleans an orphan file regardless of age", () => {
		const plan = planReap(
			[makeDaemon({ socketPath: "/tmp/new-orphan.sock", status: "orphan-file", uptimeSeconds: 1 })],
			false,
			{ scope: { kind: "machine" }, orphansOnly: false },
		);
		expect(plan[0]!.kind).toBe("remove-file");
	});
});

describe("unreachable + live workers verdict (X-10)", () => {
	it("planReap refuses a hung supervisor that owns live workers; shutdown --force kills it with them", () => {
		const hung = makeDaemon({
			socketPath: "/tmp/hung-workers.sock",
			status: "unreachable",
			pid: 7,
			hasTrackedWorkers: true,
			liveWorkerCount: 2,
		});
		const reap = planReap([hung], true, { scope: { kind: "machine" }, orphansOnly: false })[0]!;
		// The reap sweep is the clearly-safe sweep and has no worker-stop path,
		// so it must refuse where `shutdown --force` — which stops the workers
		// first — kills. The verdicts are different on purpose, and both are exact.
		expect(reap.kind).toBe("skip");
		expect(reap.kind === "skip" && reap.reason).toContain("2 live worker process(es)");
		expect(planShutdownAll([hung], true, { scope: { kind: "machine" }, orphansOnly: false })[0]!.kind).toBe("kill");
	});
});

describe("planShutdownAll", () => {
	it("targets every service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({
					socketPath: "/tmp/default.sock",
					status: "current",
					isDefault: true,
					sessionCount: 0,
					pid: 1,
				}),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
				makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			true,
			MACHINE_STOP_SELECTION,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "shutdown", "kill", "remove-file"]);
	});

	it("never skips a service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({ socketPath: "/tmp/a.sock", status: "stale", pid: 9 }),
				makeDaemon({ socketPath: "/tmp/b.sock", status: "unreachable", pid: 10 }),
			],
			true,
			MACHINE_STOP_SELECTION,
		);
		expect(plan.some((action) => action.kind === "skip")).toBe(false);
	});

	it("removes the socket file for an unreachable daemon with no pid", () => {
		const plan = planShutdownAll(
			[makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" })],
			false,
			MACHINE_STOP_SELECTION,
		);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("requires force for unreachable tracked workers", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/worker-only.sock",
			status: "unreachable",
			hasTrackedWorkers: true,
		});
		expect(planShutdownAll([daemon], false, MACHINE_STOP_SELECTION)[0]!.kind).toBe("skip");
		expect(planShutdownAll([daemon], true, MACHINE_STOP_SELECTION)[0]!.kind).toBe("remove-file");
	});
});

describe("planShutdownConfirmation", () => {
	it("never prompts when JSON output was requested", () => {
		expect(planShutdownConfirmation(1, true, false, true)).toBe("json-error");
	});

	it("prompts only for non-JSON shutdown at a TTY", () => {
		expect(planShutdownConfirmation(1, false, false, true)).toBe("prompt");
		expect(planShutdownConfirmation(1, false, false, false)).toBe("tty-error");
		expect(planShutdownConfirmation(1, true, true, true)).toBe("none");
		expect(planShutdownConfirmation(0, false, false, true)).toBe("none");
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
