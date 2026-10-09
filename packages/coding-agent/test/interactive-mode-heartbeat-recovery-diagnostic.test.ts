import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type SubscribeToAgent = (this: ModeFake) => void;

const proto = InteractiveMode.prototype as unknown as {
	subscribeToAgent: SubscribeToAgent;
};

/**
 * w13 lane, QA finding 3: after a crash auto-recovery, the diagnostic
 * "出错：Cannot list heartbeats while session worker is recovering" stayed on
 * screen for six minutes — the refresh at the reconnect succeeded later but
 * nothing cleared the line. The diagnostic must leave once the catalog
 * refresh succeeds again (recovery done ⇒ heartbeats listable).
 *
 * Driven through the real subscribeToAgent on a partial-mode fake, the same
 * harness pattern as interactive-mode-quota-park.test.ts.
 */

function heartbeatFake(): ModeFake {
	const fake: ModeFake = {
		chatContainer: new Container(),
		statusContainer: new Container(),
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		connectionLost: false,
		daemonConnectionDown: false,
		heartbeatCatalog: undefined,
		heartbeatRefreshPromise: undefined,
		heartbeatRefreshRequested: false,
		scheduleHeartbeatManagerRefresh: vi.fn(),
		updateSubagentSummaryLine: vi.fn(),
		ui: { requestRender: vi.fn() },
		agentConnection: {
			subscribe: vi.fn((listener: (event: AgentConnectionEvent) => Promise<void>) => listener),
			listHeartbeats: vi.fn(async () => [] as never[]),
		},
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function dispatch(fake: ModeFake, event: AgentConnectionEvent): Promise<void> {
	const captured = (fake as { agentConnection: { subscribe: ReturnType<typeof vi.fn> } }).agentConnection.subscribe
		.mock.calls[0]?.[0] as ((event: AgentConnectionEvent) => Promise<void>) | undefined;
	if (!captured) throw new Error("subscribeToAgent did not register a listener");
	return captured(event);
}

function chatText(mode: ModeFake): string {
	return stripAnsi((mode.chatContainer as Container).render(120).join("\n"));
}

describe("heartbeat catalog recovery diagnostic (w13 QA finding 3)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("clears the recovering-worker diagnostic once a heartbeat refresh succeeds again", async () => {
		const mode = heartbeatFake();
		const listHeartbeats = (mode as { agentConnection: { listHeartbeats: ReturnType<typeof vi.fn> } }).agentConnection
			.listHeartbeats;

		proto.subscribeToAgent.call(mode);

		// Recovery reconnected, but the worker was still recovering: the refresh
		// failed and the diagnostic went up.
		listHeartbeats.mockRejectedValueOnce(new Error("Cannot list heartbeats while session worker is recovering"));
		await dispatch(mode, { type: "connection_status", status: "connected" });

		expect(chatText(mode)).toContain("Cannot list heartbeats");

		// The worker finished and the daemon announced the catalog changed: the
		// refresh now succeeds, and the stale diagnostic must leave with it.
		listHeartbeats.mockResolvedValueOnce([] as never[]);
		await dispatch(mode, { type: "heartbeats_changed" });

		expect(chatText(mode)).not.toContain("Cannot list heartbeats");
		expect(chatText(mode)).not.toContain("出错：");
	});

	it("keeps the diagnostic visible while the refresh keeps failing", async () => {
		const mode = heartbeatFake();
		const listHeartbeats = (mode as { agentConnection: { listHeartbeats: ReturnType<typeof vi.fn> } }).agentConnection
			.listHeartbeats;

		proto.subscribeToAgent.call(mode);

		listHeartbeats.mockRejectedValue(new Error("Cannot list heartbeats while session worker is recovering"));
		await dispatch(mode, { type: "connection_status", status: "connected" });
		await dispatch(mode, { type: "heartbeats_changed" });

		expect(chatText(mode)).toContain("Cannot list heartbeats");
	});
});
