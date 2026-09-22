import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { type CustomMessage, IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

const IMAGE = { type: "image" as const, mimeType: "image/png", data: "aGk=" };

function usageFor(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

interface StreamStep {
	usage?: Partial<Usage>;
	api?: AssistantMessage["api"];
	stopReason?: AssistantMessage["stopReason"];
	content?: AssistantMessage["content"];
}

/**
 * A turn whose committed batch carries images, answered by a scripted provider
 * response. The response's `api` decides whether the usage schema even has an
 * image token count to miss: only openai-completions reports
 * prompt_tokens_details.image_tokens.
 */
function createSuspicionSession(
	steps: StreamStep[],
	options: { firstResponse?: Partial<AssistantMessage> } = {},
): {
	session: AgentSession;
	streamCalls: () => number;
	dir: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "pi-image-delivery-suspicion-"));
	let call = 0;
	const streamCalls = () => call;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getModel("anthropic", "claude-opus-4-7")!, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const step = steps[Math.min(call, steps.length - 1)];
			call += 1;
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(e) => e.type === "done",
				(e: any) => e.message,
			);
			const message: AssistantMessage = {
				...assistantMsg("answer"),
				api: step.api ?? "openai-completions",
				usage: usageFor(step.usage),
				stopReason: step.stopReason ?? "stop",
				content: step.content ?? [{ type: "text", text: "answer" }],
				...(call === 1 ? options.firstResponse : {}),
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	const auth = AuthStorage.create(join(dir, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(dir, dir),
		cwd: dir,
		modelRegistry: ModelRegistry.create(auth, join(dir, "models.json")),
		resourceLoader: createTestResourceLoader(),
		customTools: [
			{
				name: "noop",
				label: "No-op",
				description: "Finishes without doing anything",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			},
		],
	});
	return { session, streamCalls, dir };
}

function suspicionNotices(session: AgentSession): CustomMessage[] {
	return session.messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE,
	);
}

it("notices when an image-carrying turn completes without an image token count", async () => {
	const fixture = createSuspicionSession([{ usage: {} }]);
	try {
		await fixture.session.prompt("describe", { images: [IMAGE] });

		const notices = suspicionNotices(fixture.session);
		expect(notices).toHaveLength(1);
		expect(notices[0].content).toContain("may not have received the images");
		expect(notices[0].details).toMatchObject({
			model: "test",
			provider: "anthropic",
			stopReason: "stop",
			evidence: "usage.prompt_tokens_details.image_tokens absent",
		});
		expect(typeof (notices[0].details as { measuredAt?: string }).measuredAt).toBe("string");
	} finally {
		fixture.session.dispose();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

it("does not notice when the usage reports the image token count", async () => {
	const fixture = createSuspicionSession([{ usage: { imageTokens: 872 } }]);
	try {
		await fixture.session.prompt("describe", { images: [IMAGE] });

		expect(suspicionNotices(fixture.session)).toHaveLength(0);
	} finally {
		fixture.session.dispose();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

it("does not notice on APIs whose usage schema has no image token count", async () => {
	const fixture = createSuspicionSession([{ api: "anthropic-messages", usage: {} }]);
	try {
		await fixture.session.prompt("describe", { images: [IMAGE] });

		expect(suspicionNotices(fixture.session)).toHaveLength(0);
	} finally {
		fixture.session.dispose();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

it("does not notice on image-free turns or on responses that did not complete cleanly", async () => {
	// Image-free batch: nothing image-carrying was requested.
	const noImages = createSuspicionSession([{ usage: {} }]);
	try {
		await noImages.session.prompt("describe");
		expect(suspicionNotices(noImages.session)).toHaveLength(0);
	} finally {
		noImages.session.dispose();
		rmSync(noImages.dir, { recursive: true, force: true });
	}

	// An errored response is not a clean 2xx completion: its usage is absent by
	// construction, not by dropped images.
	const errored = createSuspicionSession([{ usage: {}, stopReason: "error" }]);
	try {
		await errored.session.prompt("describe", { images: [IMAGE] });
		expect(suspicionNotices(errored.session)).toHaveLength(0);
	} finally {
		errored.session.dispose();
		rmSync(errored.dir, { recursive: true, force: true });
	}
});

it("notifies at most once per committed batch and re-arms for the next one", async () => {
	// A genuine multi-call turn: the first response calls a tool, the tool
	// result triggers the second model call, and both responses repeat the
	// missing count - the batch already spent its one notice.
	const fixture = createSuspicionSession([{ usage: {} }, { usage: {} }], {
		firstResponse: {
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }],
		},
	});
	try {
		await fixture.session.prompt("describe", { images: [IMAGE] });
		expect(fixture.streamCalls()).toBe(2);
		expect(suspicionNotices(fixture.session)).toHaveLength(1);

		await fixture.session.prompt("look again", { images: [IMAGE] });
		expect(fixture.streamCalls()).toBe(3);
		expect(suspicionNotices(fixture.session)).toHaveLength(2);
	} finally {
		fixture.session.dispose();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
