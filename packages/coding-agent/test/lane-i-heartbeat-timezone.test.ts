/**
 * R3-M9: one heartbeat `nextRunAt`, one clock face. The management panel used
 * to print UTC (`toISOString().slice(0, 16)`) while the chat panel printed
 * `toLocaleString()` and the status lines printed the raw ISO string - the
 * same job showed three answers eight hours apart for a Shanghai user.
 *
 * The timezone is pinned to Asia/Shanghai so the assertion holds on any
 * machine: a UTC developer's local time would otherwise equal the old UTC
 * output and the regression would be invisible.
 */
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionHeartbeat } from "../src/modes/agent-connection/types.js";
import { HeartbeatManagerComponent } from "../src/modes/interactive/components/heartbeat-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { formatScheduleTimestamp } from "../src/utils/schedule-timestamp.js";

const originalTz = process.env.TZ;

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function heartbeat(nextRunAt: string): AgentConnectionHeartbeat {
	return {
		job: {
			id: "user",
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-user",
			sessionId: "session-user",
			sessionFile: "/tmp/user.jsonl",
			cwd: "/tmp",
			prompt: "p",
			// Short labels keep the detail line inside the panel's truncation budget,
			// so the assertion sees the whole `next <timestamp>` span.
			schedule: { kind: "interval", expression: "5m", intervalMs: 300_000 },
			createdAt: "2026-07-15T10:00:00.000Z",
			updatedAt: "2026-07-15T10:00:00.000Z",
			nextRunAt,
			runCount: 2,
		},
		sessionName: "S",
	} satisfies AgentConnectionHeartbeat;
}

describe("formatScheduleTimestamp (R3-M9)", () => {
	beforeAll(() => {
		process.env.TZ = "Asia/Shanghai";
	});

	afterAll(() => {
		if (originalTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTz;
		}
	});

	it("formats an ISO timestamp in the local timezone, not UTC", () => {
		// 10:05 UTC is 18:05 in Asia/Shanghai; the old code printed 10:05.
		expect(formatScheduleTimestamp("2026-07-15T10:05:00.000Z")).toBe("2026-07-15 18:05");
		expect(formatScheduleTimestamp("2026-01-01T00:30:00.000Z")).toBe("2026-01-01 08:30");
	});

	it("pads month, day, hour and minute and passes an unparseable value through", () => {
		expect(formatScheduleTimestamp("2026-03-02T01:02:00.000Z")).toBe("2026-03-02 09:02");
		expect(formatScheduleTimestamp("not a date")).toBe("not a date");
	});
});

describe("heartbeat management panel clock face (R3-M9)", () => {
	beforeAll(() => {
		process.env.TZ = "Asia/Shanghai";
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		if (originalTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTz;
		}
	});

	it("shows the next run in the same local time the chat panel uses", () => {
		const component = new HeartbeatManagerComponent({
			getHeartbeats: () => [heartbeat("2026-07-15T10:05:00.000Z")],
			getRows: () => 20,
			onAction: async () => {},
			onClose: () => {},
			requestRender: () => {},
		});
		// Open the first row's action panel: its detail line carries `next <time>`.
		component.handleInput("\r");
		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain("next 2026-07-15 18:05");
		expect(output).not.toContain("next 2026-07-15 10:05");
	});
});
