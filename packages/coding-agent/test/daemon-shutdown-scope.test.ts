import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	bindStopSelection,
	type DaemonInfo,
	describeShutdownScope,
	isWorkerSocketPath,
	matchesShutdownScope,
	planReap,
	planShutdownAll,
	type ReapAction,
	type StopSelection,
} from "../src/cli/daemon-ps.js";
import { defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

/**
 * MS-1 / MS-4(b): a stop command has to decide *which* daemons it may touch
 * before it plans anything, and the whole-machine sweep must be the opt-in.
 * Everything is asserted against the plan, because the plan is the destroy
 * list: a daemon in it is a daemon that dies.
 */

const MY_SOCKET_DIR = "/tmp/r13-scope-a/prime-agent-501";
const MINE = `${MY_SOCKET_DIR}/daemon.sock`;
const MINE_SECOND = `${MY_SOCKET_DIR}/suite.sock`;
const OTHERS_SOCKET_DIR = "/tmp/r13-scope-b/prime-agent-501";
const OTHERS = `${OTHERS_SOCKET_DIR}/daemon.sock`;

const IN_MY_SCOPE: StopSelection = { scope: { kind: "socket-dir", socketDir: MY_SOCKET_DIR }, orphansOnly: false };
const WHOLE_MACHINE: StopSelection = { scope: { kind: "machine" }, orphansOnly: false };
const ONLY_OTHERS: StopSelection = { scope: { kind: "socket", socketPath: OTHERS }, orphansOnly: false };

const discovered: DaemonInfo[] = [
	makeDaemon({ socketPath: MINE, status: "current", isDefault: true, sessionCount: 119, pid: 32250 }),
	makeDaemon({ socketPath: MINE_SECOND, status: "current", sessionCount: 0, pid: 1729 }),
	makeDaemon({ socketPath: OTHERS, status: "current", sessionCount: 3, pid: 4242 }),
];

function kindsBySocket(plan: readonly ReapAction[]): Record<string, ReapAction["kind"]> {
	return Object.fromEntries(plan.map((action) => [action.daemon.socketPath, action.kind]));
}

function skipReason(plan: readonly ReapAction[], socketPath: string): string {
	const action = plan.find((candidate) => candidate.daemon.socketPath === socketPath);
	return action && action.kind === "skip" ? action.reason : "";
}

describe("shutdown scope", () => {
	it("leaves a daemon on another socket dir out of the destroy list by default", () => {
		const plan = planShutdownAll(discovered, false, IN_MY_SCOPE);
		expect(kindsBySocket(plan)).toEqual({ [MINE]: "shutdown", [MINE_SECOND]: "shutdown", [OTHERS]: "skip" });
		// Left running, and the plan says which instance it is leaving alone.
		expect(skipReason(plan, OTHERS)).toContain("outside the shutdown scope");
		expect(skipReason(plan, OTHERS)).toContain(OTHERS_SOCKET_DIR);
	});

	it("lists every daemon when the whole-machine switch is asked for", () => {
		const plan = planShutdownAll(discovered, false, WHOLE_MACHINE);
		expect(plan.every((action) => action.kind === "shutdown")).toBe(true);
	});

	it("scopes to exactly one daemon when a socket is named", () => {
		expect(kindsBySocket(planShutdownAll(discovered, false, ONLY_OTHERS))).toEqual({
			[MINE]: "skip",
			[MINE_SECOND]: "skip",
			[OTHERS]: "shutdown",
		});
	});

	it("never widens the scope with --force", () => {
		// --force answers the confirmation question; it is not a scope grant.
		expect(kindsBySocket(planShutdownAll(discovered, true, IN_MY_SCOPE))[OTHERS]).toBe("skip");
	});

	it("treats a live service in another dir as untouchable even under --force", () => {
		// --force answers the confirmation question; it is never a scope grant.
		const plan = planShutdownAll(discovered, true, IN_MY_SCOPE);
		expect(kindsBySocket(plan)[OTHERS]).toBe("skip");
		expect(skipReason(plan, OTHERS)).toContain(OTHERS_SOCKET_DIR);
	});
});

describe("scoped cleanup", () => {
	it("removes only the orphan socket inside the caller's scope", () => {
		const orphans = [
			makeDaemon({ socketPath: `${MY_SOCKET_DIR}/dead.sock`, status: "orphan-file" }),
			makeDaemon({ socketPath: `${OTHERS_SOCKET_DIR}/dead.sock`, status: "orphan-file" }),
		];
		expect(kindsBySocket(planReap(orphans, false, IN_MY_SCOPE))).toEqual({
			[`${MY_SOCKET_DIR}/dead.sock`]: "remove-file",
			[`${OTHERS_SOCKET_DIR}/dead.sock`]: "skip",
		});
	});

	it("still removes both orphans on an explicit whole-machine cleanup", () => {
		const orphans = [
			makeDaemon({ socketPath: `${MY_SOCKET_DIR}/dead.sock`, status: "orphan-file" }),
			makeDaemon({ socketPath: `${OTHERS_SOCKET_DIR}/dead.sock`, status: "orphan-file" }),
		];
		expect(planReap(orphans, false, WHOLE_MACHINE).map((action) => action.kind)).toEqual([
			"remove-file",
			"remove-file",
		]);
	});

	it("never kills an unreachable daemon that still owns live worker processes", () => {
		const hungWithWorkers = makeDaemon({
			socketPath: `${MY_SOCKET_DIR}/hung.sock`,
			status: "unreachable",
			pid: 515,
			liveWorkerCount: 2,
		});
		const hungIdle = makeDaemon({
			socketPath: `${MY_SOCKET_DIR}/hung.sock`,
			status: "unreachable",
			pid: 516,
			liveWorkerCount: 0,
		});
		expect(planReap([hungWithWorkers], true, WHOLE_MACHINE)[0]!.kind).toBe("skip");
		// Positive control: a truly hung service with no workers is still killable.
		expect(planReap([hungIdle], true, WHOLE_MACHINE)[0]!.kind).toBe("kill");
	});

	it("never stops an idle service whose worker processes are alive", () => {
		const plan = planReap(
			[
				makeDaemon({
					socketPath: `${MY_SOCKET_DIR}/idle.sock`,
					status: "current",
					sessionCount: 0,
					pid: 7,
					liveWorkerCount: 1,
				}),
			],
			false,
			WHOLE_MACHINE,
		);
		expect(plan[0]!.kind).toBe("skip");
	});
});

describe("isWorkerSocketPath", () => {
	it("recognizes worker sockets in this process's service directory", () => {
		expect(isWorkerSocketPath(`${defaultDaemonSocketDir()}/worker-abc.sock`)).toBe(true);
		expect(isWorkerSocketPath(`${defaultDaemonSocketDir()}/daemon.sock`)).toBe(false);
		expect(isWorkerSocketPath("/tmp/worker-abc.sock")).toBe(false);
	});

	it("does not read this process's temp dir itself as a worker directory", () => {
		// The temp dir is the parent of the service dir, so its name matched what a
		// comparison against that parent's name was looking for: on every machine
		// whose `$TMPDIR` is `/tmp` (Linux, CI) any `/tmp/worker-abc.sock` counted
		// as somebody's worker. A daemon listening under a name like that then
		// vanished from `ps`, from the stop plan and from the force sweeps.
		const tmpRoot = resolve(defaultDaemonSocketDir(), "..");
		expect(isWorkerSocketPath(`${tmpRoot}/worker-abc.sock`)).toBe(false);
	});

	it("recognizes a worker socket in another session's service directory", () => {
		// A worker is created in *its own* $TMPDIR/prime-agent-<uid>. Not knowing
		// that made another shell's live worker show up as a stale daemon.
		const foreign = "/tmp/r13-other-tmp/prime-agent-501/worker-12f042ee5718-46490fc846bf.sock";
		expect(isWorkerSocketPath(foreign)).toBe(true);
		expect(isWorkerSocketPath("/tmp/r13-other-tmp/prime-agent-501/daemon.sock")).toBe(false);
		expect(isWorkerSocketPath("/tmp/r13-other-tmp/scratch/worker-abc.sock")).toBe(false);
	});
});

describe("daemon identity scope", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "r17-identity-scope-"));
	const agentDir = join(tempRoot, "agent");
	const otherAgentDir = join(tempRoot, "other-agent");
	const registryDir = join(tempRoot, "registry");
	const servedDir = join(tempRoot, "served");
	const SERVED = join(servedDir, "daemon.sock");
	const OTHER_SERVED = join(servedDir, "other-daemon.sock");
	const LEFTOVER = join(servedDir, "dead.sock");
	for (const directory of [agentDir, otherAgentDir, registryDir, servedDir]) {
		mkdirSync(directory, { recursive: true });
	}
	afterAll(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	/**
	 * Publish one live owner record per (agent dir, socket) pair, bind this
	 * process's `current` scope to `agentDir`, then hand the records back so a
	 * failed assertion cannot leak them into the real registry scan.
	 */
	async function bindForOwnedAgentDir(owned: Array<{ agentDir: string; socketPath: string }>): Promise<StopSelection> {
		const acquired = [];
		try {
			for (const [index, entry] of owned.entries()) {
				acquired.push(
					await acquireDaemonSupervisorOwnership({
						agentDir: entry.agentDir,
						appVersion: "test",
						descriptorDir: join(entry.agentDir, "daemon-workers"),
						generation: `r17-scope-${index}`,
						registryDir,
						socketPath: entry.socketPath,
					}),
				);
			}
			return await bindStopSelection({ scope: { kind: "current" }, orphansOnly: false }, { agentDir, registryDir });
		} finally {
			for (const owner of acquired.reverse()) {
				await owner.release();
			}
		}
	}

	it("binds the current scope to the daemon that serves this agent dir", async () => {
		// A daemon for this agent dir may listen anywhere — `--daemon-socket`, a
		// suite harness, a client whose `$TMPDIR` differs from the daemon's — and
		// `list`/`attach` reach it through the supervisor registry. A plain
		// `shutdown` that could not stop that same daemon would leave `--all`,
		// which also stops every other live instance on the box, as its only lever.
		const selection = await bindForOwnedAgentDir([{ agentDir, socketPath: SERVED }]);
		if (selection.scope.kind !== "daemon-identity") throw new Error("expected the agent-dir identity scope");
		expect(selection.scope.socketDir).toBe(resolve(defaultDaemonSocketDir()));
		expect(selection.scope.agentSocketPaths).toEqual([resolve(SERVED)]);
		expect(
			kindsBySocket(
				planShutdownAll([makeDaemon({ socketPath: SERVED, status: "current", pid: 4242 })], false, selection),
			),
		).toEqual({ [SERVED]: "shutdown" });
	});

	it("keeps another agent dir's daemon out of the identity scope, with or without --force", async () => {
		const selection = await bindForOwnedAgentDir([
			{ agentDir, socketPath: SERVED },
			{ agentDir: otherAgentDir, socketPath: OTHER_SERVED },
		]);
		const daemons = [
			makeDaemon({ socketPath: SERVED, status: "current", pid: 4242 }),
			makeDaemon({ socketPath: OTHER_SERVED, status: "current", pid: 4343 }),
		];
		expect(kindsBySocket(planShutdownAll(daemons, true, selection))).toEqual({
			[SERVED]: "shutdown",
			[OTHER_SERVED]: "skip",
		});
		expect(skipReason(planShutdownAll(daemons, true, selection), OTHER_SERVED)).toContain(
			"outside the shutdown scope",
		);
	});

	it("widens to the served socket only, never to the whole directory around it", async () => {
		// The registry names one socket, so that is the whole of the extra leg: a
		// leftover file beside it is somebody else's business, including a hidden
		// supervisor of another agent dir that happens to share the directory.
		const selection = await bindForOwnedAgentDir([{ agentDir, socketPath: SERVED }]);
		expect(matchesShutdownScope(LEFTOVER, selection.scope)).toBe(false);
		expect(planReap([makeDaemon({ socketPath: LEFTOVER, status: "orphan-file" })], false, selection)[0]!.kind).toBe(
			"skip",
		);
	});

	it("degrades to the shell's socket dir when this agent dir has no live daemon", async () => {
		const selection = await bindForOwnedAgentDir([]);
		if (selection.scope.kind !== "daemon-identity") throw new Error("expected the agent-dir identity scope");
		expect(selection.scope.agentSocketPaths).toEqual([]);
		expect(matchesShutdownScope(SERVED, selection.scope)).toBe(false);
		expect(describeShutdownScope(selection.scope)).toContain(resolve(defaultDaemonSocketDir()));
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
