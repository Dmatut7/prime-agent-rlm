import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type SubscribeToAgent = (this: ModeFake) => void;

type HandleAgentsBack = (this: ModeFake) => boolean;

type RequestAgentsView = (this: ModeFake) => Promise<void>;

const proto = InteractiveMode.prototype as unknown as {
	handleAgentsBack: HandleAgentsBack;
	subscribeToAgent: SubscribeToAgent;
	requestAgentsView: RequestAgentsView;
};

/**
 * QA swarm finding (w13 lane, item 1, must-fix): after the daemon is shut
 * down, pressing the agents-back key (the session list) tears the session UI
 * down, hands the terminal to the agents view, and the agents view's daemon
 * connect fails with a raw Node stack that kills the process. The gate under
 * test: a disconnected session must refuse to enter the list-switch flow and
 * say so in the status line instead.
 *
 * Driven through the real prototype methods on a partial-mode fake, the same
 * harness pattern as interactive-mode-quota-park.test.ts.
 */

function connectionDownFake(overrides: ModeFake = {}): ModeFake {
	const chatContainer = new Container();
	const fake: ModeFake = {
		chatContainer,
		statusContainer: new Container(),
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		connectionLost: false,
		daemonConnectionDown: false,
		isShuttingDown: false,
		agentsViewRequest: undefined,
		signalCleanupHandlers: [],
		editor: { getText: () => "" },
		promptStashState: {},
		fullscreenEnabled: false,
		ui: {
			requestRender: vi.fn(),
			terminal: { drainInput: vi.fn(async () => undefined) },
		},
		agentConnection: {
			subscribe: vi.fn((listener: (event: AgentConnectionEvent) => Promise<void>) => listener),
			dispose: vi.fn(async () => undefined),
			listHeartbeats: vi.fn(async () => []),
		},
		stop: vi.fn(),
		releasePromptStashSession: vi.fn(),
		options: {
			returnToAgentsView: true,
			onShutdown: undefined,
		},
		onInputCallback: undefined,
		...overrides,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	// The listener array is a test seam for dispatching connection events into
	// the real subscribe handler; the mode fake itself never reads it.
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

describe("agents-back gate on a dead daemon connection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses the list switch while the connection is down and says so in the status line", async () => {
		const mode = connectionDownFake();

		proto.subscribeToAgent.call(mode);
		await dispatch(mode, { type: "connection_status", status: "reconnecting" });

		expect(() => proto.handleAgentsBack.call(mode)).not.toThrow();
		expect(proto.handleAgentsBack.call(mode)).toBe(true);
		expect(chatText(mode)).toContain("会话列表");
		expect(mode.agentsViewRequest).toBeUndefined();
		expect(mode.isShuttingDown).toBeFalsy();
	});

	it("the gate opens again once the connection reports itself reconnected", async () => {
		const mode = connectionDownFake();

		proto.subscribeToAgent.call(mode);
		await dispatch(mode, { type: "connection_status", status: "reconnecting" });
		await dispatch(mode, { type: "connection_status", status: "connected", daemonVersion: undefined });

		expect(proto.handleAgentsBack.call(mode)).toBe(true);
		expect(mode.agentsViewRequest).toBe("agents_view");
	});

	it("the session-resume action refuses the same way while disconnected", async () => {
		const mode = connectionDownFake();

		proto.subscribeToAgent.call(mode);
		await dispatch(mode, { type: "connection_status", status: "reconnecting" });

		await proto.requestAgentsView.call(mode);

		expect(chatText(mode)).toContain("会话列表");
		expect(mode.agentsViewRequest).toBeUndefined();
		expect(mode.isShuttingDown).toBeFalsy();
	});
});
