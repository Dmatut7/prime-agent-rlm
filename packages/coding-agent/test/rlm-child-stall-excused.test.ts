import { describe, expect, it } from "vitest";
import type { RlmChildStallState } from "../src/core/agent-session.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { buildAgentsViewRows } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import {
	formatSubagentStallMarker,
	isStalledSubagentSnapshot,
} from "../src/modes/interactive/components/subagent-summary-line.js";

/**
 * B9 / I-13: a stall the watchdog is excusing is healthy long work, and the roster must not say
 * "stalled" about it. The facts still travel (silentMs, thresholdMs, in-flight tools) so an
 * operator can see the duration and a post-mortem still has the record; only the alarm wording and
 * the red marker are withheld, and only while the exemption is unspent. An abort that did not
 * settle is never excused - by then the budget was spent and the kill is the story.
 */
function stall(overrides: Partial<RlmChildStallState> = {}): RlmChildStallState {
	return {
		silentMs: 720_000,
		thresholdMs: 300_000,
		inFlightTools: ["ipython"],
		...overrides,
	};
}

function child(overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {}): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: "child-1",
		parentId: "parent-1",
		label: "worker",
		status: "running",
		sessionDir: "/tmp/session",
		activity: { kind: "executing", toolName: "ipython" },
		...overrides,
	};
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "working",
		isSessionActive: true,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: true,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	} as SessionSummary;
}

describe("an excused stall is not rendered as a stalled child", () => {
	it("keeps the row out of the stalled set and drops the red marker", () => {
		const excused = child({ stall: stall({ excused: true, excusedReasons: ["live_bash_handles"] }) });
		expect(isStalledSubagentSnapshot(excused)).toBe(false);
		// The marker renders as a red "⚠ stalled ..." line; healthy long work gets no alarm line.
		expect(formatSubagentStallMarker(excused)).toBeUndefined();

		// Positive control: the same facts without the exemption still read as a stall.
		const wedged = child({ stall: stall() });
		expect(isStalledSubagentSnapshot(wedged)).toBe(true);
		expect(formatSubagentStallMarker(wedged)).toBe("stalled 720s, in-flight: ipython");

		// An explicit stalled activity outranks the excuse: the label decision is the producer's,
		// and a renderer must not silently overrule it.
		const labelled = child({ activity: { kind: "stalled" }, stall: stall({ excused: true }) });
		expect(isStalledSubagentSnapshot(labelled)).toBe(true);
		expect(formatSubagentStallMarker(labelled)).toContain("stalled");
	});

	it("says long-running in the agents view instead of stalled, and keeps the duration honest", () => {
		const cases: [string, RlmChildStallState, string][] = [
			["excused", stall({ excused: true, excusedReasons: ["live_bash_handles"] }), "long-running 12m"],
			["not excused", stall(), "stalled 12m"],
			// Unsettled wins over excused: the abort fired and the run never stopped.
			["excused but unsettled", stall({ excused: true, unsettled: true }), "stalled 12m, abort did not settle"],
			["sub-minute silence", stall({ silentMs: 45_000, excused: true }), "long-running 45s"],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [name, facts, expected] of cases) {
			const [row] = buildAgentsViewRows([summary({ stall: facts })]);
			expect(row?.statusLabel, name).toBe(expected);
		}
	});

	it("still counts an excused child as busy, so it is not advertised as free capacity", () => {
		// The activity label stays the child's real one, which keeps the roster's busy count honest:
		// excusing the silence must not make a wedged-looking child look available.
		const excused = child({ stall: stall({ excused: true }) });
		expect(excused.activity).toMatchObject({ kind: "executing" });
		const [row] = buildAgentsViewRows([summary({ stall: stall({ excused: true }) })]);
		expect(row?.section).toBe("running");
	});
});
