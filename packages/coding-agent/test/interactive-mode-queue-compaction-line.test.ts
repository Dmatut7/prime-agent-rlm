import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Drive the real queue renderer through the same seam the existing
// interactive-mode tests use: pull the private method off the prototype and
// call it against a minimal stand-in. No real provider, no real TUI.
const updatePendingMessagesDisplay = Reflect.get(InteractiveMode.prototype, "updatePendingMessagesDisplay") as (
	this: unknown,
) => void;

type QueueTestContext = {
	pendingMessagesContainer: Container;
	pendingBashComponents: unknown[];
	queuedMessagesContainer: Container;
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	isRecognizedSlashCommand(name: string): boolean;
	isAgentStreaming(): boolean;
	isAgentCompacting(): boolean;
	getAppKeyDisplay(action: string): string;
	featureHintSuppressedByQueue: boolean;
	clearFeatureHintPresentation(): void;
	resumeFeatureHintPresentation(): void;
};

function createContext(queues: { steering: string[]; followUp: string[] }, compacting: boolean): QueueTestContext {
	return {
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		queuedMessagesContainer: new Container(),
		getAllQueuedMessages: () => queues,
		isRecognizedSlashCommand: () => false,
		isAgentStreaming: () => true,
		isAgentCompacting: () => compacting,
		getAppKeyDisplay: () => "ctrl-o",
		featureHintSuppressedByQueue: true,
		clearFeatureHintPresentation: vi.fn(),
		resumeFeatureHintPresentation: vi.fn(),
	};
}

function renderQueue(context: QueueTestContext): string {
	updatePendingMessagesDisplay.call(context);
	return stripAnsi(context.queuedMessagesContainer.render(120).join("\n"));
}

describe("InteractiveMode queue compaction header", () => {
	beforeAll(() => initTheme("dark"));

	const queued = { steering: ["steer one", "steer two"], followUp: [] };

	test("shows a compaction header with the queued count while compacting", () => {
		const text = renderQueue(createContext(queued, true));
		const assertionLines = [queued.steering, queued.followUp].flat();
		expect(assertionLines.length).toBeGreaterThan(0);
		expect(text).toContain("compacting context");
		expect(text).toContain(`${assertionLines.length} queued`);
		// The header sits above the message previews that describe what is waiting.
		expect(text.indexOf("compacting context")).toBeLessThan(text.indexOf("steer one"));
	});

	test("omits the compaction header when not compacting", () => {
		const text = renderQueue(createContext(queued, false));
		expect(queued.steering.length).toBeGreaterThan(0);
		expect(text).not.toContain("compacting context");
		// The previews still render, so the only difference is the missing header.
		expect(text).toContain("steer one");
	});

	test("omits the compaction header while compacting with an empty queue", () => {
		const empty = createContext({ steering: [], followUp: [] }, true);
		const text = renderQueue(empty);
		// No queued messages means the whole queue block (header included) is absent.
		expect(text).not.toContain("compacting context");
		expect(empty.queuedMessagesContainer.children).toHaveLength(0);
	});

	test("counts steering and follow-up messages together in the header", () => {
		const mixed = createContext({ steering: ["a"], followUp: ["b", "c"] }, true);
		const text = renderQueue(mixed);
		expect(text).toContain("3 queued");
	});
});
