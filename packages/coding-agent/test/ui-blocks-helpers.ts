import type { AssistantMessage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { vi } from "vitest";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { initTheme, type ThemeBg, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";

export const T0 = 1_700_000_000_000;

function usage(output: number): AssistantMessage["usage"] {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
	model = "glm-5.3-prime",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model,
		usage: usage(0),
		stopReason,
		timestamp,
	};
}

export function host(overrides: Partial<TimelineHost> = {}): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 60,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
		...overrides,
	};
}

export type QuietTurn = ReturnType<typeof quietTurn>;

/** A quiet turn with its box, the way the interactive mode builds one. */
export function quietTurn(options: { live?: boolean; host?: TimelineHost; startedAt?: number } = {}) {
	const state = new TurnActivityState(options.startedAt ?? Date.now() - 5_000);
	if (options.live !== false) state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(options.host ?? host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

/** One ipython tool call inside an assistant message, registered on the turn. */
export function addStep(
	turn: QuietTurn,
	id: string,
	code: string,
	status: "queued" | "running" | "done" | "error" = "done",
	timestamp = Date.now() - 4_000,
): void {
	turn.timeline.noteMessage(
		assistant(timestamp, [{ type: "toolCall", id, name: "ipython", arguments: { code } }]),
		status !== "running" && status !== "queued",
	);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code }, status: "queued" });
	if (status !== "queued") turn.state.setStepStatus(id, "running", timestamp);
	if (status === "done" || status === "error") turn.state.setStepStatus(id, status, timestamp + 500);
}

/** A finished command step whose kernel record carries `label` and its output. */
export function addCommand(
	turn: QuietTurn,
	id: string,
	label: string,
	options: { output?: string; ok?: boolean; detail?: string } = {},
): void {
	addStep(turn, id, `await bash(${JSON.stringify(label)})`);
	turn.timeline.mergeStep(
		id,
		"ipython",
		{},
		{
			details: {
				activities: [
					{
						id: `${id}-a`,
						kind: "command",
						label,
						status: options.ok === false ? "error" : "ok",
						detail: options.detail ?? "done",
						startedAt: 1,
						endedAt: 2,
					},
				],
				...(options.output ? { stdout: options.output } : {}),
			},
		},
		false,
	);
}

export const plain = (lines: readonly string[]): string[] =>
	lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
export const text = (lines: readonly string[]): string => plain(lines).join("\n");

/** Truecolor, so two neighbouring background colors never collapse into one 256-color step. */
export function useTruecolorTheme(): () => void {
	const previous = process.env.COLORTERM;
	process.env.COLORTERM = "truecolor";
	initTheme("prime");
	return () => {
		if (previous === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = previous;
	};
}

export function hasBg(line: string, color: ThemeBg): boolean {
	return line.includes(theme.getBgAnsi(color));
}

export function hasFg(line: string, color: ThemeColor): boolean {
	return line.includes(theme.getFgAnsi(color));
}

/** The foreground escape that paints in a background color's own color (the block's separator row). */
export function bgAsFg(color: ThemeBg): string {
	return theme.getBgAnsi(color).replace("\x1b[48;", "\x1b[38;");
}

/** The box's own header is line 2 of a turn (after the `◆ prime` line and the top border): the body starts below it. */
const FIRST_BODY_LINE = 4;

/** The index of the first body line (never the header) whose plain text contains `needle`, or -1. */
export function lineIndexWith(lines: readonly string[], needle: string): number {
	const index = plain(lines).findIndex((line, at) => at >= FIRST_BODY_LINE && line.includes(needle));
	return index;
}

/** The first body line (raw, with colors) whose plain text contains `needle`. */
export function rawLineWith(lines: readonly string[], needle: string): string {
	const index = lineIndexWith(lines, needle);
	if (index < 0) throw new Error(`no line contains ${needle}`);
	return lines[index] ?? "";
}

/** A finished step of `activities` (kernel records) on the turn. */
export function addActivities(
	turn: QuietTurn,
	id: string,
	activities: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): void {
	addStep(turn, id, "await work()");
	turn.timeline.mergeStep(id, "ipython", {}, { details: { activities, ...extra } }, false);
}

export function addThought(turn: QuietTurn, textOfThought: string, timestamp = Date.now() - 3_000): void {
	turn.timeline.noteMessage(assistant(timestamp, [{ type: "thinking", thinking: textOfThought }]), true);
}

/** A reply that says something and then calls a step: the words before the step become a note row. */
export function addSay(turn: QuietTurn, words: string, id: string, timestamp = Date.now() - 2_000): void {
	turn.timeline.noteMessage(
		assistant(timestamp, [
			{ type: "text", text: words },
			{ type: "toolCall", id, name: "ipython", arguments: { code: "await bash('true')" } },
		]),
		true,
	);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code: "await bash('true')" }, status: "queued" });
	turn.state.setStepStatus(id, "running", timestamp);
	turn.state.setStepStatus(id, "done", timestamp + 500);
}
