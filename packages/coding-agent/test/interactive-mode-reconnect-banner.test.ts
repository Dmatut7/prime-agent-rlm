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
 * w13 lane, QA finding 2: after a deliberate `prime-agent shutdown`, the
 * "正在重连…" banner sat unchanged for the whole 5.5-minute fast budget — no
 * reason, no attempt count, and nothing saying the daemon will not come back
 * by itself, while the SIGKILL comparison path showed recovery text. The
 * tombstone path must feed its reason into the banner chain honestly.
 *
 * Driven through the real subscribeToAgent on a partial-mode fake, the same
 * harness pattern as interactive-mode-quota-park.test.ts.
 */

function bannerFake(): ModeFake {
	const fake: ModeFake = {
		chatContainer: new Container(),
		statusContainer: new Container(),
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		connectionLost: false,
		daemonConnectionDown: false,
		ui: { requestRender: vi.fn() },
		agentConnection: {
			subscribe: vi.fn((listener: (event: AgentConnectionEvent) => Promise<void>) => listener),
			listHeartbeats: vi.fn(async () => []),
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

describe("reconnect banner honesty (w13 QA finding 2)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("a deliberate-stop reconnecting status says why and that the daemon will not restart itself", async () => {
		const mode = bannerFake();

		proto.subscribeToAgent.call(mode);
		await dispatch(mode, {
			type: "connection_status",
			status: "reconnecting",
			daemonStopped: true,
			error: "The Prime Agent daemon on /tmp/x.sock was shut down deliberately; this window will reconnect once the daemon is started again.",
		});

		expect(chatText(mode)).toContain("手动停止");
		expect(chatText(mode)).toContain("不会再自动重启");
	});

	it("a background retry attempt still counts its attempts, in the session's language", async () => {
		const mode = bannerFake();

		proto.subscribeToAgent.call(mode);
		await dispatch(mode, { type: "connection_status", status: "reconnecting", backgroundAttempt: 3 });

		expect(chatText(mode)).toContain("第 3 次");
		expect(chatText(mode)).not.toContain("attempt 3");
	});
});
