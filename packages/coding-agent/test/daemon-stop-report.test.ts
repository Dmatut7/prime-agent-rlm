import { describe, expect, it } from "vitest";
import {
	type DaemonInfo,
	formatShutdownQuestion,
	formatShutdownReport,
	protectedShutdownPids,
	selectStoppableDaemons,
} from "../src/cli/daemon-ps.js";
import {
	currentShutdownScope,
	describeShutdownScope,
	MACHINE_SCOPE,
	resolveShutdownScope,
	resolveStopSelection,
} from "../src/cli/daemon-stop-scope.js";

/**
 * MS-1(b): whatever the confirmation gate is, the report in front of it has to
 * name the instances, so a person can tell "my two daemons" from "everything
 * on this box, including the 119-session one".
 */

const MY_DIR = "/tmp/r13-report-a/prime-agent-501";
const MINE = `${MY_DIR}/daemon.sock`;
const OTHERS_DIR = "/tmp/r13-report-b/prime-agent-501";
const OTHERS = `${OTHERS_DIR}/daemon.sock`;

const busy = makeDaemon({ socketPath: MINE, status: "current", isDefault: true, sessionCount: 119, pid: 32250 });
const idle = makeDaemon({ socketPath: `${MY_DIR}/suite.sock`, status: "outdated", sessionCount: 0, pid: 1729 });
const foreign = makeDaemon({ socketPath: OTHERS, status: "current", sessionCount: 3, pid: 4242 });

describe("resolveStopSelection", () => {
	it("defaults to this shell's socket dir and never to the machine", () => {
		const resolved = resolveStopSelection({});
		if (!resolved.ok) throw new Error("expected a valid selection");
		// The CLI carries an unbound "current" scope; only the runner may bind it.
		expect(resolved.selection.scope).toEqual({ kind: "current" });
		expect(resolveShutdownScope(resolved.selection.scope)).toEqual(currentShutdownScope());
		expect(resolved.selection.orphansOnly).toBe(false);
	});

	it("reaches the whole machine only through the explicit switch", () => {
		expect(resolveStopSelection({ all: true })).toEqual({
			ok: true,
			selection: { scope: MACHINE_SCOPE, orphansOnly: false },
		});
	});

	it("refuses to let a socket selector and --all fight", () => {
		expect(resolveStopSelection({ all: true, socketPath: MINE })).toEqual({
			ok: false,
			error: "--all cannot be combined with --socket/--socket-dir: pick one scope.",
		});
		expect(resolveStopSelection({ socketPath: MINE, socketDir: MY_DIR }).ok).toBe(false);
	});

	it("keeps --orphans inside whatever scope was chosen", () => {
		const resolved = resolveStopSelection({ socketPath: MINE, orphansOnly: true });
		if (!resolved.ok) throw new Error("expected a valid selection");
		expect(resolved.selection).toEqual({ scope: { kind: "socket", socketPath: MINE }, orphansOnly: true });
	});
});

describe("shutdown report", () => {
	const selection = resolveStopSelection({ socketDir: MY_DIR });
	if (!selection.ok) throw new Error("expected a valid selection");

	it("names each stopped service and each service it is leaving running", () => {
		const { selected, excluded } = selectStoppableDaemons([busy, idle, foreign], selection.selection);
		const report = formatShutdownReport(selection.selection, selected, excluded);
		expect(report).toContain(MINE);
		expect(report).toContain("119 live session(s)");
		expect(report).toContain("[ACTIVE WORK]");
		expect(report).toContain("1729");
		expect(report).toContain(`keep  ${OTHERS}`);
		expect(report).toContain("outside the shutdown scope");
		expect(report.split("\n").filter((line) => line.startsWith("  stop"))).toHaveLength(2);
	});

	it("says so when the scope is the whole machine", () => {
		const wholeMachine = resolveStopSelection({ all: true });
		if (!wholeMachine.ok) throw new Error("expected a valid selection");
		expect(wholeMachine.selection.scope).toBe(MACHINE_SCOPE);
		const report = formatShutdownReport(wholeMachine.selection, [busy, foreign], []);
		expect(report).toContain("WHOLE-MACHINE scope");
		expect(report).toContain(describeShutdownScope(MACHINE_SCOPE));
		expect(formatShutdownQuestion(wholeMachine.selection, [busy, foreign])).toContain(
			"Stop every agent and background service on this machine (2 service(s))? 122 live session(s) will be interrupted.",
		);
	});

	it("counts the sessions that will be interrupted, and says when none will", () => {
		const { selected } = selectStoppableDaemons([busy, idle, foreign], selection.selection);
		expect(formatShutdownQuestion(selection.selection, selected)).toContain(
			"119 live session(s) will be interrupted",
		);
		expect(formatShutdownQuestion(selection.selection, [idle])).toContain("No live sessions are attached");
	});

	it("protects the pid of every service the selection excludes", () => {
		const { selected, excluded } = selectStoppableDaemons([busy, idle, foreign], selection.selection);
		expect(excluded.map((daemon) => daemon.socketPath)).toEqual([OTHERS]);
		expect(protectedShutdownPids([busy, idle, foreign], selection.selection)).toEqual(new Set([4242]));
		// The services it may touch stay unprotected, i.e. still killable.
		expect(selected.map((daemon) => daemon.pid)).toEqual([32250, 1729]);
	});

	it("excludes a live service once --orphans is asked for", () => {
		const orphans = resolveStopSelection({ all: true, orphansOnly: true });
		if (!orphans.ok) throw new Error("expected a valid selection");
		const { selected, excluded } = selectStoppableDaemons([busy, idle, foreign], orphans.selection);
		expect(selected.map((daemon) => daemon.socketPath)).toEqual([`${MY_DIR}/suite.sock`]);
		expect(excluded).toHaveLength(2);
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string }): DaemonInfo {
	return {
		status: "current",
		isDefault: false,
		liveness: (options.sessionCount ?? 0) > 0 ? "live" : "idle",
		...options,
	};
}
