import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	buildConversationComponents,
	foldEarlierAnswers,
} from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { type TimelineHost, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { LiveTurnFlow } from "../src/modes/interactive/live-turn-flow.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * The quiet conversation's live path: real session events (the faux provider
 * and a fake `bash` tool) are recorded, then fed through the public
 * LiveTurnFlow into a real chat under fake timers, the way the interactive
 * mode feeds them. One prompt makes one timeline, a message typed meanwhile is
 * a line of it, a retry or a compaction carries the same turn on, and every turn
 * settles into its finished face with no finish timer left behind.
 */

/** One recorded moment of a real session run. */
type Recorded =
	| { kind: "event"; event: AgentSessionEvent; at: number; messages: AgentMessage[]; contextTokens?: number }
	| { kind: "interrupt"; at: number };

/** A command the test holds running until it lets it finish. */
interface Hold {
	started: Promise<void>;
	markStarted: () => void;
	done: Promise<void>;
	finish: () => void;
}

/** Commands that wait for the test, and canned command output. */
const holds = new Map<string, Hold>();
const outputs = new Map<string, string>();
const resultDetails = new Map<string, Record<string, unknown>>();

function holdCommand(command: string): Hold {
	let markStarted!: () => void;
	let finish!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const hold = { started, markStarted, done, finish };
	holds.set(command, hold);
	return hold;
}

/** A fake `bash`: canned output, and a held command runs until the test (or an abort) ends it. */
const bashTool: AgentTool = {
	name: "bash",
	label: "bash",
	description: "Run a shell command.",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_toolCallId, params, signal) => {
		const command = (params as { command: string }).command;
		const hold = holds.get(command);
		if (hold) {
			hold.markStarted();
			await new Promise<void>((resolve) => {
				void hold.done.then(resolve);
				signal?.addEventListener("abort", () => resolve());
			});
			if (signal?.aborted) throw new Error("Operation aborted");
		}
		return {
			content: [{ type: "text", text: outputs.get(command) ?? `ran ${command}` }],
			details: resultDetails.get(command) ?? {},
		};
	},
};

/**
 * An event as a view over the daemon receives it: a copy (the streaming message
 * is mutated in place after its event), and a block's start carries the block
 * empty, its text following in the deltas.
 */
function asOnTheWire(event: AgentSessionEvent): AgentSessionEvent {
	const copy = structuredClone(event);
	if (copy.type !== "message_update" || copy.message.role !== "assistant") return copy;
	const started = copy.assistantMessageEvent;
	const block = "contentIndex" in started ? copy.message.content[started.contentIndex] : undefined;
	if (started.type === "text_start" && block?.type === "text") block.text = "";
	if (started.type === "thinking_start" && block?.type === "thinking") block.thinking = "";
	if (started.type === "toolcall_start" && block?.type === "toolCall") block.arguments = {};
	return copy;
}

/** Everything a harness session emits, with the transcript and context size at each event. */
function record(harness: Harness): Recorded[] {
	const log: Recorded[] = [];
	harness.session.subscribe((event) => {
		const tokens = harness.session.getContextUsage()?.tokens;
		log.push({
			kind: "event",
			event: asOnTheWire(event),
			at: Date.now(),
			messages: harness.session.messages.slice(),
			...(typeof tokens === "number" ? { contextTokens: tokens } : {}),
		});
	});
	return log;
}

const TIMELINE_HOST: TimelineHost = {
	cwd: () => "/work/app",
	viewportRows: () => 40,
	openWhileWorking: () => true,
	autoFold: () => true,
	requestRender: () => {},
};

const UI = { requestRender: () => {} } as unknown as TUI;

/**
 * The screen the flow works on: a real chat container, the live turn slot,
 * the answer components, and the session facts the interactive mode reads
 * (streaming, a retry waiting, a compaction running, the context size).
 */
class LiveScreen {
	readonly chat = new Container();
	readonly flow: LiveTurnFlow;
	private current: TurnSummaryComponent | undefined;
	private streaming = false;
	private retryAttempt = 0;
	private compacting = false;
	private contextTokens: number | undefined;
	private answer: AssistantMessageComponent | undefined;

	constructor() {
		this.flow = new LiveTurnFlow({
			chat: () => this.chat,
			quiet: () => true,
			isStreaming: () => this.streaming,
			retryPending: () => this.retryAttempt > 0,
			compacting: () => this.compacting,
			contextTokens: () => this.contextTokens,
			cwd: () => "/work/app",
			rlmNodeId: () => undefined,
			createSummary: (state) => {
				const summary = new TurnSummaryComponent(state);
				summary.setTimelineHost(TIMELINE_HOST);
				return summary;
			},
			runStartedAt: () => undefined,
			startExpanded: () => false,
			currentState: () => this.current?.state,
			currentSummary: () => this.current,
			setCurrent: (summary) => {
				this.current = summary;
			},
			foldEarlierAnswers: (summary) => foldEarlierAnswers(this.chat.children, summary),
			requestRender: () => {},
			liveChanged: () => {},
		});
	}

	/** One session event, routed the way the interactive mode routes it. */
	apply(step: Extract<Recorded, { kind: "event" }>): void {
		const event = step.event;
		if (step.contextTokens !== undefined) this.contextTokens = step.contextTokens;
		switch (event.type) {
			case "agent_start":
				this.streaming = true;
				this.flow.agentStart();
				return;
			case "message_start": {
				const message = event.message;
				if (message.role === "custom") {
					this.flow.customMessage(message);
				} else if (message.role === "user") {
					const content = message.content;
					const text =
						typeof content === "string"
							? content
							: content.map((part) => (part.type === "text" ? part.text : "")).join("");
					if (this.flow.userMessage(text, Number(message.timestamp)) === "prompt") {
						this.chat.addChild(new UserMessageComponent(text));
					}
				} else if (message.role === "assistant") {
					this.flow.assistantStart(message);
					this.answer = new AssistantMessageComponent(undefined, false, undefined, undefined, { quiet: true });
					this.chat.addChild(this.answer);
					this.answer.updateContent(message, true);
				}
				return;
			}
			case "message_update":
				if (event.message.role === "assistant") {
					this.answer?.updateContent(event.message, true);
					this.flow.assistantUpdate(event.message, event.assistantMessageEvent);
				}
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					this.flow.assistantEnd(event.message);
					this.answer?.updateContent(event.message, false);
					this.answer = undefined;
				}
				return;
			case "tool_execution_start":
				this.flow.toolStart(event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_update":
				this.flow.toolUpdate(event.toolCallId, event.toolName, event.args, event.partialResult ?? {});
				return;
			case "tool_execution_end":
				this.flow.toolEnd(event.toolCallId, event.toolName, event.result ?? {}, event.isError);
				return;
			case "agent_end":
				this.streaming = false;
				this.flow.agentEnd();
				return;
			case "compaction_start":
				this.compacting = true;
				this.flow.compactionStart(event.reason);
				return;
			case "compaction_end": {
				this.compacting = false;
				const key = this.flow.compactionEnd(event);
				if (!event.aborted && event.result) {
					this.rebuild(step.messages, { keepHistory: true });
					this.flow.compactionRebuilt(key);
				}
				return;
			}
			case "auto_retry_start":
				this.retryAttempt = event.attempt;
				this.flow.retryStart(event);
				return;
			case "auto_retry_end":
				this.retryAttempt = 0;
				this.flow.retryEnd(event);
				return;
			default:
				return;
		}
	}

	/** The view comes back after missing events: the session facts are what they are now. */
	resync(steps: readonly Recorded[]): void {
		this.streaming = false;
		this.retryAttempt = 0;
		this.compacting = false;
		this.rebuild(transcriptAt(steps, steps.length));
	}

	/** A view opened while the run works: the chat is the transcript so far, and the run goes on. */
	attach(messages: readonly AgentMessage[]): void {
		this.streaming = true;
		this.rebuild(messages);
	}

	/** Escape while the AI works. */
	interrupt(): void {
		this.flow.interrupt();
	}

	/**
	 * The chat is rebuilt from the transcript (a resync, a trim, a compaction):
	 * every box is replayed, and each live box's facts carry over to its twin.
	 */
	rebuild(messages: readonly AgentMessage[], options: { keepHistory?: boolean } = {}): void {
		const carried = this.flow.captureBoxes();
		this.flow.forgetHandles();
		this.chat.clear();
		for (const component of buildConversationComponents(orderForTranscript(messages), {
			ui: UI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
			timelineHost: TIMELINE_HOST,
		})) {
			this.chat.addChild(component);
		}
		this.flow.carryOver(carried, options);
		const replayed = this.boxes().at(-1);
		if (replayed && this.streaming) {
			// Mid-run: the replayed turn stays the live one, running until agent_end.
			replayed.state.reopen();
			replayed.state.live = true;
			this.current = replayed;
		} else {
			this.current = undefined;
		}
	}

	boxes(): TurnSummaryComponent[] {
		return this.chat.children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
	}

	prompts(): number {
		return this.chat.children.filter((child) => child instanceof UserMessageComponent).length;
	}

	screen(): string {
		return stripAnsi(this.chat.render(100).join("\n"));
	}

	/** The chat as the terminal gets it, colors included. */
	rawScreen(): string {
		return this.chat.render(100).join("\n");
	}

	/** A turn's text with every event open and every step list whole (a finished turn folds up). */
	opened(box: TurnSummaryComponent): string {
		if (!box.state.boxOpen) box.toggleBox();
		box.render(100);
		for (const key of box.getFocusOrder().filter((target) => target.startsWith("all:"))) box.activate(key);
		return stripAnsi(box.render(100).join("\n"));
	}
}

/** The compaction summary goes after the messages it kept, as the interactive mode orders a transcript. */
function orderForTranscript(messages: readonly AgentMessage[]): AgentMessage[] {
	const summary = messages.find((message) => message.role === "compactionSummary");
	if (summary?.role !== "compactionSummary") return [...messages];
	const rest = messages.filter((message) => message !== summary);
	const boundary =
		summary.retainedMessageCount !== undefined
			? Math.min(summary.retainedMessageCount, rest.length)
			: rest.filter((message) => message.timestamp < summary.timestamp).length;
	return [...rest.slice(0, boundary), summary, ...rest.slice(boundary)];
}

/** Feed recorded events, keeping the fake clock at or past each event's own time. */
function feed(screen: LiveScreen, steps: readonly Recorded[]): void {
	for (const step of steps) {
		if (step.at > Date.now()) vi.setSystemTime(step.at);
		if (step.kind === "interrupt") screen.interrupt();
		else screen.apply(step);
	}
}

const typeOf = (step: Recorded) => (step.kind === "event" ? step.event.type : "interrupt");

/** The index just after the n-th (1-based) recorded event of `type`. */
function indexAfter(steps: readonly Recorded[], type: string, nth = 1): number {
	let seen = 0;
	for (let index = 0; index < steps.length; index++) {
		if (typeOf(steps[index]!) === type && ++seen === nth) return index + 1;
	}
	throw new Error(`no ${type} #${nth} in ${steps.map(typeOf).join(",")}`);
}

/** The index just after the n-th (1-based) recorded user message. */
function afterPrompt(steps: readonly Recorded[], nth: number): number {
	let seen = 0;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		if (step.kind === "event" && step.event.type === "message_start" && step.event.message.role === "user") {
			if (++seen === nth) return index + 1;
		}
	}
	throw new Error(`no user message #${nth}`);
}

/** The transcript as the session held it at the last recorded event before `index`. */
function transcriptAt(steps: readonly Recorded[], index: number): AgentMessage[] {
	for (let cursor = index - 1; cursor >= 0; cursor--) {
		const step = steps[cursor]!;
		if (step.kind === "event") return step.messages;
	}
	return [];
}

/** Past the settle a finished turn waits for (a retry or a compaction may still carry it on). */
const SETTLE_MS = 450;

/** A turn's lines as plain text. */
function plainLines(box: TurnSummaryComponent): string[] {
	const lines = box.render(100).map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
	// The turn's own lines: the empty rows it opens with (two under a question, one for a woken turn) are left off.
	let first = 0;
	while (/^ {9}│ *$/.test(lines[first] ?? "")) first += 1;
	expect(first, "the empty rows a turn opens with").toBeLessThanOrEqual(2);
	return lines.slice(first);
}

/** The line ending a running turn: ` HH:MM ⠹ <sentence>      第 N 步`. */
const SPINNER_LINE = /^ \d\d:\d\d {3}[⠀-⣿] {6}/;

/** The column a string starts at in a plain line (wide characters count two). */
function cell(line: string, needle: string): number {
	const at = line.indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	let cols = 0;
	for (const ch of line.slice(0, at)) cols += /[ᄀ-ᅟ⺀-鿿가-힣＀-｠]/.test(ch) ? 2 : 1;
	return cols;
}

/** The one line of `text` that has `needle`. */
function lineWith(text: string, needle: string): string {
	const found = text.split("\n").filter((line) => line.includes(needle));
	expect(found).toHaveLength(1);
	return found[0] ?? "";
}

/** An event line: the AI's diamond at column 9, its words at column 16. */
function expectEventLine(line: string, words: string): void {
	expect(line).toMatch(/^ \d\d:\d\d {3}◆ {6}\S/);
	expect(cell(line, "◆")).toBe(9);
	expect(cell(line, words)).toBe(16);
}

/** The owner's steer as its own line: ` HH:MM ●      你插话   <text>`. */
function expectSteerLine(text: string, said: string): void {
	const line = lineWith(text, said);
	expect(line).toMatch(/^ \d\d:\d\d {3}● {6}你插话 {3}/);
	expect(line.trimEnd().endsWith(`你插话   ${said}`)).toBe(true);
	expect(cell(line, "●")).toBe(9);
	expect(cell(line, "你插话")).toBe(16);
}

/** A stopped turn says so once, on the closing row (`╵ ■ 已停止 · 用了 …`), never on its own lines. */
function expectStoppedClosingRow(screen: LiveScreen, box: TurnSummaryComponent): void {
	expect(plainLines(box).join("\n")).not.toContain("已停止");
	expect(lineWith(screen.screen(), "已停止")).toMatch(/^ {9}╵ {6}■ 已停止 · 用了 /);
}

/**
 * A turn the owner stopped: no live face and no status pill on its lines, the event folded, the cut
 * step a faint `■` step line once opened, and nothing drawn as a failure.
 */
function expectStopped(
	screen: LiveScreen,
	box: TurnSummaryComponent,
	command: string,
	options: { closingRow?: boolean } = {},
): void {
	expect(box.state.boxLive).toBe(false);
	expectNoLiveFace(box);
	if (options.closingRow !== false) expectStoppedClosingRow(screen, box);
	expect(screen.screen()).not.toContain("✓");
	const opened = screen.opened(box);
	expect(lineWith(opened, `${command} · 你停下了`).startsWith(`         │           ■  ${command} · 你停下了`)).toBe(
		true,
	);
	expect(opened).not.toMatch(/出错|✗/);
	expect(screen.rawScreen()).not.toContain(theme.getFgAnsi("timelineMust"));
}

/** A turn that ended (not running): its live face, the spinner line and the running step, is gone. */
function expectNoLiveFace(box: TurnSummaryComponent): void {
	const lines = plainLines(box);
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.filter((line) => SPINNER_LINE.test(line))).toEqual([]);
	expect(lines.filter((line) => /第 \d+ 步\s*$/.test(line))).toEqual([]);
}

const harnesses: Harness[] = [];

async function session(
	options: { retry?: boolean; retryDelayMs?: number; compaction?: boolean } = {},
): Promise<Harness> {
	const harness = await createHarness({
		tools: [bashTool],
		...(options.retry
			? { settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: options.retryDelayMs ?? 1 } } }
			: {}),
		...(options.compaction
			? {
					persistSession: true,
					models: [{ id: "faux-1", contextWindow: 100_000 }],
					settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1, triggerRatio: 0.5 } },
				}
			: {}),
	});
	harnesses.push(harness);
	return harness;
}

/** Resolves when the session emits its next event of `type`. */
function nextEvent(harness: Harness, type: AgentSessionEvent["type"]): Promise<void> {
	return new Promise((resolve) => {
		const off = harness.session.subscribe((event) => {
			if (event.type !== type) return;
			off();
			resolve();
		});
	});
}

async function run(harness: Harness, prompt: string): Promise<void> {
	await harness.session.prompt(prompt);
	await harness.session.waitForIdle();
}

let lastStamp = 0;
/** Each reply is stamped when the model sends it, as a real provider does (a box keys its messages by time). */
function reply(
	content: Parameters<typeof fauxAssistantMessage>[0],
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): FauxResponseStep {
	return () => {
		lastStamp = Math.max(Date.now(), lastStamp + 1);
		return fauxAssistantMessage(content, { ...options, timestamp: lastStamp });
	};
}

function bashCall(command: string): FauxResponseStep {
	return reply(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
}

/** One prompt: a command, then the answer. */
async function recordSimpleTurn(harness: Harness, prompt: string, command: string, answer: string): Promise<void> {
	harness.appendResponses([bashCall(command), reply(answer)]);
	await run(harness, prompt);
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	holds.clear();
	outputs.clear();
	resultDetails.clear();
});

function startScreen(steps: readonly Recorded[]): LiveScreen {
	const first = steps[0];
	vi.useFakeTimers({ now: first ? first.at : Date.now() });
	setMotionReduced(true);
	return new LiveScreen();
}

describe("a quiet turn, live", () => {
	it("puts a message typed while a command runs in the same turn as a steer line", async () => {
		const harness = await session();
		const steps = record(harness);
		const tests = holdCommand("npm test");
		harness.setResponses([bashCall("npm test"), reply("测试和 lint 都过了。")]);
		const prompt = run(harness, "修一下测试");
		await tests.started;
		await harness.session.steer("顺便看下 lint");
		tests.finish();
		await prompt;
		await harness.session.waitForIdle();

		const screen = startScreen(steps);
		feed(screen, steps);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.prompts()).toBe(1);
		// The steer sits in the turn's own lines, right after the event it cut in on.
		const own = plainLines(screen.boxes()[0]!);
		expectSteerLine(own.join("\n"), "顺便看下 lint");
		expectEventLine(own[0] ?? "", "跑了 1 条命令");
		expect(own.indexOf(lineWith(own.join("\n"), "你插话"))).toBe(1);
		expectSteerLine(screen.screen(), "顺便看下 lint");
		vi.advanceTimersByTime(SETTLE_MS);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the live face through the settle, then shows the finished face with the strip last", async () => {
		const harness = await session();
		const steps = record(harness);
		await recordSimpleTurn(harness, "跑一下测试", "npm test", "都过了。");

		const screen = startScreen(steps);
		feed(screen, steps);
		const box = screen.boxes()[0]!;
		expect(screen.boxes()).toHaveLength(1);
		// The settle: a retry or a compaction may still carry the turn on, so the timeline still ends on its spinner line.
		expect(box.state.boxLive).toBe(true);
		const live = plainLines(box);
		expect(live.filter((line) => SPINNER_LINE.test(line))).toHaveLength(1);
		expect(live.at(-1)).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}等待模型回应…\s+第 1 步 {2}$/);
		expect(screen.chat.children.some((child) => child instanceof TurnStripComponent)).toBe(false);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(box.state.boxLive).toBe(false);
		// Finished: the event is folded on `1 步 ▸`, the spinner line is gone, and there is no frame or status pill.
		expect(screen.screen()).not.toMatch(/[╭╮╰╯├┤]|完成 |进行中|已停止/);
		const done = plainLines(box);
		expect(done).toHaveLength(1);
		expectEventLine(done[0] ?? "", "跑了 1 条命令");
		expect(done[0]?.endsWith("1 步 ▸  ")).toBe(true);
		expectNoLiveFace(box);
		expect(screen.screen()).toContain("都过了。");
		expect(screen.chat.children.at(-1)).toBeInstanceOf(TurnStripComponent);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reopens the same turn for a retry, with the retry as a step", async () => {
		const harness = await session({ retry: true });
		const steps = record(harness);
		harness.setResponses([
			bashCall("npm run build"),
			reply("", { stopReason: "error", errorMessage: "503 upstream overloaded" }),
			reply("构建好了。"),
		]);
		await run(harness, "跑一遍构建");

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, indexAfter(steps, "auto_retry_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		const box = screen.boxes()[0]!;
		// Waiting to retry: the turn stays live, its spinner line says the retry and the retry is a step.
		expect(box.state.boxLive).toBe(true);
		const waiting = plainLines(box);
		expect(waiting.at(-1)).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}模型服务繁忙，正在重试\s+第 2 步 {2}$/);
		// A step that still runs wears the spinner and its own clock.
		expect(screen.opened(box)).toMatch(/^ {9}│ {11}[⠀-⣿] {2}模型服务繁忙，正在重试 +\d+秒 {4}$/m);
		feed(screen, steps.slice(indexAfter(steps, "auto_retry_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]).toBe(box);
		expect(box.state.boxLive).toBe(false);
		expectNoLiveFace(box);
		expect(screen.screen()).toContain("构建好了。");
		expect(screen.opened(box)).toMatch(/^ {9}│ {11}↻ {2}模型服务繁忙，已自动重试/m);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows an automatic compaction as a step of the turn it interrupted, and the turn finishes after it", async () => {
		const harness = await session({ compaction: true });
		const steps = record(harness);
		outputs.set("cat build.log", `build log${"x".repeat(250_000)}`);
		harness.setResponses([
			bashCall("cat build.log"),
			// The summary, the continuation's answer, then the summary of a second compaction after it.
			reply("前面做过的事"),
			reply("日志看完了。"),
			reply("看过一份很长的构建日志"),
		]);
		await run(harness, "看下构建日志");
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(0);

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, indexAfter(steps, "compaction_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		// Compacting: the turn waits for it and its spinner line says so.
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]!.state.boxLive).toBe(true);
		expect(plainLines(screen.boxes()[0]!).at(-1)).toMatch(
			/^ \d\d:\d\d {3}[⠀-⣿] {6}上下文快满了，正在整理前面的内容\s+第 \d+ 步 {2}$/,
		);
		feed(screen, steps.slice(indexAfter(steps, "compaction_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		const box = screen.boxes()[0]!;
		expect(box.state.boxLive).toBe(false);
		expectNoLiveFace(box);
		const compactions = harness.eventsOfType("compaction_end").length;
		expect(compactions).toBeGreaterThan(0);
		// The compaction that interrupted the turn is one step of its event; the one after the last answer is a line of its own.
		const opened = screen.opened(box);
		expect(opened.match(/^ {9}│ {11}⇣ {2}整理完成：[\d.]+k → [\d.]+k tokens/gm)).toHaveLength(compactions - 1);
		expect(screen.screen().match(/^ \d\d:\d\d {3}◆ {6}整理完成：[\d.]+k → [\d.]+k tokens/gm)).toHaveLength(1);
		expect(screen.screen()).not.toContain("前面的对话整理过了");
		expect(screen.screen()).toContain("日志看完了。");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles the live compaction row when its outcome message lands before compaction_end", async () => {
		// The session persists the skip/failure notice (message_start) ahead of compaction_end:
		// the live "正在整理" row settles with it instead of spinning on as a ghost.
		const screen = startScreen([]);
		const flow = screen.flow;
		const t0 = Date.now();
		expect(flow.userMessage("看看日志", t0)).toBe("prompt");
		const message = fauxAssistantMessage("看完了。", { timestamp: t0 + 1 });
		flow.assistantStart(message);
		flow.assistantEnd(message);
		flow.agentEnd();
		expect(flow.compactionStart("threshold")).toBe(true);
		const outcome = createCompactionOutcomeMessage(
			"Auto-compaction skipped: conversation too short",
			{ reason: "threshold", outcome: "skipped" },
			true,
			t0 + 2,
		);
		expect(flow.customMessage(outcome)).toBe(true);
		flow.compactionEnd({
			reason: "threshold",
			result: undefined,
			aborted: false,
			errorMessage: "Auto-compaction skipped: conversation too short",
			errorSeverity: "warning",
		});
		vi.advanceTimersByTime(SETTLE_MS);
		const box = screen.boxes()[0]!;
		const compactions = box.state.timeline.entries.filter((entry) => entry.kind === "compact");
		expect(compactions).toHaveLength(1);
		const row = compactions[0]!;
		expect(row.kind === "compact" && row.compaction.skipped).toBe(true);
		expect(row.kind === "compact" ? row.compaction.endedAt : undefined).toBe(t0 + 2);
		expect(box.state.timeline.activeCompaction()).toBeUndefined();
		// The settled skip is the closing part's own line; nothing keeps saying 正在整理.
		expect(screen.screen()).toContain("暂不整理");
		expect(screen.screen()).not.toContain("正在整理");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ends a turn the owner stopped mid-command as stopped, with a faint stopped step", async () => {
		const harness = await session();
		const steps = record(harness);
		const slow = holdCommand("sleep 100");
		harness.setResponses([bashCall("sleep 100")]);
		const prompt = run(harness, "慢慢跑");
		await slow.started;
		steps.push({ kind: "interrupt", at: Date.now() });
		await harness.session.abort();
		await prompt;

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const box = screen.boxes()[0]!;
		expect(screen.boxes()).toHaveLength(1);
		expectStopped(screen, box, "sleep 100");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts a new turn for the next prompt, and the previous turn finishes right then", async () => {
		const harness = await session();
		const steps = record(harness);
		await recordSimpleTurn(harness, "跑一下测试", "npm test", "测试都过了。");
		const firstEnd = steps.length;
		await recordSimpleTurn(harness, "再跑 lint", "npm run lint", "lint 也过了。");

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, firstEnd));
		const [first] = screen.boxes();
		expect(first!.state.boxLive).toBe(true);
		// The next prompt arrives inside the settle.
		feed(screen, steps.slice(firstEnd, afterPrompt(steps, 2)));
		expect(first!.state.boxLive).toBe(false);
		feed(screen, steps.slice(afterPrompt(steps, 2)));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(2);
		expect(screen.prompts()).toBe(2);
		expect(screen.boxes().map((box) => box.state.boxLive)).toEqual([false, false]);
		expect(screen.chat.children.at(-1)).toBeInstanceOf(TurnStripComponent);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("a quiet turn that ends without a run ending it", () => {
	it("finishes as stopped when the owner cancels a retry while it counts down", async () => {
		const harness = await session({ retry: true, retryDelayMs: 60_000 });
		const steps = record(harness);
		harness.setResponses([
			bashCall("npm run build"),
			reply("", { stopReason: "error", errorMessage: "503 upstream overloaded" }),
			reply("构建好了。"),
		]);
		const waiting = nextEvent(harness, "auto_retry_start");
		const prompt = run(harness, "跑一遍构建");
		await waiting;
		steps.push({ kind: "interrupt", at: Date.now() });
		harness.session.abortRetry();
		await prompt;
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(1);

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const box = screen.boxes()[0]!;
		expect(screen.boxes()).toHaveLength(1);
		expect(box.state.boxLive).toBe(false);
		// Stopped, not failed: no live face, no status pill, nothing in the failure color.
		expectNoLiveFace(box);
		expectStoppedClosingRow(screen, box);
		expect(screen.rawScreen()).not.toContain(theme.getFgAnsi("timelineMust"));
		const opened = screen.opened(box);
		expect(opened).toMatch(/^ {9}│ {11}↻ {2}.*已停止/m);
		expect(opened).not.toContain("重试没成功");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes as failed when a retry gives up with no run after it", async () => {
		const harness = await session({ retry: true });
		const steps = record(harness);
		harness.setResponses([
			bashCall("npm run build"),
			reply("", { stopReason: "error", errorMessage: "503 upstream overloaded" }),
			reply("构建好了。"),
		]);
		await run(harness, "跑一遍构建");

		const screen = startScreen(steps);
		const retrying = indexAfter(steps, "auto_retry_start");
		feed(screen, steps.slice(0, retrying));
		// The retry never gets a run: it gives up on its own.
		screen.apply({
			kind: "event",
			event: { type: "auto_retry_end", success: false, attempt: 1, finalError: "模型一直不可用" },
			at: Date.now(),
			messages: transcriptAt(steps, retrying),
		});
		vi.advanceTimersByTime(SETTLE_MS);
		const box = screen.boxes()[0]!;
		expect(box.state.boxLive).toBe(false);
		expectNoLiveFace(box);
		// The failure that ended the turn is its own red event line, not a step behind `N 步`.
		const failed = lineWith(screen.screen(), "重试没成功：模型一直不可用");
		expectEventLine(failed, "模型服务繁忙，重试没成功：模型一直不可用");
		expect(failed.endsWith("▸  ")).toBe(true);
		expect(failed).not.toMatch(/\d+ 步/);
		const raw =
			screen
				.rawScreen()
				.split("\n")
				.find((line) => line.includes("重试没成功：模型一直不可用")) ?? "";
		expect(raw).toContain(theme.getFgAnsi("timelineMust"));
		expect(screen.opened(box)).toContain("重试没成功：模型一直不可用");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops an attempt the session started over, with its thinking and tokens", async () => {
		const start = Date.now();
		const attempt = (at: number, content: AssistantMessage["content"], output: number): AssistantMessage => ({
			...fauxAssistantMessage("", { timestamp: at }),
			content,
			usage: { ...fauxAssistantMessage("").usage, output, totalTokens: output },
		});
		const dropped = attempt(start + 1_000, [{ type: "thinking", thinking: "先翻一下昨天的日志。" }], 3_000);
		const kept = attempt(start + 2_000, [{ type: "text", text: "日志没问题。" }], 20);
		const events: AgentSessionEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: "看下日志", timestamp: start } },
			{ type: "message_start", message: dropped },
			{
				type: "message_update",
				message: dropped,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "先翻一下昨天的日志。",
					partial: dropped,
				},
			},
			// An empty-turn retry: a fresh attempt starts, the dropped one never ends.
			{ type: "message_start", message: kept },
			{
				type: "message_update",
				message: kept,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "日志没问题。", partial: kept },
			},
			{ type: "message_end", message: kept },
			{ type: "agent_end", messages: [kept] },
		];
		const steps: Recorded[] = events.map((event) => ({ kind: "event", event, at: start, messages: [] }));

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const box = screen.boxes()[0]!;
		const shown = screen.screen();
		expect(shown).toContain("日志没问题。");
		// The kept attempt is a plain answer under the timeline, so the timeline draws no line at all.
		expect(plainLines(box)).toEqual([]);
		expect(screen.opened(box)).toBe("");
		// Nothing of the dropped attempt (its thought, its thinking line, its tokens) is on the screen.
		expect(shown).not.toContain("先翻一下昨天的日志");
		expect(shown).not.toContain("想了");
		expect(shown).not.toContain("3.0k");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("takes back what a lost connection said once the session comes back", async () => {
		const harness = await session();
		const steps = record(harness);
		await recordSimpleTurn(harness, "跑一下测试", "npm test", "测试都过了。");

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, indexAfter(steps, "tool_execution_start")));
		screen.flow.connectionLost();
		const [box] = screen.boxes();
		expect(box!.state.boxLive).toBe(false);
		// The cut step and the connection notice are failures that ended the turn: one red event line each.
		const lost = lineWith(screen.opened(box!), "和后台的连接断了");
		expectEventLine(lost, "和后台的连接断了，这一轮后面的进展收不到");
		expectEventLine(lineWith(screen.opened(box!), "没收到结果"), "运行 npm test 出错：连接断了，没收到结果");
		const rawLost = box!.render(100).find((line) => line.includes("和后台的连接断了")) ?? "";
		expect(rawLost).toContain(theme.getFgAnsi("timelineMust"));
		// Reconnected: the chat is rebuilt from the session as it is now.
		vi.setSystemTime(steps.at(-1)!.at);
		screen.flow.connectionRestored();
		screen.resync(steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const [twin] = screen.boxes();
		expect(screen.boxes()).toHaveLength(1);
		expect(twin!.state.boxLive).toBe(false);
		// The twin finishes folded: its event sits on `1 步 ▸` (a finish folds every event; nothing stays open).
		expectNoLiveFace(twin!);
		const folded = plainLines(twin!);
		expect(folded).toHaveLength(1);
		expectEventLine(folded[0] ?? "", "跑了 1 条命令");
		expect(folded[0]?.endsWith("1 步 ▸  ")).toBe(true);
		expect(screen.opened(twin!)).not.toContain("连接断了");
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("a quiet turn seen from a second view", () => {
	it("ends as stopped when another view stopped it mid-command", async () => {
		const harness = await session();
		const steps = record(harness);
		const slow = holdCommand("sleep 100");
		harness.setResponses([bashCall("sleep 100")]);
		const prompt = run(harness, "慢慢跑");
		await slow.started;
		// The stop comes from the other window: this view never saw its Escape.
		await harness.session.abort();
		await prompt;

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expectStopped(screen, screen.boxes()[0]!, "sleep 100");
	});

	it("puts a message typed after it attached mid-command in the same turn", async () => {
		const harness = await session();
		const steps = record(harness);
		const tests = holdCommand("npm test");
		harness.setResponses([bashCall("npm test"), reply("测试和 lint 都过了。")]);
		const prompt = run(harness, "修一下测试");
		await tests.started;
		const attachedAt = steps.length;
		await harness.session.steer("顺便看下 lint");
		tests.finish();
		await prompt;
		await harness.session.waitForIdle();

		const later = steps.slice(attachedAt);
		const screen = startScreen(later);
		screen.attach(transcriptAt(steps, attachedAt));
		feed(screen, later);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.prompts()).toBe(1);
		expectSteerLine(screen.opened(screen.boxes()[0]!), "顺便看下 lint");
	});
});

describe("a quiet turn a notice carries on", () => {
	it("starts the next turn when the notice wakes the AI, and the earlier answer stays under its own box", async () => {
		const harness = await session();
		const steps = record(harness);
		harness.setResponses([reply("子代理回来了：当前目录有 3 个文件。"), reply("收到它的结束通知，结论不变。")]);
		await run(harness, "派个子代理数文件");
		await harness.session.sendCustomMessage(
			{
				customType: RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
				content: "child finished",
				display: false,
				details: { sessionName: "counter", kind: "completed_without_reply" },
			},
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(2);
		const shown = screen.screen();
		expect(shown).toContain("收到它的结束通知，结论不变。");
		// The answer the first turn ended on is not folded away by the turn the notice woke.
		expect(shown).toContain("子代理回来了：当前目录有 3 个文件");
	});
});

describe("a quiet turn replayed from its transcript", () => {
	it("shows a turn the owner stopped mid-command the way it looked live", async () => {
		const harness = await session();
		const steps = record(harness);
		const slow = holdCommand("sleep 100");
		harness.setResponses([bashCall("sleep 100")]);
		const prompt = run(harness, "慢慢跑");
		await slow.started;
		steps.push({ kind: "interrupt", at: Date.now() });
		await harness.session.abort();
		await prompt;

		const live = startScreen(steps);
		feed(live, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		// Reopened later: nothing carries over from a live box.
		const cold = new LiveScreen();
		cold.rebuild(transcriptAt(steps, steps.length));
		// The closing row is the mode's replay and the live flow's; this cold rebuild is the builder alone.
		for (const screen of [live, cold]) {
			expect(screen.boxes()).toHaveLength(1);
			expectStopped(screen, screen.boxes()[0]!, "sleep 100", { closingRow: screen === live });
		}
	});

	it("keeps a message typed during a cut-off step in the same turn, as live", async () => {
		const harness = await session();
		const steps = record(harness);
		const e2e = holdCommand("npm run e2e");
		// The command hit its own time limit and was cut off; the turn goes on.
		resultDetails.set("npm run e2e", { status: "aborted" });
		harness.setResponses([bashCall("npm run e2e"), bashCall("npm run e2e -- --bail"), reply("e2e 过了。")]);
		const prompt = run(harness, "跑一下 e2e");
		await e2e.started;
		await harness.session.steer("失败了就只跑出错的那个");
		e2e.finish();
		await prompt;
		await harness.session.waitForIdle();

		const live = startScreen(steps);
		feed(live, steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const cold = new LiveScreen();
		cold.rebuild(transcriptAt(steps, steps.length));
		for (const screen of [live, cold]) {
			expect(screen.boxes()).toHaveLength(1);
			expect(screen.prompts()).toBe(1);
			expectSteerLine(screen.opened(screen.boxes()[0]!), "失败了就只跑出错的那个");
		}
	});
});

describe("a quiet turn across a chat rebuild", () => {
	it("carries a turn waiting to retry over to its replayed twin, which finishes after the retry", async () => {
		const harness = await session({ retry: true });
		const steps = record(harness);
		harness.setResponses([
			bashCall("npm run build"),
			reply("", { stopReason: "error", errorMessage: "503 upstream overloaded" }),
			reply("构建好了。"),
		]);
		await run(harness, "跑一遍构建");

		const screen = startScreen(steps);
		const retrying = indexAfter(steps, "auto_retry_start");
		feed(screen, steps.slice(0, retrying));
		screen.rebuild(transcriptAt(steps, retrying));
		const [twin] = screen.boxes();
		expect(screen.boxes()).toHaveLength(1);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(twin!.state.boxLive).toBe(true);
		// The twin still waits on its retry: the spinner line says it and the retry is a step.
		expect(plainLines(twin!).at(-1)).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}模型服务繁忙，正在重试\s+第 \d+ 步 {2}$/);
		expect(screen.opened(twin!)).toMatch(/^ {9}│ {11}[⠀-⣿] {2}模型服务繁忙，正在重试 +\d+秒 {4}$/m);
		feed(screen, steps.slice(retrying));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]).toBe(twin);
		expect(twin!.state.boxLive).toBe(false);
		expectNoLiveFace(twin!);
		expect(screen.opened(twin!)).toMatch(/^ {9}│ {11}↻ {2}/m);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a carried retry turn whose retry ended while the view was away", async () => {
		const harness = await session({ retry: true });
		const steps = record(harness);
		harness.setResponses([
			bashCall("npm run build"),
			reply("", { stopReason: "error", errorMessage: "503 upstream overloaded" }),
			reply("构建好了。"),
		]);
		await run(harness, "跑一遍构建");

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, indexAfter(steps, "auto_retry_start")));
		// The view misses the retry's run and its end, then resyncs from the transcript.
		vi.setSystemTime(steps.at(-1)!.at);
		screen.resync(steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const [twin] = screen.boxes();
		expect(screen.boxes()).toHaveLength(1);
		expect(twin!.state.boxLive).toBe(false);
		expectNoLiveFace(twin!);
		expect(screen.screen()).toContain("构建好了。");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a turn that was settling when the chat was rebuilt", async () => {
		const harness = await session();
		const steps = record(harness);
		await recordSimpleTurn(harness, "跑一下测试", "npm test", "测试都过了。");

		const screen = startScreen(steps);
		feed(screen, steps);
		vi.advanceTimersByTime(100);
		screen.rebuild(transcriptAt(steps, steps.length));
		const [twin] = screen.boxes();
		expect(twin!.state.boxLive).toBe(true);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(twin!.state.boxLive).toBe(false);
		// Finished: the event folded on `1 步 ▸`, no spinner line, no frame or status pill.
		expect(screen.screen()).not.toMatch(/[╭╮╰╯├┤]|完成 |进行中|已停止/);
		expectNoLiveFace(twin!);
		const folded = plainLines(twin!);
		expect(folded).toHaveLength(1);
		expectEventLine(folded[0] ?? "", "跑了 1 条命令");
		expect(folded[0]?.endsWith("1 步 ▸  ")).toBe(true);
		expect(screen.chat.children.at(-1)).toBeInstanceOf(TurnStripComponent);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a turn the rebuild left settling as soon as the next prompt arrives", async () => {
		const harness = await session();
		const steps = record(harness);
		await recordSimpleTurn(harness, "跑一下测试", "npm test", "测试都过了。");
		const firstEnd = steps.length;
		await recordSimpleTurn(harness, "再跑 lint", "npm run lint", "lint 也过了。");

		const screen = startScreen(steps);
		feed(screen, steps.slice(0, firstEnd));
		vi.advanceTimersByTime(100);
		screen.rebuild(transcriptAt(steps, firstEnd));
		const [twin] = screen.boxes();
		feed(screen, steps.slice(firstEnd, afterPrompt(steps, 2)));
		// Only the new prompt's box is live.
		expect(twin!.state.boxLive).toBe(false);
		feed(screen, steps.slice(afterPrompt(steps, 2)));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(2);
		expect(screen.boxes().map((box) => box.state.boxLive)).toEqual([false, false]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes every turn when a rebuild leaves several settling at once", async () => {
		const harness = await session();
		const steps = record(harness);
		const e2e = holdCommand("npm run e2e");
		harness.setResponses([bashCall("npm run e2e"), bashCall("npm run e2e -- --bail"), reply("e2e 过了。")]);
		const prompt = run(harness, "跑一下 e2e");
		await e2e.started;
		// The stop comes from outside this view (another window's Escape, a `stop` command): all it
		// leaves here is the loop's bare abort stub, which is what says the owner stopped the run.
		await harness.session.abort();
		await prompt;
		await run(harness, "失败了就只跑出错的那个");

		const screen = startScreen(steps);
		feed(screen, steps);
		// The run ended on that stop, so the next prompt opens a box of its own - the grouping a
		// replay of the same transcript gives. Live used to carry the prompt into the stopped box
		// (`你插话`) and the rebuild below then re-grouped the chat into two boxes (R3-M18).
		expect(screen.boxes()).toHaveLength(2);
		expect(screen.prompts()).toBe(2);
		expect(screen.screen()).not.toContain("你插话");
		vi.advanceTimersByTime(100);
		screen.rebuild(transcriptAt(steps, steps.length));
		const replayed = screen.boxes();
		expect(replayed).toHaveLength(2);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(replayed.map((box) => box.state.boxLive)).toEqual([false, false]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
