import { describe, expect, it } from "vitest";
import { planOrphanWorkerReap, type StopSelection } from "../src/cli/daemon-ps.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

/**
 * MS-4(b): worker sockets are deliberately kept out of the daemon list, so a
 * leaked worker (supervisor crashed, or a suite daemon exited and left it
 * behind) needs its own scoped cleanup face. The pid in a descriptor is only
 * ever signalled after its recorded process identity is re-verified, because a
 * recycled pid is somebody else's process.
 */

const MY_SOCKET_DIR = "/tmp/r13-workers-a/prime-agent-501";
const MY_SUPERVISOR = `${MY_SOCKET_DIR}/daemon.sock`;
const OTHERS_SUPERVISOR = "/tmp/r13-workers-b/prime-agent-501/daemon.sock";

const IN_MY_SCOPE: StopSelection = { scope: { kind: "socket-dir", socketDir: MY_SOCKET_DIR }, orphansOnly: false };
const SERVED = new Set([MY_SUPERVISOR]);

describe("planOrphanWorkerReap", () => {
	it("stops an in-scope worker whose supervisor is gone", () => {
		const action = planFor(descriptor({ processStartId: "start-1" }), new Set(), { alive: true, matches: true });
		expect(action.kind).toBe("stop");
	});

	it("never touches a worker whose supervisor lives in another scope", () => {
		const action = planFor(
			descriptor({ supervisorSocketPath: OTHERS_SUPERVISOR, processStartId: "start-1" }),
			new Set(),
			{ alive: true, matches: true },
		);
		expect(action.kind).toBe("skip");
		expect(action.kind === "skip" ? action.reason : "").toContain("outside the cleanup scope");
	});

	it("leaves the workers of a still-serving supervisor alone", () => {
		const action = planFor(descriptor({ processStartId: "start-1" }), SERVED, { alive: true, matches: true });
		expect(action.kind).toBe("skip");
		expect(action.kind === "skip" ? action.reason : "").toContain("still serving");
	});

	it("refuses to signal a pid whose identity no longer matches the descriptor", () => {
		const action = planFor(descriptor({ processStartId: "start-1" }), new Set(), { alive: true, matches: false });
		expect(action.kind).toBe("skip");
		expect(action.kind === "skip" ? action.reason : "").toContain("identity does not match");
	});

	it("refuses to signal a v1 descriptor that recorded no identity at all", () => {
		const action = planFor(descriptor({}), new Set(), { alive: true, matches: true });
		expect(action.kind).toBe("skip");
		expect(action.kind === "skip" ? action.reason : "").toContain("recorded no process identity");
	});

	it("still clears the records of a worker whose process is gone", () => {
		expect(planFor(descriptor({ processStartId: "start-1" }), new Set(), { alive: false, matches: false }).kind).toBe(
			"remove-records",
		);
	});
});

function planFor(
	descriptor: DaemonWorkerDescriptor,
	served: ReadonlySet<string>,
	process: { alive: boolean; matches: boolean },
) {
	return planOrphanWorkerReap([descriptor], served, {
		selection: IN_MY_SCOPE,
		processAlive: () => process.alive,
		identityMatches: () => process.matches,
	})[0]!;
}

function descriptor(overrides: Partial<DaemonWorkerDescriptor>): DaemonWorkerDescriptor {
	return {
		version: 2,
		workerId: "worker-1",
		pid: 4242,
		socketPath: `${MY_SOCKET_DIR}/worker-006efe2a2537-fd1c777c013c.sock`,
		recoveryJournalPath: "/tmp/r13-workers-a/recovery.jsonl",
		supervisorSocketPath: MY_SUPERVISOR,
		rootActiveSessionId: "session-1",
		...overrides,
	} as DaemonWorkerDescriptor;
}
