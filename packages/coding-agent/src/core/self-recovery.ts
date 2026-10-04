import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { DutyEvent } from "./duty-log.js";
import { AUTO_CONTINUE_CUSTOM_TYPE, type AutoContinueMessageDetails, type CustomMessage } from "./messages.js";
import type { SessionEntry } from "./session-manager.js";

/**
 * Self-recovery for unattended runs: what the session does on its own when a
 * step hangs, a turn stops right after announcing more work, a run ends on a
 * completion claim it never proved, or a subagent finishes without replying.
 * Every action is recorded as a session entry so a later duty log can say what
 * happened while nobody was watching.
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
		case "finish_gate_released":
			// Not handled work: the claim went out unverified, so the owner should check it.
			return {
				kind: "decision_needed",
				question:
					record.cause === "budget_exhausted"
						? `AI 声称完成，续跑预算耗尽（已追问 ${record.strikes} 次）仍无验证证据，已放行，结论待你核对`
						: `AI 声称完成但 ${record.strikes} 次拿不出验证证据，已放行，结论待你核对`,
			};
	}
}

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
	| { kind: "child_reply_nudge"; at: number }
	| {
			/**
			 * The finish gate let a completion claim through after the model kept
			 * claiming done without showing proof: recorded so the transcript and the
			 * duty log carry that the claim was never verified.
			 */
			kind: "finish_gate_released";
			excerpt: string;
			/** Gate nudges this run sent for the claim before the release. */
			strikes: number;
			ordinal: number;
			/** "budget_exhausted": the continuation budget ran out before the strikes did. */
			cause?: "budget_exhausted";
			at: number;
	  };

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
// waiting on the owner's approval. Never nudged (the 1961-turn "待命" loop lesson).
const FINAL_REPLY_PATTERNS: readonly RegExp[] = [
	// "看看是否需要进一步修改" is the model talking to itself, not a question to the owner.
	/待命|等待(?:子代理|回复|结果|你的)|等你|请确认|需要你|你来决定|(?<!看看?|检查|确认|判断|评估)是否需要|(?<!看看?|检查|确认|判断|评估)要不要/u,
	/\b(?:waiting for|standing by)\b/i,
	// Waiting on the owner's approval: the step is gated on purpose, never nudged past it.
	/你批准后|你确认后|等你(?:批准|确认|同意|点头)|经你同意|你同意后|你说可以/u,
	/\b(?:once you approve|after your (?:go-ahead|approval|confirmation|ok)|with your permission|until you (?:say|confirm|approve)|i'?ll wait for your)\b/i,
];

// Questions and offers read as a finished answer only when the turn was pure chat.
// A turn that already ran tools is mid-task: the same ending parks the work on a
// question nobody is there to answer, so these exemptions stop applying once the
// run has tool work on the books (the nudge message itself tells the model a
// finished task should just say so).
const QUESTION_OR_OFFER_PATTERNS: readonly RegExp[] = [
	/\b(?:let me know|should i|do you want)\b/i,
	// Offers, not commitments: "接下来我可以……" / "如需要我再……" after a finished answer.
	/(?:我|也|还)(?:可以|能)(?:帮|再|继续|进一步|顺便)|如(?:果)?(?:你)?(?:需要|愿意|想)|如需|若需要|有需要|需要的话/u,
	/\b(?:if you(?:'d)? (?:like|want|need)|i can also|i could|happy to|feel free)\b/i,
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

export interface AnnouncementScanOptions {
	/**
	 * The turn this reply belongs to already ran tools. A pure chat answer that ends
	 * in a question or an offer is a finished answer; the same ending after real tool
	 * work parks a task nobody is watching, so those two exemptions stop applying.
	 */
	ranTools?: boolean;
}

/**
 * The announced-but-not-done next step of a turn that just stopped, or undefined
 * when the reply is a real answer. Pure: callers own the caps and gates.
 */
export function announcedNextStep(message: AssistantMessage, options?: AnnouncementScanOptions): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = assistantText(message);
	return textAnnouncesNextStep(text, options) ? excerptOf(text) : undefined;
}

/**
 * Whether a reply's text ends by announcing work it has not done: a next-step
 * phrase in its tail or an unchecked checklist item, and not a final answer, a
 * question or a wait. Shared by auto-continue and the duty log's "可能没做完".
 */
export function textAnnouncesNextStep(text: string, options?: AnnouncementScanOptions): boolean {
	if (!text) return false;
	const tail = text.slice(-240);
	if (FINAL_REPLY_PATTERNS.some((pattern) => pattern.test(tail))) return false;
	if (!options?.ranTools && QUESTION_OR_OFFER_PATTERNS.some((pattern) => pattern.test(tail))) return false;
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

/**
 * The finish gate (the Stop-hook / goal-judge pattern applied at the turn boundary):
 * a run that ends on a completion claim gets asked for the proof before it may stop.
 * Detection is heuristic by design - a misfire costs one paid turn, a miss costs the
 * owner a false "done" - so the claim set stays small and strong, exemptions stay
 * wide, and two nudges without proof release the run (see FINISH_GATE_MAX_STRIKES).
 */

/**
 * Consecutive finish-gate nudges one claim may draw before the run is let go: each
 * nudge is a paid turn, and a model that answers the ask with the same bare claim
 * twice is not going to produce the proof on a third.
 */
export const FINISH_GATE_MAX_STRIKES = 2;

// Strong completion declarations only ("改好了", "done", "fixed", ...). Weak ones
// ("跑完了", "写完了") stay out: they report a step, not the task.
const CN_COMPLETION_CLAIM =
	/完成了|已完成|全部完成|任务完成|修好了|修复了|已修复|修复完成|搞定了|弄好了|改好了|改完了|做完了|做好了|已全部/u;
const EN_COMPLETION_CLAIM = /\b(?:all done|done|fixed|completed|finished|resolved|implemented|all set)\b/i;

// The claim is backed when the reply itself cites the proof: a test or check that
// passed, a clean exit, a verification that already happened.
const CN_EVIDENCE =
	/测试(?:全部|全|都)?通过|全部通过|跑通了|编译通过|构建(?:成功|通过)|已验证|验证(?:通过|过)了?|校验通过|检查(?:通过|完毕)|用例(?:全部|全)?通过|已核对/u;
const EN_EVIDENCE =
	/\b\d+\s+tests?\s+pass(?:ed)?\b|\btests?\s+(?:all\s+)?pass(?:es|ed)?\b|\ball tests pass\b|\btest suite is green\b|\bbuild (?:succeeds|succeeded|passes|passed)\b|\bchecks? pass(?:es|ed)?\b|\bverification pass(?:es|ed)?\b|\bproof complete\b|\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+0\b|\blint(?:s)? (?:is|are) clean\b|\bverified\b/i;

// A task-shaped prompt ("修复这个 bug", "fix the footer") makes a completion claim
// with no tool work suspicious on its own; pure chat never reaches the gate.
const CN_TASK_VERB =
	/修复|修一下|修好|实现|添加|加上|新增|删除|删掉|去掉|运行|跑一下|跑通|执行|检查|排查|分析|部署|更新|升级|重构|优化|安装|配置|迁移|改写|写个|写一个|做一?个|做一下|解决|处理|调查|看下|看看|查一下/u;
const EN_TASK_VERB =
	/\b(?:fix|implement|add|create|write|update|change|refactor|remove|delete|run|execute|check|investigate|debug|deploy|build|test|install|configure|migrate|optimize|resolve|verify)\b/i;

// A command that checks the work: when one of these ran green earlier in the run,
// the transcript already carries the proof and the claim does not need to repeat it.
const VERIFICATION_COMMAND =
	/(?:^|[\s;&|`"'(])(?:(?:npm|pnpm|yarn|bun|deno|npx|uv|uvx|cargo|go|mvn|gradle|make|xcodebuild|swift|bazel)\s+[^\n;&|]{0,120}?\b(?:tests?|spec|check|build|lint|type-?check|compile|verify|clippy)\b|py\.?test|vitest|jest|mocha|phpunit|rspec|ctest|tsc|tsgo|eslint|biome\s+check|ruff\s+check|mypy|pyright)(?=[\s;'")]|$)/i;

// A shell command that can change project files. A classic shell tool's result
// carries no tracked change list (change tracking lives in the REPL kernel), so
// the command text is the transcript's only evidence of the write: a clean result
// of one of these voids an earlier green the same way a tracked edit does. The
// redirect alternative is meant for command lines only - cell code never takes
// this branch, where `>` is a comparison - and it excludes fd duplication
// (`2>&1`) and `>=`. A `>` inside quoted data over-voids; the cost of a false
// void is one re-run, the cost of a missed one is a stale pass standing.
const SHELL_WRITE_COMMAND =
	/(?:^|[\s;&|`(])(?:sed\s+[^;&|\n]*?-i\b|perl\s+[^;&|\n]*?-i\b|tee\b|mv\b|cp\b|rm\b|touch\b|patch\b|truncate\b|dd\b|install\b|rsync\b|git\s+(?:apply|checkout|restore|clean|reset|merge|rebase|cherry-pick|revert|am|stash)\b|(?:\d+)?>>?(?![&=]))/i;

// What "ran green" means depends on the surface the check ran on. A direct shell tool
// fails a non-zero exit into an error result (tools/bash.ts), so a clean result is
// exit 0 by construction. A REPL cell instead runs the check inside Python, where
// `r = await bash('npm test')` leaves the cell clean whether the tests passed or not -
// the exit code is data, and the transcript carries the proof only when the cell's
// visible output shows it. A cell whose output shows no verdict is an unknown, not a
// green: the gate would rather nudge once more than call a red run proof.

// Pass proof in a cell's visible output: a zero exit code or the runner's pass wording.
const CELL_PASS_TEXT =
	/\bexit[_ ]?code\b\s*[=:]?\s*0(?!\d)|\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?0(?!\d)|\b[1-9]\d*\s+(?:passed|passing)\b|\btest result:\s*ok\b|测试(?:全部|全|都)?通过|全部通过|构建(?:成功|通过)|编译通过/i;
// Line-anchored runner tokens, in the case the runner prints them (go test, unittest).
const CELL_PASS_LINE = /^ok\s+\S|^PASS$|^OK$/m;
// Failure proof in the visible output. Checked before the pass patterns so a mixed
// summary ("2 failed, 47 passed") reads as the failure it is.
const CELL_FAIL_TEXT =
	/\bexit[_ ]?code\b\s*[=:]?\s*[1-9]\d*|\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*|\b[1-9]\d*\s+(?:failed|errors?)\b|\btest result:\s*failed\b|测试失败|构建失败|编译失败/i;
const CELL_FAIL_LOUD = /\bFAIL(?:ED)?\b/;
// The whole output is one integer: the bare `print(r.exit_code)` verdict.
const BARE_EXIT_CODE = /^\s*(\d+)\s*$/;
// A cell whose code asserts the command's exit code proves the run by finishing
// clean: the same assert failing would have errored the cell instead.
const CELL_ASSERTS_EXIT_CODE = /\bassert\b[^\n;]*\bexit_code\b/;

/** Whether a prompt reads as a task ("修复这个 bug") rather than chat ("这个函数是干什么的"). */
function promptRequestsWork(promptText: string | undefined): boolean {
	if (!promptText) return false;
	const head = promptText.trim().slice(0, 400);
	return CN_TASK_VERB.test(head) || EN_TASK_VERB.test(head);
}

/** Text of the prompt that opened this run (the last user message in it), when known. */
export function lastUserPromptText(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block): block is TextContent => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		return text.trim() || undefined;
	}
	return undefined;
}

/**
 * Whether this run already produced its own proof: a verification-shaped command
 * (a test suite, a build, a lint or type check) whose latest run came back green
 * after the last user prompt, with no project file changed since. The claim then
 * stands on the transcript and citing it is courtesy, not a gate-worthy omission.
 *
 * "Green" is strict by design: an error result is always red, and so is visible
 * failure wording in the output; a REPL cell additionally needs the pass visible
 * in its own output (a zero exit code, the runner's pass wording, or an assert on
 * the exit code in the cell's code), because a clean cell only proves the Python
 * ran. A green run is voided by a later red run and by any project file change
 * after it (an edit result, a cell whose tracked changes touch the project, a
 * shell command whose text writes files, or a cell whose change tracking says it
 * is incomplete - an unseen write voids the pass the same way a seen one does);
 * the result that ran the check never voids itself - a coverage write happens
 * before the verdict it carries.
 */
export function runHasVerificationEvidence(messages: readonly AgentMessage[]): boolean {
	// The run starts after its last user prompt.
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			start = index + 1;
			break;
		}
	}
	const calls = new Map<string, { command: string; cell: boolean }>();
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			if (typeof args?.command === "string") calls.set(block.id, { command: args.command, cell: false });
			else if (typeof args?.code === "string") calls.set(block.id, { command: args.code, cell: true });
			else if (typeof args?.cmd === "string") calls.set(block.id, { command: args.cmd, cell: false });
		}
	}
	if (calls.size === 0) return false;
	// Forward, so the latest verdict wins: a later red run and a later project file
	// change each void an earlier green.
	let verified = false;
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		if (resultChangedProjectFiles(message, call)) verified = false;
		if (resultHasIncompleteChangeTracking(message)) verified = false;
		if (call === undefined || !VERIFICATION_COMMAND.test(call.command)) continue;
		const outcome = verificationOutcome(call, message);
		if (outcome === "green") verified = true;
		else if (outcome === "red") verified = false;
	}
	return verified;
}

type VerificationOutcome = "green" | "red" | "unknown";

function verificationOutcome(
	call: { command: string; cell: boolean },
	result: Extract<AgentMessage, { role: "toolResult" }>,
): VerificationOutcome {
	if (result.isError) return "red";
	const text = result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (CELL_FAIL_TEXT.test(text) || CELL_FAIL_LOUD.test(text)) return "red";
	// A direct shell tool's clean result is exit 0 by construction.
	if (!call.cell) return "green";
	if (CELL_ASSERTS_EXIT_CODE.test(call.command)) return "green";
	if (CELL_PASS_TEXT.test(text) || CELL_PASS_LINE.test(text)) return "green";
	const bare = BARE_EXIT_CODE.exec(text);
	if (bare) return bare[1] === "0" ? "green" : "red";
	return "unknown";
}

/** Whether a clean tool result changed project files - the event that voids a green run. */
function resultChangedProjectFiles(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	call: { command: string; cell: boolean } | undefined,
): boolean {
	// A clean edit result is a change by construction; a no-op edit is an error result.
	if (message.toolName === "edit") return !message.isError;
	// A REPL cell's tracked file effects; scratch and harness-memory writes do not
	// touch what the check verified. The write landed before any error the cell
	// raised afterwards, so an errored cell's tracked changes still count.
	const details = message.details as { fileChanges?: unknown } | undefined;
	const changes = details?.fileChanges;
	if (
		Array.isArray(changes) &&
		changes.some(
			(change) =>
				typeof change === "object" && change !== null && (change as { scope?: unknown }).scope === "project",
		)
	) {
		return true;
	}
	if (message.isError) return false;
	// A classic shell tool has no tracked change list; the command text is the only
	// evidence of the write (see SHELL_WRITE_COMMAND).
	return call !== undefined && !call.cell && SHELL_WRITE_COMMAND.test(call.command);
}

/**
 * Whether a result's change tracking says it is partial (a snapshot that ran out of
 * budget, too many files to list, ...). An incomplete list may be missing the write
 * that voids a green run, so the gate reads incomplete as a change: "不完整则不作数".
 * The result that ran the check re-proves itself - the verdict comes from its own
 * output, and its own writes are forgiven by the coverage rule either way.
 */
function resultHasIncompleteChangeTracking(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	const details = message.details as { changeTrackingIncomplete?: unknown } | undefined;
	return typeof details?.changeTrackingIncomplete === "string" && details.changeTrackingIncomplete.length > 0;
}

export interface FinishGateScanOptions {
	/** The run did tool work after its last user prompt. */
	ranTools: boolean;
	/** Text of the prompt that opened the run, when known (the no-tool-work lane needs it). */
	promptText?: string;
	/** A verification-shaped command already ran green in this run (see runHasVerificationEvidence). */
	verifiedWork?: boolean;
}

/**
 * Whether a reply declares the task done without showing the proof, in a turn the
 * gate applies to: the run did tool work, or the prompt asked for work. Waits,
 * approval gates and - for a tool-free turn - questions and offers stay final
 * answers; a claim that cites its evidence (or follows a green verification command)
 * is a finished answer, not a bare one.
 *
 * The claim itself is read off the sentence the reply ends on: a reply that
 * mentions "fixed"/"implemented"/"修好了" mid-text is reporting what happened,
 * and gating it asks a paid turn to re-prove work nobody claimed. The evidence
 * scan still covers the whole reply, so a proof cited earlier backs the claim.
 */
function textClaimsCompletionWithoutEvidence(text: string, options: FinishGateScanOptions): boolean {
	if (!text) return false;
	if (!options.ranTools && !promptRequestsWork(options.promptText)) return false;
	if (options.verifiedWork) return false;
	const tail = text.slice(-240);
	if (FINAL_REPLY_PATTERNS.some((pattern) => pattern.test(tail))) return false;
	if (!options.ranTools && QUESTION_OR_OFFER_PATTERNS.some((pattern) => pattern.test(tail))) return false;
	const closing = closingSentence(text);
	if (!CN_COMPLETION_CLAIM.test(closing) && !EN_COMPLETION_CLAIM.test(closing)) return false;
	return !CN_EVIDENCE.test(text) && !EN_EVIDENCE.test(text);
}

/**
 * The unproven completion claim of a turn that just stopped, or undefined when the
 * reply is a real answer. Pure: callers own the budget, the strike count and the
 * release. Mirrors announcedNextStep's guards (clean stop, no pending tool call).
 */
export function completionClaimWithoutEvidence(
	message: AssistantMessage,
	options: FinishGateScanOptions,
): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = assistantText(message);
	return textClaimsCompletionWithoutEvidence(text, options) ? excerptOf(text) : undefined;
}

/**
 * Finish-gate nudges this run already sent. Tool work after a nudge does not
 * reset the count: any toolResult used to restart it, so the "run a check,
 * watch it come back red, claim done anyway" loop never accumulated the strikes
 * the release needs. The genuine-work exemption lives one layer up instead - a
 * verification-shaped command that ran green makes the next claim unflagged
 * (verifiedWork), so a reset here would only ever fire for a run the claim scan
 * already cleared. The caller releases the run once this reaches
 * FINISH_GATE_MAX_STRIKES.
 */
export function finishGateStrikesInRun(messages: readonly AgentMessage[]): number {
	let strikes = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") break;
		if (message?.role === "custom" && message.customType === AUTO_CONTINUE_CUSTOM_TYPE) {
			const details = message.details as Partial<AutoContinueMessageDetails> | undefined;
			if (details?.reason === "finish_gate") strikes += 1;
		}
	}
	return strikes;
}

/** Every self-recovery action recorded on a branch, oldest first. */
export function readSelfRecoveryRecords(entries: readonly SessionEntry[]): SelfRecoveryRecord[] {
	const records: SelfRecoveryRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SELF_RECOVERY_CUSTOM_ENTRY) continue;
		const data = entry.data as Partial<SelfRecoveryRecord> | undefined;
		if (!data || typeof data !== "object" || typeof data.kind !== "string" || typeof data.at !== "number") continue;
		if (
			data.kind === "stuck_step_stopped" ||
			data.kind === "auto_continue" ||
			data.kind === "child_reply_nudge" ||
			data.kind === "finish_gate_released"
		) {
			records.push(data as SelfRecoveryRecord);
		}
	}
	return records;
}

/** Details of the automatic continue that resumes a turn cut off by the output budget. */
export interface OutputTruncatedContinueDetails {
	reason: "output_truncated";
	ordinal: number;
	maxOrdinal: number;
	/**
	 * Set when the truncated turn is a subagent's: its transcript prose is not the
	 * deliverable, so the message also says the result must be sent to the parent
	 * before stopping.
	 */
	deliverable?: "parent_reply";
}

/**
 * The session's own continue after a turn cut off by the output budget (stopReason
 * "length" - which is also how a provider pause the model layer reports as a length
 * stop arrives): the answer stopped mid-sentence, so the instruction is to resume,
 * not to re-plan. It carries the AUTO_CONTINUE custom type, so it counts into the
 * same per-prompt budget as the announced-next-step continues; `display: true`
 * keeps it visible and auditable.
 */
export function createOutputTruncatedContinueMessage(
	details: OutputTruncatedContinueDetails,
	timestamp = Date.now(),
): CustomMessage<OutputTruncatedContinueDetails> {
	return {
		role: "custom",
		customType: AUTO_CONTINUE_CUSTOM_TYPE,
		content: [
			`[auto-continue] Your last reply was cut off by the output limit (stopReason: "length"): the turn ended mid-answer and the work is not done.`,
			"Continue from where you stopped: pick up the interrupted sentence or step and carry on. Do not restart, re-explain, or repeat what is already in the transcript; when the next move is a tool call, make it. Once the work is finished and verified, end with the result stated plainly.",
			...(details.deliverable === "parent_reply"
				? [
						"Your reply text is not the deliverable: the parent agent sees only what you send with `agent_message.send`, so when the work is finished, send the result before you stop.",
					]
				: []),
			`This is an automatic continue (${details.ordinal} of at most ${details.maxOrdinal} for this request).`,
		].join("\n"),
		display: true,
		details,
		timestamp,
	};
}

/** Session custom-message type for the one-shot recovery turn after an exhausted provider retry ladder. */
export const PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE = "provider_failure_recovery";

/** The failure shape handed back to the model when the provider retry ladder ran out. */
export interface ProviderFailureRecoveryDetails {
	attempts: number;
	waitClass: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
}

/**
 * The one-shot recovery continuation after the provider retry ladder is spent
 * (the empty-response ladder's recovery has the same shape): the failure goes
 * back to the model itself, so the task gets one turn to recover or to say
 * exactly what it needs instead of ending in a silent stop. `display: true`
 * keeps the transcript auditable.
 */
export function createProviderFailureRecoveryMessage(
	details: ProviderFailureRecoveryDetails,
	timestamp = Date.now(),
): CustomMessage<ProviderFailureRecoveryDetails> {
	const facts = [`attempts: ${details.attempts}`, `class: ${details.waitClass}`];
	if (details.provider && details.model) facts.push(`model: ${details.provider}/${details.model}`);
	if (details.errorMessage) {
		const error = details.errorMessage;
		facts.push(`last error: ${error.length > 300 ? `${error.slice(0, 299)}…` : error}`);
	}
	return {
		role: "custom",
		customType: PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE,
		content: [
			`[provider-failure recovery] The last model request kept failing at the provider until the automatic retry ladder was spent (${facts.join("; ")}), so the session stopped resending rather than burn budget against an endpoint that keeps saying no.`,
			"The context is intact and the task is still open. This is not a user instruction: it is the failure shape, handed to you because the alternative was the run ending here without a word.",
			"Pick the work back up yourself; nobody else will. The action you meant to take last may or may not have happened, and repeating a half-done edit or commit can do damage, so look at the current state before redoing anything. Save in-progress work to files now, so another failure does not lose it. If the failure is one only the owner can fix (credentials, quota, network), say in your reply exactly what is needed: a silent end reads to the owner as a finished task. A subagent sends its parent one short status line, because the parent cannot see this notice.",
			"This is an automatic one-shot continuation; the system will not send another for this failure episode.",
		].join("\n"),
		display: true,
		details,
		timestamp,
	};
}
