import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	refreshAgentsViewRowTimeLabels,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "heard-from",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "heard-from-session",
		sessionFile: "/tmp/heard-from.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

const T0 = new Date("2026-09-12T12:00:00.000Z");

describe("refreshAgentsViewRowTimeLabels", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("moves an age label forward without rebuilding the row set", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const heard = summary({ lastHeardFromAt: new Date(T0.getTime() - 30_000).toISOString() });
		const rows = buildAgentsViewRows([heard]);
		expect(rows[0]!.statusLabel).toBe("last heard 30s ago");
		const built = rows[0];

		vi.setSystemTime(new Date(T0.getTime() + 5_000));
		expect(refreshAgentsViewRowTimeLabels(rows)).toBe(true);
		expect(rows[0]!.statusLabel).toBe("last heard 35s ago");
		// In place: the tick must not allocate a new row set (that is the whole
		// cost being removed), and the result must equal a rebuild at this instant.
		expect(rows[0]).toBe(built);
		expect(buildAgentsViewRows([heard])[0]!.statusLabel).toBe(rows[0]!.statusLabel);

		// Nothing moved: no change, so no render is owed.
		expect(refreshAgentsViewRowTimeLabels(rows)).toBe(false);
	});

	it("re-derives the quiet-duration label the same way a rebuild would", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const working = summary({
			id: "quiet",
			sessionId: "quiet-session",
			isStreaming: true,
			lastActivityAt: new Date(T0.getTime() - 10 * 60_000).toISOString(),
		});
		const rows = buildAgentsViewRows([working]);
		expect(rows[0]!.statusLabel).toContain("(no activity 10m)");

		vi.setSystemTime(new Date(T0.getTime() + 60_000));
		expect(refreshAgentsViewRowTimeLabels(rows)).toBe(true);
		expect(rows[0]!.statusLabel).toContain("(no activity 11m)");
		expect(rows[0]!.statusLabel).toBe(buildAgentsViewRows([working])[0]!.statusLabel);
	});

	it("leaves synthetic rows alone instead of inheriting the parent's label", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const parent = summary({ lastHeardFromAt: new Date(T0.getTime() - 30_000).toISOString() });
		const synthetic: AgentsViewRow[] = [
			{
				kind: "subagent-summary",
				section: "idle",
				summary: parent,
				title: "3 subagents",
				subtitle: "",
				statusLabel: "",
				depth: 1,
				selectable: true,
				runningSubagentCount: 0,
				recursiveCost: 0,
				descendantCount: 0,
				identity: "subagents:heard-from",
			},
			{
				kind: "subagent-code",
				section: "idle",
				summary: parent,
				title: "",
				subtitle: "",
				statusLabel: "",
				depth: 1,
				selectable: false,
				runningSubagentCount: 0,
				recursiveCost: 0,
				descendantCount: 0,
				identity: "code:heard-from:0:0",
				code: "await rlm('x')",
			},
		];

		vi.setSystemTime(new Date(T0.getTime() + 60_000));
		expect(refreshAgentsViewRowTimeLabels(synthetic)).toBe(false);
		expect(synthetic.map((row) => row.statusLabel)).toEqual(["", ""]);
	});

	it("reports no change for a row set with nothing time-derived", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const rows = buildAgentsViewRows([summary()]);
		expect(rows[0]!.statusLabel).toBe("needs input");
		vi.setSystemTime(new Date(T0.getTime() + 600_000));
		expect(refreshAgentsViewRowTimeLabels(rows)).toBe(false);
	});
});
