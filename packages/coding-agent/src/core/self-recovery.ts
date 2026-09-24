import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DutyEvent } from "./duty-log.js";
import { AUTO_CONTINUE_CUSTOM_TYPE } from "./messages.js";
import type { SessionEntry } from "./session-manager.js";

/**
 * Self-recovery for unattended runs: what the session does on its own when a
 * step hangs, a turn stops right after announcing more work, or a subagent
 * finishes without replying. Every action is recorded as a session entry so a
 * later duty log can say what happened while nobody was watching.
 */

/** Session custom-entry type for one self-recovery action. Not a message: the model never sees it. */
export const SELF_RECOVERY_CUSTOM_ENTRY = "prime-agent.self-recovery";

/** The duty-log event a self-recovery action maps to. */
export function dutyEventFor(record: SelfRecoveryRecord): DutyEvent {
	switch (record.kind) {
		case "stuck_step_stopped":
			return {
				kind: "step_stuck_stopped",
				tool: record.step,
				silentMs: record.silentMs,
				...(record.cause === "time_limit" ? { cause: "time_limit" as const } : {}),
			};
		case "auto_continue":
			return { kind: "auto_continue", reason: record.excerpt };
		case "child_reply_nudge":
			return { kind: "auto_continue", reason: "child_reply_missing" };
	}
}

/** Automatic continues one prompt may receive; the second one is the last. */
export const MAX_AUTO_CONTINUES_PER_PROMPT = 2;

/** Excerpt length carried in the nudge and shown in the UI. */
const PLAN_EXCERPT_MAX_CHARS = 80;

export type SelfRecoveryRecord =
	| {
			kind: "stuck_step_stopped";
			toolCallId: string;
			toolName: string;
			/** Plain description of the step (command or cell preview). */
			step: string;
			silentMs: number;
			/** The same step already got stuck earlier in this run. */
			repeated: boolean;
			/** Absent for a silent step; "time_limit" when a busy step outran an armed watchdog abort budget. */
			cause?: "time_limit";
			at: number;
	  }
	| { kind: "auto_continue"; excerpt: string; ordinal: number; at: number }
	| { kind: "child_reply_nudge"; at: number };

// Where an announcement starts: the head of a clause, after an optional filler word. Only the
// sentence a reply ends on is read, and a mid-clause match ("刚宣布还有下一步就停轮") is a
// description, not a plan.
const CN_ANNOUNCEMENT_HEAD =
	/^(?:(?:那|那么|好|好的|嗯|所以|于是|OK|ok)[，,\s]*)?(?:接下来|下一步|然后我|然后再|现在我|现在开始|我(?:这就|马上|先|将|会|来|去|要|准备|打算)|让我|开始(?![时前的于后])|着手|准备|接着|随后|马上|立即)/u;
const EN_ANNOUNCEMENT_HEAD =
	/^(?:(?:ok(?:ay)?|so|now|then|alright|all right)[,\s]+)*(?:next steps? (?:is|are|will be|would be)|the next step (?:is|will be)|next,? (?:i|we)\b|let me|let's|i(?:'ll| will| am going to|'m going to| need to))\b/i;
// Heads that say "about to" outright. The other heads ("我先", "然后我", "现在我", "开始") read the
// same in a report of what was already done, so a completion particle after them means past tense.
const CN_EXPLICIT_FUTURE = /接下来|下一步|我(?:这就|马上|将|会|来|去|要|准备|打算)|让我/u;
const CN_PAST = /已经|已(?![知有])/u;
const CN_COMPLETED = /了(?!解)|完成|完毕/u;
// "让我总结一下：改了三个文件" is the summary itself, not a promise of more work.
const SUMMARY_BODY =
	/^(?:接下来|让我|我)(?:来|先|再)?(?:总结|汇总|概括|回顾|复盘|梳理|说明|解释|列一下|简单说)|^(?:let me|i(?:'ll| will)) (?:summarize|recap|sum up|explain|walk you through|outline what)/iu;
// A step the owner has to take ("接下来你需要配置 key") is their to-do: nudging the model past it
// only buys a paid turn that repeats the instructions.
const OWNER_STEP =
	/你(?:需要|可以|得|要|来|先|自己)|请你|请(?:手动|自行)|需要你|\byou(?:'ll| will| need| should| can| may| might| have to)\b|\bfor you to\b/iu;
// Future tense that promises no work.
const EN_NON_WORK =
	/^i(?:'ll| will) (?:keep|bear) (?:this|that|it|these)(?: \w+)? in mind|^i(?:'ll| will) (?:remember|note)\b|^i(?:'ll| will) be (?:here|around|available)|^i(?:'ll| will) not\b|^i won't\b/i;
const LIST_ITEM = /^(?:[-*•]|\d+[.、)])\s+/u;
const LIST_MARKER = /^(?:[-*•]|\d+[.、)])\s*(?:\[[ xX]\]\s*)?/u;

// An unchecked item left at the end means the list is not done - when the list is the model's own
// progress tracker (some items already ticked). A list of only unchecked items is usually the
// owner's to-do list ("- [ ] 配置 API key"), and that is a finished answer.
const OPEN_CHECKLIST_PATTERN = /^\s*[-*]\s*\[ \]\s+\S/m;
const DONE_CHECKLIST_PATTERN = /^\s*[-*]\s*\[[xX]\]\s+\S/m;
const OWNER_CHECKLIST_INTRO =
	/你需要|需要你|请你|请(?:手动|自行)|你(?:来|自己)|手动|\bfor you\b|\byou(?:'ll)? need\b|\bmanual/iu;

// Replies that are complete as they are: waiting on children, idle acknowledgements,
// questions to the user. Never nudged (the 1961-turn "待命" loop lesson).
const FINAL_REPLY_PATTERNS: readonly RegExp[] = [
	// "看看是否需要进一步修改" is the model talking to itself, not a question to the owner.
	/待命|等待(?:子代理|回复|结果|你的)|等你|请确认|需要你|你来决定|(?<!看看?|检查|确认|判断|评估)是否需要|(?<!看看?|检查|确认|判断|评估)要不要/u,
	/\b(?:waiting for|standing by|let me know|should i|do you want)\b/i,
	// Offers, not commitments: "接下来我可以……" / "如需要我再……" after a finished answer.
	/(?:我|也|还)(?:可以|能)(?:帮|再|继续|进一步|顺便)|如(?:果)?(?:你)?(?:需要|愿意|想)|如需|若需要|有需要|需要的话/u,
	/\b(?:if you(?:'d)? (?:like|want|need)|i can also|i could|happy to|feel free)\b/i,
	// Waiting on the owner's approval: the step is gated on purpose, never nudged past it.
	/你批准后|你确认后|等你(?:批准|确认|同意|点头)|经你同意|你同意后|你说可以/u,
	/\b(?:once you approve|after your (?:go-ahead|approval|confirmation|ok)|with your permission|until you (?:say|confirm|approve)|i'?ll wait for your)\b/i,
	/[?？]\s*$/u,
];

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function excerptOf(text: string): string {
	const lastLine =
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.at(-1) ?? text;
	return lastLine.length > PLAN_EXCERPT_MAX_CHARS ? `${lastLine.slice(0, PLAN_EXCERPT_MAX_CHARS - 1)}…` : lastLine;
}

/**
 * The announced-but-not-done next step of a turn that just stopped, or undefined
 * when the reply is a real answer. Pure: callers own the caps and gates.
 */
export function announcedNextStep(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = assistantText(message);
	return textAnnouncesNextStep(text) ? excerptOf(text) : undefined;
}

/**
 * Whether a reply's text ends by announcing work it has not done: a next-step
 * phrase in its tail or an unchecked checklist item, and not a final answer, a
 * question or a wait. Shared by auto-continue and the duty log's "可能没做完".
 */
export function textAnnouncesNextStep(text: string): boolean {
	if (!text) return false;
	const tail = text.slice(-240);
	if (FINAL_REPLY_PATTERNS.some((pattern) => pattern.test(tail))) return false;
	if (hasOpenOwnChecklist(text)) return true;
	const announcement = closingAnnouncement(closingSentence(text));
	return announcement !== undefined && announcesWork(announcement);
}

/**
 * The sentence a reply ends on. A closing list defers to the line that introduces it when that
 * line ends with a colon ("接下来我会：" plus steps): the list is the plan's body.
 */
function closingSentence(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	let line = lines.at(-1) ?? "";
	if (LIST_ITEM.test(line)) {
		let top = lines.length - 1;
		while (top > 0 && LIST_ITEM.test(lines[top - 1] ?? "")) top--;
		const intro = lines[top - 1];
		line = intro !== undefined && /[：:]\s*$/u.test(intro) ? intro : line.replace(LIST_MARKER, "");
	}
	const trimmed = line.replace(/[\s。．.!！…：:]+$/u, "");
	const sentences = trimmed
		.split(/[。！？!?]|\.(?=\s)/u)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
	return sentences.at(-1) ?? "";
}

/** The sentence's last announcing clause through the end of the sentence, if any clause announces. */
function closingAnnouncement(sentence: string): string | undefined {
	const clauseStarts: number[] = [0];
	for (const match of sentence.matchAll(/[，,；;：:、（(]\s*/gu)) clauseStarts.push(match.index + match[0].length);
	for (let index = clauseStarts.length - 1; index >= 0; index--) {
		const clause = sentence.slice(clauseStarts[index]);
		if (CN_ANNOUNCEMENT_HEAD.test(clause) || EN_ANNOUNCEMENT_HEAD.test(clause)) return clause;
	}
	return undefined;
}

function announcesWork(announcement: string): boolean {
	// A long sentence that merely opens with "我先" is an explanation, not a one-line plan.
	if (announcement.length > 120) return false;
	if (SUMMARY_BODY.test(announcement) || OWNER_STEP.test(announcement) || EN_NON_WORK.test(announcement)) return false;
	if (CN_PAST.test(announcement)) return false;
	return CN_EXPLICIT_FUTURE.test(announcement) || !CN_COMPLETED.test(announcement);
}

function hasOpenOwnChecklist(text: string): boolean {
	const window = text.slice(-600);
	if (!OPEN_CHECKLIST_PATTERN.test(window) || !DONE_CHECKLIST_PATTERN.test(window)) return false;
	return !OWNER_CHECKLIST_INTRO.test(window);
}

/** Whether this run did tool work after its last user prompt (a pure chat answer is never nudged). */
export function ranToolsSinceLastPrompt(messages: readonly AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") return false;
		if (message?.role === "toolResult") return true;
	}
	return false;
}

/** Automatic continues already sent in this run, for the per-prompt cap. */
export function autoContinuesInRun(messages: readonly AgentMessage[]): number {
	let count = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") break;
		if (message?.role === "custom" && message.customType === AUTO_CONTINUE_CUSTOM_TYPE) count += 1;
	}
	return count;
}

/** Every self-recovery action recorded on a branch, oldest first. */
export function readSelfRecoveryRecords(entries: readonly SessionEntry[]): SelfRecoveryRecord[] {
	const records: SelfRecoveryRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SELF_RECOVERY_CUSTOM_ENTRY) continue;
		const data = entry.data as Partial<SelfRecoveryRecord> | undefined;
		if (!data || typeof data !== "object" || typeof data.kind !== "string" || typeof data.at !== "number") continue;
		if (data.kind === "stuck_step_stopped" || data.kind === "auto_continue" || data.kind === "child_reply_nudge") {
			records.push(data as SelfRecoveryRecord);
		}
	}
	return records;
}
