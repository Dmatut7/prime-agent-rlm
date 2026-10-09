import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ModeFake = Record<string, unknown>;

type RestoreHandoffPastedInput = (this: ModeFake) => void;

const proto = InteractiveMode.prototype as unknown as {
	restoreHandoffPastedInput: RestoreHandoffPastedInput;
};

const handoffInput = vi.hoisted(() => ({ buffer: undefined as { text: string; truncated: boolean } | undefined }));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		takePendingHandoffInput: () => {
			const buffered = handoffInput.buffer;
			handoffInput.buffer = undefined;
			return buffered;
		},
	};
});

/**
 * w13 lane, QA finding 4 (safety): a paste during the session-list switch
 * window was silently discarded (3/3 repro), and in the worst case its unread
 * tail executed line by line in the user's shell after the TUI died. The
 * terminal layer now buffers handoff input; the session that starts after the
 * window must recover the pasted text into its editor (or the prompt stash
 * when the editor is not empty) so the paste is not lost.
 *
 * Driven through the real prototype method on a partial-mode fake, the same
 * harness pattern as interactive-mode-quota-park.test.ts.
 */

function pasteFake(overrides: ModeFake = {}): ModeFake {
	const editorState = { text: "" };
	const fake: ModeFake = {
		chatContainer: new Container(),
		statusContainer: new Container(),
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		editor: {
			getText: () => editorState.text,
			setText: (text: string) => {
				editorState.text = text;
			},
		},
		promptStashState: {},
		ui: { requestRender: vi.fn() },
		...overrides,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function chatText(mode: ModeFake): string {
	return stripAnsi((mode.chatContainer as Container).render(120).join("\n"));
}

describe("handoff paste recovery (w13 QA finding 4)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		handoffInput.buffer = undefined;
	});

	it("restores a buffered bracketed paste into the empty editor of the next session", () => {
		// A paste that arrived while the switch window was open, as the terminal
		// layer captured it.
		handoffInput.buffer = { text: "\x1b[200~line 1\nline 2\nline 3\x1b[201~", truncated: false };
		const mode = pasteFake();

		expect(() => proto.restoreHandoffPastedInput.call(mode)).not.toThrow();

		expect((mode.editor as { getText: () => string }).getText()).toBe("line 1\nline 2\nline 3");
		expect(chatText(mode)).toContain("已恢复");
	});

	it("stashes the paste instead of clobbering a non-empty editor", () => {
		handoffInput.buffer = { text: "\x1b[200~pasted during window\x1b[201~", truncated: false };
		const mode = pasteFake({
			editor: {
				getText: () => "already typed",
				setText: vi.fn(),
			},
		});

		proto.restoreHandoffPastedInput.call(mode);

		expect((mode.editor as { setText: ReturnType<typeof vi.fn> }).setText).not.toHaveBeenCalled();
		const stashState = mode.promptStashState as { stash?: { text: string }; queuedStashes?: { text: string }[] };
		expect(
			stashState.stash?.text === "pasted during window" ||
				stashState.queuedStashes?.some((entry) => entry.text === "pasted during window"),
		).toBe(true);
	});

	it("raw keystrokes captured in the window are not replayed into the editor", () => {
		handoffInput.buffer = { text: "x\x1b[B\rq", truncated: false };
		const mode = pasteFake();

		proto.restoreHandoffPastedInput.call(mode);

		expect((mode.editor as { getText: () => string }).getText()).toBe("");
	});

	it("an unbracketed bulk paste from the window is recovered too", () => {
		// stop() turns bracketed paste off during the handoff, so a terminal that
		// honors ?2004l delivers the paste as plain bulk text — the tui's own
		// stdin buffer treats such runs as paste-like, and so must the recovery.
		// CR/CRLF are the source text's line endings and fold into LF.
		handoffInput.buffer = {
			text: "bulk paste line A\r\nbulk paste line B\rbulk paste line C",
			truncated: false,
		};
		const mode = pasteFake();

		proto.restoreHandoffPastedInput.call(mode);

		expect((mode.editor as { getText: () => string }).getText()).toBe(
			"bulk paste line A\nbulk paste line B\nbulk paste line C",
		);
		expect(chatText(mode)).toContain("已恢复");
	});

	it("short keystroke noise is not mistaken for a paste", () => {
		handoffInput.buffer = { text: "abc", truncated: false };
		const mode = pasteFake();

		proto.restoreHandoffPastedInput.call(mode);

		expect((mode.editor as { getText: () => string }).getText()).toBe("");
	});

	it("nothing buffered: no status line, editor untouched", () => {
		const mode = pasteFake();

		proto.restoreHandoffPastedInput.call(mode);

		expect((mode.editor as { getText: () => string }).getText()).toBe("");
		expect(chatText(mode)).toBe("");
	});
});
