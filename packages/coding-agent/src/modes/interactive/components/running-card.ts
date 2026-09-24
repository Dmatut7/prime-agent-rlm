import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { spinnerFrame } from "../theme/working-icon.js";
import { turnStepLabel, turnStepsSummary } from "./step-label.js";
import type { TurnActivityState, TurnStep } from "./turn-activity.js";
import { turnFootNoteDurationText, turnRunningClockText } from "./turn-footnote.js";

/**
 * The conversation's AI layer: every assistant turn opens with a `◆ prime`
 * header and runs down a thin gutter; while the turn is live, a tinted card
 * under the header says what the AI is doing this very moment, for how long,
 * and what it has done so far - so a busy turn never looks stuck, and a
 * quiet one says so in amber before the stall bar ever has to.
 */

/** Past this much silence the card turns amber and says how long nothing came out. */
export const RUNNING_CARD_QUIET_MS = 60_000;

/** Steps the card's last row lists. */
const RECENT_STEPS = 3;

/**
 * The rail every AI line starts with. One column: the lines it prefixes keep
 * their own leading space, so text reads `│ text`.
 */
export function assistantGutter(): string {
	return theme.fg("assistantGutter", "│");
}

export const ASSISTANT_GUTTER_WIDTH = 1;

/** The action the card's first row names, with the clocks behind it. */
export interface RunningAction {
	text: string;
	/** A trailing quote (the latest thinking sentence), rendered dim italic. */
	detail?: string;
	elapsedMs: number;
	quietMs: number;
}

/** The last sentence of a thinking trace, on one line. */
function lastThinkingSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "";
	const sentences = flat.split(/(?<=[。！？.!?])\s*/).filter((part) => part.trim().length > 0);
	return (sentences.at(-1) ?? flat).trim();
}

/** The query of a web-search cell: the first string literal after `.search`. */
function searchQuery(code: string): string | undefined {
	const match = /\.search\b\s*(?:\(|,)\s*[rRfF]?["']([^"'\n]{1,80})["']/.exec(code);
	return match?.[1];
}

function stepCode(step: TurnStep): string {
	const args = step.args as { code?: unknown } | undefined;
	return typeof args?.code === "string" ? args.code : "";
}

/** A step label as a present-tense action: `正在运行 npm test`, `正在联网搜索「q」`. */
export function runningStepText(step: TurnStep): string {
	const label = turnStepLabel(step);
	const code = stepCode(step);
	if (label.startsWith("联网搜索")) {
		const query = searchQuery(code);
		return query ? `正在联网搜索「${query}」` : "正在联网搜索";
	}
	// An awaited handle is only a subagent wait when the cell spawned through
	// rlm; `h = bash(...); await h` is a command.
	const awaitsSubagent = /\bawait\b/.test(code) && /\brlm\.\w+\(/.test(code) && !/\bbash\(/.test(code);
	if (/\brlm\.collect\(/.test(code) || awaitsSubagent || label.startsWith("查看子代理")) {
		const target = label.startsWith("查看子代理 ") ? label.slice("查看子代理 ".length) : "";
		return target ? `正在等子代理 ${target}` : "正在等子代理";
	}
	return `正在${label}`;
}

/** What the live turn is doing right now. */
export function currentRunningAction(state: TurnActivityState, now = Date.now()): RunningAction {
	const quietMs = Math.max(0, now - state.lastActivity);
	const running = [...state.steps].reverse().find((step) => step.status === "running");
	if (running) {
		const startedAt = state.stepStartTime(running.toolCallId) ?? state.phaseStartedAt;
		return { text: runningStepText(running), elapsedMs: Math.max(0, now - startedAt), quietMs };
	}
	const elapsedMs = Math.max(0, now - state.phaseStartedAt);
	switch (state.currentPhase) {
		case "thinking": {
			const sentence = lastThinkingSentence(state.currentThinking);
			return { text: "正在想", ...(sentence ? { detail: `「${sentence}」` } : {}), elapsedMs, quietMs };
		}
		case "writing":
			return { text: "正在写回答…", elapsedMs, quietMs };
		default:
			return { text: "正在等模型回复", elapsedMs, quietMs };
	}
}

function stepMark(step: TurnStep, tick: number): string {
	if (step.status === "done") return theme.fg("dim", "✓");
	if (step.status === "error") return theme.fg("error", "✗");
	if (step.status === "running") return theme.fg("runCardBar", spinnerFrame(tick));
	return theme.fg("dim", "·");
}

/** `2 分钟`: the quiet warning in whole minutes. */
function quietMinutesText(quietMs: number): string {
	return `${Math.max(1, Math.floor(quietMs / 60_000))} 分钟没有新输出`;
}

/** One card row: tinted to the full width, the left bar first. */
function cardRow(content: string, width: number, warn: boolean): string {
	const bar = theme.fg(warn ? "runCardWarn" : "runCardBar", "▌");
	const body = truncateToWidth(`${bar}${content}`, width, "…");
	const padded = body + " ".repeat(Math.max(0, width - visibleWidth(body)));
	return theme.bg(warn ? "runCardWarnBg" : "runCardBg", padded);
}

/**
 * The live card: ① spinner + the action + its own clock (amber and slow once
 * quiet for a minute), ② `step N · total · what so far`, ③ the last steps.
 */
export function renderRunningCard(state: TurnActivityState, width: number, tick: number, now = Date.now()): string[] {
	const action = currentRunningAction(state, now);
	const warn = action.quietMs >= RUNNING_CARD_QUIET_MS;
	const spinner = theme.bold(theme.fg(warn ? "runCardWarn" : "runCardBar", spinnerFrame(tick, warn)));
	let first = ` ${spinner} ${theme.bold(action.text)}${theme.fg("dim", ` · ${turnRunningClockText(action.elapsedMs)}`)}`;
	if (warn) {
		first += `${theme.fg("dim", " · ")}${theme.bold(theme.fg("runCardWarn", quietMinutesText(action.quietMs)))}`;
	} else if (action.detail) {
		first += `   ${theme.italic(theme.fg("muted", action.detail))}`;
	}
	const rows = [cardRow(first, width, warn)];
	const settled = state.steps.filter((step) => step.status === "done" || step.status === "error");
	const summary = turnStepsSummary(settled);
	const tally = [
		...(state.stepCount > 0 ? [`step ${state.stepCount}`] : []),
		turnRunningClockText(state.turnDurationMs(now)),
		...(summary ? [summary] : []),
	].join(" · ");
	// Before the first step the tally would only repeat line 1's clock.
	if (state.stepCount > 0) rows.push(cardRow(`   ${theme.fg("muted", tally)}`, width, warn));
	const recent = collapseRepeats(dedupeSteps(state.steps)).slice(-RECENT_STEPS);
	if (recent.length > 0) {
		const cells = recent.map(({ step, count }) => {
			const label = truncateToWidth(`${turnStepLabel(step)}${count > 1 ? ` ×${count}` : ""}`, 28, "…");
			const text = step.status === "running" ? theme.fg("runCardBar", label) : theme.fg("dim", label);
			return `${stepMark(step, tick)} ${text}`;
		});
		rows.push(cardRow(`   ${cells.join("   ")}`, width, warn));
	}
	return rows;
}

/** Consecutive steps with the same label read as one (`等待命令结果 ×2`), marked by the latest. */
function collapseRepeats(steps: readonly TurnStep[]): Array<{ step: TurnStep; count: number }> {
	const out: Array<{ step: TurnStep; count: number; label: string }> = [];
	for (const step of steps) {
		const label = turnStepLabel(step);
		const last = out.at(-1);
		if (last && last.label === label) {
			last.step = step;
			last.count += 1;
		} else {
			out.push({ step, count: 1, label });
		}
	}
	return out;
}

function dedupeSteps(steps: readonly TurnStep[]): TurnStep[] {
	const byId = new Map<string, TurnStep>();
	for (const step of steps) byId.set(step.toolCallId, step);
	return [...byId.values()];
}

/**
 * The `◆ prime` header: the model and the turn's time once it settled, a
 * spinner and `working <elapsed>` while it runs.
 */
export function renderAssistantHeader(options: {
	modelId?: string;
	durationMs: number;
	live: boolean;
	tick: number;
	width: number;
}): string {
	const parts = [theme.bold(theme.fg("assistantLabel", "◆ prime"))];
	const facts: string[] = [];
	if (options.modelId) facts.push(theme.fg("dim", options.modelId));
	if (options.live) {
		facts.push(
			`${theme.fg("runCardBar", spinnerFrame(options.tick))} ${theme.fg("muted", `working ${turnRunningClockText(options.durationMs)}`)}`,
		);
	} else {
		facts.push(theme.fg("dim", turnFootNoteDurationText(options.durationMs)));
	}
	// Column 0, so the gutter rail below runs straight down from the ◆.
	const line = `${parts.join("")}  ${facts.join(theme.fg("dim", " · "))}`;
	return truncateToWidth(line, Math.max(1, options.width), "…");
}
