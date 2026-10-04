import { beforeAll, describe, expect, test, vi } from "vitest";
import { MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE } from "../src/core/agent-session.js";
import type { CustomMessage } from "../src/core/messages.js";
import type { AgentConnectionEvent, AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * wave-44 FOOTER-MODEL: when another daemon client or an extension switches the
 * session model, the witness window gets the wave-42 chat notice - but the
 * footer kept naming the old model until some later lazy refresh re-read the
 * state. The notice must re-read the serving model at once, exactly like the
 * provider-fallback notice already does, so the footer's pull source
 * (connectionState.model via the telemetry memo) shows the new model on the
 * same frame the chat line lands.
 */

type Listener = (event: AgentConnectionEvent) => Promise<void>;

const mode = InteractiveMode.prototype as unknown as {
	subscribeToAgent(this: object): void;
};

const previousModel = { provider: "faux", id: "faux-old" };
const servingModel = { provider: "faux", id: "faux-new" };

function createWitness() {
	const noop = () => {};
	const errors: string[] = [];
	let listener: Listener | undefined;
	const getState = vi.fn(async () => ({
		sessionId: "s1",
		model: servingModel,
		serviceTier: "default",
		availableThinkingLevels: [],
	}));
	const host = {
		isInitialized: true,
		sessionEventQueue: Promise.resolve(),
		sessionEventGeneration: 0,
		connectionState: { sessionId: "s1", model: previousModel },
		footer: { invalidate: noop },
		activityTracker: new AgentActivityTracker(),
		ui: { requestRender: noop },
		turnFlow: { customMessage: () => false },
		addMessageToChat: noop,
		showError: (message: string) => errors.push(message),
		updateConnectionStateFromEvent: noop,
		updateWorkingLoaderMessage: noop,
		updateWorkingPulse: noop,
		updateEditorBorderColor: noop,
		setupAutocompleteProvider: noop,
		invalidateFooterTelemetry: vi.fn(),
		enforceChatComponentCap: noop,
		featureHintRunPending: false,
		agentConnection: {
			subscribe(next: Listener) {
				listener = next;
				return noop;
			},
			getState,
		},
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	mode.subscribeToAgent.call(host);
	return {
		host,
		errors,
		getState,
		send: (event: AgentConnectionSessionEvent) => {
			if (!listener) throw new Error("not subscribed");
			return listener({ type: "session_event", event });
		},
	};
}

function originNotice(): CustomMessage {
	return {
		role: "custom",
		customType: MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
		content: `模型已切换为「${servingModel.provider}/${servingModel.id}」（由另一个窗口或客户端发起）。`,
		display: true,
		details: { provider: servingModel.provider, modelId: servingModel.id, origin: "daemon_command" },
		timestamp: 1,
	};
}

describe("footer model after a witnessed model switch", () => {
	beforeAll(() => initTheme("dark"));

	test("the origin notice re-reads the serving model so the footer shows it now", async () => {
		const witness = createWitness();
		await witness.send({ type: "message_start", message: originNotice() });
		await vi.waitFor(() => {
			expect(witness.host.connectionState.model).toEqual(servingModel);
		});
		expect(witness.getState).toHaveBeenCalled();
		expect(witness.host.invalidateFooterTelemetry).toHaveBeenCalled();
		expect(witness.errors).toEqual([]);
	});

	test("an unrelated custom message does not re-read the serving model", async () => {
		const witness = createWitness();
		await witness.send({
			type: "message_start",
			message: { role: "custom", customType: "some_extension_notice", content: "hi", display: true, timestamp: 1 },
		});
		// Flush the microtask queue: a fired-and-forgotten refresh would land here.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(witness.getState).not.toHaveBeenCalled();
		expect(witness.host.invalidateFooterTelemetry).not.toHaveBeenCalled();
		expect(witness.errors).toEqual([]);
	});
});
