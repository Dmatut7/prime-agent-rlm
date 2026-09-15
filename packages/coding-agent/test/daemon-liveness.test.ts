import { describe, expect, it } from "vitest";
import {
	classifyReachable,
	countLiveTrackedWorkers,
	type DaemonInfo,
	evaluateDaemonLiveness,
	hasLiveWork,
} from "../src/cli/daemon-ps.js";
import { VERSION } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";

/**
 * MS-4(a): "stale" used to be the label for anything that answered on another
 * build, which put a supervisor holding 119 live sessions in the same column as
 * scrap. Liveness is now its own verdict, and a live service can only ever be
 * called `outdated`.
 */

const CURRENT = {
	protocolVersion: DAEMON_PROTOCOL_VERSION,
	schemaId: DAEMON_SCHEMA_ID,
	version: VERSION,
};
const OLDER_BUILD = { protocolVersion: DAEMON_PROTOCOL_VERSION - 1, schemaId: "another-schema", version: "0.0.1" };

describe("evaluateDaemonLiveness", () => {
	it("calls sessions, verified worker processes and cpu samples live evidence", () => {
		expect(evaluateDaemonLiveness({ sessionCount: 119, answeredProbe: true }).liveness).toBe("live");
		expect(evaluateDaemonLiveness({ sessionCount: 0, liveWorkerCount: 1, answeredProbe: true }).liveness).toBe(
			"live",
		);
		expect(evaluateDaemonLiveness({ sessionCount: 0, cpuPercent: 7.6, answeredProbe: false }).liveness).toBe("live");
		expect(evaluateDaemonLiveness({ sessionCount: 3, answeredProbe: true }).evidence).toContain("3 session(s)");
	});

	it("separates a service with nothing running on it from one that is not answering", () => {
		expect(
			evaluateDaemonLiveness({ sessionCount: 0, liveWorkerCount: 0, cpuPercent: 0, answeredProbe: true }),
		).toEqual({ liveness: "idle", evidence: ["answered probe with no work"] });
		expect(
			evaluateDaemonLiveness({ sessionCount: undefined, liveWorkerCount: 0, cpuPercent: 0, answeredProbe: false }),
		).toEqual({ liveness: "unknown", evidence: [] });
	});
});

describe("classifyReachable", () => {
	it("keeps this build current", () => {
		expect(classifyReachable(CURRENT, "live")).toBe("current");
		expect(classifyReachable(CURRENT, "unknown")).toBe("current");
	});

	it("never calls a live service stale, whatever build it answers with", () => {
		expect(classifyReachable(OLDER_BUILD, "live")).toBe("outdated");
	});

	it("still calls an unanswered socket stale, and an idle old one outdated", () => {
		// Positive control: the word stale keeps meaning "not answering as a build".
		expect(classifyReachable(OLDER_BUILD, "unknown")).toBe("stale");
		expect(
			classifyReachable({ protocolVersion: undefined, schemaId: undefined, version: undefined }, "unknown"),
		).toBe("stale");
	});
});

describe("countLiveTrackedWorkers", () => {
	it("counts only workers whose process identity still matches the descriptor", () => {
		const descriptors = [
			workerDescriptor(process.pid, getProcessStartId(process.pid)),
			workerDescriptor(process.pid, "wrong-start-id"),
			workerDescriptor(999_999, undefined),
		];
		expect(countLiveTrackedWorkers(descriptors).get("/tmp/r13-count/daemon.sock")).toBe(1);
	});
});

describe("hasLiveWork", () => {
	it("is the same evidence the status column is built from", () => {
		expect(hasLiveWork(makeDaemon({ sessionCount: 2, liveness: "live" }))).toBe(true);
		expect(hasLiveWork(makeDaemon({ liveWorkerCount: 1 }))).toBe(true);
		expect(hasLiveWork(makeDaemon({ cpuPercent: 0.1 }))).toBe(true);
		expect(hasLiveWork(makeDaemon({ sessionCount: 0, liveWorkerCount: 0, cpuPercent: 0, liveness: "idle" }))).toBe(
			false,
		);
	});
});

function workerDescriptor(pid: number, processStartId: string | undefined) {
	return {
		version: 2,
		workerId: "worker-1",
		pid,
		...(processStartId === undefined ? {} : { processStartId }),
		socketPath: "/tmp/r13-count/worker-1.sock",
		recoveryJournalPath: "/tmp/r13-count/recovery.jsonl",
		supervisorSocketPath: "/tmp/r13-count/daemon.sock",
		authenticationToken: "token",
		rootActiveSessionId: "session-1",
		createdAt: "2026-09-15T00:00:00.000Z",
		updatedAt: "2026-09-15T00:00:00.000Z",
		lifecycle: "running",
		consecutiveFailures: 0,
	} as never;
}

function makeDaemon(options: Partial<DaemonInfo>): DaemonInfo {
	return { socketPath: "/tmp/r13-has-live/daemon.sock", status: "current", isDefault: false, ...options };
}
