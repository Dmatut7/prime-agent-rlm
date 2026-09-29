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
import { RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
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
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * The quiet conversation's live path: real session events (the faux provider
 * and a fake `bash` tool) are recorded, then fed through the public
 * LiveTurnFlow into a real chat under fake timers, the way the interactive
 * mode feeds them. One prompt makes one box, a message typed meanwhile is a
 * row in it, a retry or a compaction carries the same box on, and every box
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

	/** A box's text with its body open (a finished box folds up). */
	opened(box: TurnSummaryComponent): string {
		if (!box.state.boxOpen) box.toggleBox();
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

/** Past the settle a finished box waits for (a retry or a compaction may still carry it on). */
const SETTLE_MS = 450;

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
	it("puts a message typed while a command runs in the same box as a row", async () => {
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
		expect(screen.screen()).toContain("你插话：顺便看下 lint");
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
		// The settle: a retry or a compaction may still carry the turn on.
		expect(box.state.boxLive).toBe(true);
		expect(screen.chat.children.some((child) => child instanceof TurnStripComponent)).toBe(false);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(box.state.boxLive).toBe(false);
		expect(screen.screen()).toMatch(/✓ 完成 .*跑了 1 条命令 .*›/);
		expect(screen.screen()).toContain("都过了。");
		expect(screen.chat.children.at(-1)).toBeInstanceOf(TurnStripComponent);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reopens the same box for a retry, with the retry as a row", async () => {
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
		// Waiting to retry: the box stays live with the retry row.
		expect(box.state.boxLive).toBe(true);
		expect(screen.screen()).toContain("↻");
		feed(screen, steps.slice(indexAfter(steps, "auto_retry_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]).toBe(box);
		expect(box.state.boxLive).toBe(false);
		expect(screen.screen()).toContain("构建好了。");
		expect(screen.opened(box)).toMatch(/↻/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows an automatic compaction as a row of the turn it interrupted, and the box finishes after it", async () => {
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
		// Compacting: the box waits for it.
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]!.state.boxLive).toBe(true);
		feed(screen, steps.slice(indexAfter(steps, "compaction_start")));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		const box = screen.boxes()[0]!;
		expect(box.state.boxLive).toBe(false);
		const compactions = harness.eventsOfType("compaction_end").length;
		expect(compactions).toBeGreaterThan(0);
		// Each compaction is one row in the box, and nowhere else.
		const opened = screen.opened(box);
		expect(opened.match(/⇣ 整理完成：[\d.]+k → [\d.]+k tokens/g)).toHaveLength(compactions);
		expect(screen.screen()).not.toContain("前面的对话整理过了");
		expect(screen.screen()).toContain("日志看完了。");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ends a turn the owner stopped mid-command as stopped, with a faint stopped row", async () => {
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
		expect(screen.screen()).toContain("■ 已停止");
		const opened = screen.opened(box);
		expect(opened).toContain("■ sleep 100 · 你停下了");
		expect(opened).not.toMatch(/出错|✗/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts a new box for the next prompt, and the previous box finishes right then", async () => {
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
		expect(screen.screen()).toContain("■ 已停止");
		const opened = screen.opened(box);
		expect(opened).toMatch(/↻ .*已停止/);
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
		expect(screen.screen()).toMatch(/✗ 出错 .*›/);
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
		expect(screen.screen()).toContain("日志没问题。");
		const opened = screen.opened(box);
		expect(opened).not.toContain("先翻一下昨天的日志");
		expect(opened).not.toContain("想了");
		expect(opened).not.toContain("3.0k");
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
		expect(screen.opened(box!)).toContain("和后台的连接断了");
		// Reconnected: the chat is rebuilt from the session as it is now.
		vi.setSystemTime(steps.at(-1)!.at);
		screen.flow.connectionRestored();
		screen.resync(steps);
		vi.advanceTimersByTime(SETTLE_MS);
		const [twin] = screen.boxes();
		expect(screen.boxes()).toHaveLength(1);
		expect(twin!.state.boxLive).toBe(false);
		// Opened above, so it stays open.
		expect(screen.screen()).toMatch(/✓ 完成 .*跑了 1 条命令 .*⌄/);
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
		expect(screen.screen()).toContain("■ 已停止");
		expect(screen.screen()).not.toContain("✓");
		expect(screen.opened(screen.boxes()[0]!)).toContain("■ sleep 100 · 你停下了");
	});

	it("puts a message typed after it attached mid-command in the same box", async () => {
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
		expect(screen.opened(screen.boxes()[0]!)).toContain("你插话：顺便看下 lint");
	});
});

describe("a quiet turn a notice carries on", () => {
	it("keeps only the later answer under the box, the earlier one folded into it", async () => {
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
		expect(screen.boxes()).toHaveLength(1);
		const shown = screen.screen();
		expect(shown).toContain("收到它的结束通知，结论不变。");
		expect(shown).not.toContain("子代理回来了");
		expect(screen.opened(screen.boxes()[0]!)).toContain("子代理回来了：当前目录有 3 个文件");
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
		for (const screen of [live, cold]) {
			expect(screen.boxes()).toHaveLength(1);
			expect(screen.screen()).toContain("■ 已停止");
			const opened = screen.opened(screen.boxes()[0]!);
			expect(opened).toContain("■ sleep 100 · 你停下了");
			expect(opened).not.toMatch(/出错|✗/);
		}
	});

	it("keeps a message typed during a cut-off step in the same box, as live", async () => {
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
			expect(screen.opened(screen.boxes()[0]!)).toContain("你插话：失败了就只跑出错的那个");
		}
	});
});

describe("a quiet turn across a chat rebuild", () => {
	it("carries a box waiting to retry over to its replayed twin, which finishes after the retry", async () => {
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
		expect(screen.screen()).toContain("↻");
		feed(screen, steps.slice(retrying));
		vi.advanceTimersByTime(SETTLE_MS);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.boxes()[0]).toBe(twin);
		expect(twin!.state.boxLive).toBe(false);
		expect(screen.opened(twin!)).toMatch(/↻/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a carried retry box whose retry ended while the view was away", async () => {
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
		expect(screen.screen()).toContain("构建好了。");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a box that was settling when the chat was rebuilt", async () => {
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
		expect(screen.screen()).toMatch(/✓ 完成 .*跑了 1 条命令 .*›/);
		expect(screen.chat.children.at(-1)).toBeInstanceOf(TurnStripComponent);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes a box the rebuild left settling as soon as the next prompt arrives", async () => {
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

	it("finishes every box when a rebuild leaves several settling at once", async () => {
		const harness = await session();
		const steps = record(harness);
		const e2e = holdCommand("npm run e2e");
		harness.setResponses([bashCall("npm run e2e"), bashCall("npm run e2e -- --bail"), reply("e2e 过了。")]);
		const prompt = run(harness, "跑一下 e2e");
		await e2e.started;
		// The session stops the run itself (no key press): live, the next message
		// carries the same turn on, while the replay only sees the stop's stub.
		await harness.session.abort();
		await prompt;
		await run(harness, "失败了就只跑出错的那个");

		const screen = startScreen(steps);
		feed(screen, steps);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.screen()).toContain("你插话：失败了就只跑出错的那个");
		vi.advanceTimersByTime(100);
		screen.rebuild(transcriptAt(steps, steps.length));
		const replayed = screen.boxes();
		// Fixture integrity: the replay starts a turn at the message after the
		// stopped step, so the live box has two replayed twins settling at the same time.
		expect(replayed.length).toBeGreaterThanOrEqual(2);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(replayed.map((box) => box.state.boxLive)).toEqual(replayed.map(() => false));
		expect(vi.getTimerCount()).toBe(0);
	});
});
