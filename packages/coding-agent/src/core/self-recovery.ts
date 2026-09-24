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
			return { kind: "step_stuck_stopped", tool: record.step, silentMs: record.silentMs };
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
			at: number;
	  }
	| { kind: "auto_continue"; excerpt: string; ordinal: number; at: number }
	| { kind: "child_reply_nudge"; at: number };

// Phrases that announce work still to come. Matched only in the reply's tail, so an
// answer that merely mentions a plan somewhere in the middle is left alone.
const NEXT_STEP_PATTERNS: readonly RegExp[] = [
	/(?:^|[\s，。；：、（(])(?:接下来|下一步|然后我|现在我|我(?:这就|马上|先|将|会|来|去)|让我(?:先|再|来|去)?)[^。！？\n]{0,80}$/u,
	/\b(?:let me|i(?:'ll| will| am going to|'m going to)|next,? i(?:'ll| will)|now i(?:'ll| will))\b[^.!?\n]{0,120}[:.…]?\s*$/i,
];

// An unchecked checklist item left at the end means the list is not done.
const OPEN_CHECKLIST_PATTERN = /^\s*[-*]\s*\[ \]\s+\S/m;

// Replies that are complete as they are: waiting on children, idle acknowledgements,
// questions to the user. Never nudged (the 1961-turn "待命" loop lesson).
const FINAL_REPLY_PATTERNS: readonly RegExp[] = [
	/待命|等待(?:子代理|回复|结果|你的)|等你|请确认|需要你|你来决定|是否需要|要不要/u,
	/\b(?:waiting for|standing by|let me know|should i|do you want)\b/i,
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
	if (!text) return undefined;
	const tail = text.slice(-240);
	if (FINAL_REPLY_PATTERNS.some((pattern) => pattern.test(tail))) return undefined;
	const announces =
		NEXT_STEP_PATTERNS.some((pattern) => pattern.test(tail)) || OPEN_CHECKLIST_PATTERN.test(text.slice(-600));
	return announces ? excerptOf(text) : undefined;
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
