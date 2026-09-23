import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	[key: string]: unknown;
};

type Prototype = {
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function makeSubmitContext() {
	const prompt = vi.fn(async () => undefined);
	let editorText = "";
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
		},
		agentConnection: { prompt },
		showError: vi.fn(),
		showStatus: vi.fn(),
		echoLocalCommand: vi.fn(),
		handleSessionCommand: vi.fn(async () => undefined),
		showTreeSelector: vi.fn(async () => undefined),
		showSettingsSelector: vi.fn(async () => undefined),
		showHeartbeatManager: vi.fn(async () => undefined),
		submittedInputBehavior: "steer",
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		pendingPromptStashReleases: [],
		promptStashState: {},
		pendingSubmittedPromptStash: undefined,
		snapshotPromptStash: vi.fn(() => ({ text: "" })),
		promptStash: undefined,
		promptStashSessionId: "session-1",
		sessionId: "session-1",
		clearShortcutGuide: vi.fn(),
		clearSideQuestion: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		collectImagesFor: vi.fn(() => []),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return context;
}

// Rebuilt from upstream eee9d814b for the /speed command. Upstream's sibling
// tests assert the 292ae3028 usage-error unification ("/tree with args shows
// Usage: /tree"); the fork's selective merge 67334bf1a kept its own guards
// (args to guarded commands fall through to the model, /heartbeats ignores
// them), so those tests are adapted here to pin the fork behavior.
describe("InteractiveMode no-argument command usage", () => {
	beforeAll(() => initTheme("dark"));

	it("sends arguments to guarded /tree, /settings, and /session to the model instead of erroring", async () => {
		for (const command of ["tree", "settings", "session"]) {
			const context = makeSubmitContext();
			const prompt = (context.agentConnection as { prompt: ReturnType<typeof vi.fn> }).prompt;
			prototype.setupEditorSubmitHandler.call(context);
			await context.defaultEditor.onSubmit?.(`/${command} stray argument`);
			expect(prompt).toHaveBeenCalledWith(
				`/${command} stray argument`,
				expect.objectContaining({ streamingBehavior: "steer", queueIfBusy: true }),
			);
			expect(context.showError).not.toHaveBeenCalled();
			expect(context.showTreeSelector).not.toHaveBeenCalled();
			expect(context.showSettingsSelector).not.toHaveBeenCalled();
			expect(context.handleSessionCommand).not.toHaveBeenCalled();
		}
	});

	it("still opens the tree selector without arguments", async () => {
		const context = makeSubmitContext();
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/tree");
		expect(context.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("opens the heartbeat manager and ignores arguments to /heartbeats", async () => {
		const context = makeSubmitContext();
		const prompt = (context.agentConnection as { prompt: ReturnType<typeof vi.fn> }).prompt;
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/heartbeats stray argument");
		expect(context.showHeartbeatManager).toHaveBeenCalledTimes(1);
		expect(context.showError).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("toggles /speed on and off, parses explicit args, and rejects invalid arguments", async () => {
		const context = makeSubmitContext();
		Object.setPrototypeOf(context, InteractiveMode.prototype); // runs the real setSpeedDisplay
		const footer = { setSpeedEnabled: vi.fn(), setSpeedText: vi.fn() };
		Object.assign(context, { footer, speedDisplayEnabled: false });
		Object.assign(context, { ui: { requestRender: vi.fn() }, uiServices: { settingsManager: {} } });
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/speed");
		expect(footer.setSpeedEnabled).toHaveBeenLastCalledWith(true);
		await context.defaultEditor.onSubmit?.("/speed off");
		expect(footer.setSpeedEnabled).toHaveBeenLastCalledWith(false);
		expect(footer.setSpeedText).toHaveBeenCalledWith(undefined);
		await context.defaultEditor.onSubmit?.("/speed banana");
		expect(context.showError).toHaveBeenCalledWith("用法：/speed [on|off]");
		expect((context.agentConnection as { prompt: ReturnType<typeof vi.fn> }).prompt).not.toHaveBeenCalled();
	});
});
