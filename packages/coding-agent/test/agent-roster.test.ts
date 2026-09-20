import { describe, expect, it } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { classifyAgentStatus, isSessionSummaryBusy } from "../src/modes/daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { classifySubagentSnapshotStatus } from "../src/modes/interactive/components/subagent-summary-line.js";

function summaryFor(resident: boolean, busy: boolean, heartbeat: boolean): SessionSummary {
	return {
		id: "s-1",
		...(resident ? { activeSessionId: "as-1" } : {}),
		lifecycle: "live",
		// Both axes agree here on purpose: `busy` means "a turn is in flight", which is what the
		// display axis reports and what the residency axis reports. The row where they disagree
		// (kernel-hosted background work after the turn ended) is its own case below.
		activity: busy ? "working" : "idle",
		isSessionActive: busy,
		...(heartbeat ? { hasActiveHeartbeat: true } : {}),
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: busy,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function childFor(resident: boolean, busy: boolean): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: "child-1",
		label: "child-1",
		status: busy ? "running" : "done",
		sessionDir: "/tmp/child-1",
		...(resident ? { activeSessionId: "as-1" } : {}),
	};
}

describe("classifyAgentStatus", () => {
	it("classifies once and both surface adapters agree with it", () => {
		// The formula's three defining rows: a queued child runs before any session
		// exists, nothing else resurrects a non-resident agent, residents split on work.
		expect(classifyAgentStatus({ resident: false, queuedChild: true, busy: false })).toBe("running");
		expect(classifyAgentStatus({ resident: false, queuedChild: false, busy: true })).toBe("inactive");
		expect(classifySubagentSnapshotStatus({ ...childFor(false, false), status: "queued" })).toBe("running");
		for (const busy of [false, true]) {
			const expected = classifyAgentStatus({ resident: true, queuedChild: false, busy });
			expect(expected).toBe(busy ? "running" : "idle");
			for (const heartbeat of [false, true]) {
				expect(classifySessionRosterStatus(summaryFor(true, busy, heartbeat)), `busy=${busy} hb=${heartbeat}`).toBe(
					expected,
				);
			}
			expect(classifySubagentSnapshotStatus(childFor(true, busy)), `busy=${busy}`).toBe(expected);
		}
		expect(classifySessionRosterStatus(summaryFor(false, false, true))).toBe("inactive");
		expect(classifySubagentSnapshotStatus(childFor(false, false))).toBe("inactive");
	});

	it("keeps a session with only delegated child work out of running", () => {
		const delegating: SessionSummary = { ...summaryFor(true, false, false), hasRunningRlmChildren: true };
		expect(classifySessionRosterStatus(delegating)).toBe("idle");
		const streaming: SessionSummary = { ...summaryFor(true, true, false), hasRunningRlmChildren: true };
		expect(classifySessionRosterStatus(streaming)).toBe("running");
	});

	it("reads the display axis for the section and the residency axis for eviction", () => {
		// Case linkrefund-post2-ds (2026-09-20): a subagent whose turn ended but whose kernel still
		// hosts a live bash() handle. summaryForActiveSession folds that residency fact into
		// isSessionActive (r44/LIVE-1 carrier 2), so the two axes disagree - and only the display
		// axis says anything about what the agent is doing right now.
		const hostingOnly: SessionSummary = { ...summaryFor(true, false, false), isSessionActive: true };
		expect(hostingOnly.activity).toBe("idle");
		expect(hostingOnly.isSessionActive).toBe(true);
		// Section: display axis. A row that only hosts background work is not "Running".
		expect(classifySessionRosterStatus(hostingOnly)).toBe("idle");
		// Residency: unchanged, so canPassivateSession / canEvictWorker still see the live work.
		expect(isSessionSummaryBusy(hostingOnly)).toBe(true);
		// Positive control: a real turn in flight is still Running.
		expect(classifySessionRosterStatus(summaryFor(true, true, false))).toBe("running");
		// Positive control: non-residency still wins over both axes.
		expect(classifySessionRosterStatus(summaryFor(false, true, false))).toBe("inactive");
	});
});
