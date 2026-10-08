import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	Clickable,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { GOAL_CONTEXT_CUSTOM_TYPE, type GoalContextDetails } from "../../../core/goals.js";
import {
	AUTO_CONTINUE_CUSTOM_TYPE,
	type AutoContinueMessageDetails,
	type CustomMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	type HeartbeatPromptDetails,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	type IpythonStateRestoredDetails,
	PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
	type PythonSkillsUnavailableDetails,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildFailureDetails,
	type RlmChildStallNoticeDetails,
	type RlmChildTerminalNoticeDetails,
} from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import {
	type BlockFocusState,
	copyFromSource,
	decorateFocusedBlock,
	type ExpandableBlock,
	type FocusableBlock,
} from "./block-focus.js";
import { SystemNoticeLine } from "./system-notice.js";
import { boxRecordFromMessage } from "./turn-timeline.js";

/**
 * The finish gate's release notice: the gate challenged a done-claim, the
 * claim came back without proof again, and the gate let the run end anyway. Emitted from agent-session.ts's
 * finish-gate release branch; the string mirrors the "finish_gate_released"
 * record kind in core/self-recovery.ts (pinned in test/finish-gate-notice.test.ts),
 * the same mirror arrangement as IPYTHON_STATE_PRUNED_CUSTOM_TYPE in
 * conversation-components.ts.
 */
export const FINISH_GATE_RELEASED_CUSTOM_TYPE = "finish_gate_released";

/** Details of the finish gate's release notice (see self-recovery.ts). */
export interface FinishGateReleasedDetails {
	/** The done-claim the gate let through unverified. */
	excerpt?: string;
	/** Nudges the claim survived before the release. */
	strikes?: number;
}

type InjectedPromptDetails =
	| AutoContinueMessageDetails
	| FinishGateReleasedDetails
	| GoalContextDetails
	| HeartbeatPromptDetails
	| IpythonStateRestoredDetails
	| PythonSkillsUnavailableDetails
	| RlmChildFailureDetails
	| RlmChildStallNoticeDetails
	| RlmChildTerminalNoticeDetails;
type InjectedPromptMessage = CustomMessage<InjectedPromptDetails>;

export function isInjectedPromptMessage(message: AgentMessage): message is InjectedPromptMessage {
	return (
		message.role === "custom" &&
		(message.customType === AUTO_CONTINUE_CUSTOM_TYPE ||
			message.customType === FINISH_GATE_RELEASED_CUSTOM_TYPE ||
			message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE ||
			message.customType === GOAL_CONTEXT_CUSTOM_TYPE ||
			message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE ||
			message.customType === PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)
	);
}

function readCustomText(message: CustomMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function goalLabel(details: GoalContextDetails | undefined): string {
	switch (details?.kind) {
		case "continuation":
			return "继续目标";
		case "budget_limit":
			return "目标预算用尽";
		case "objective_updated":
			return "目标已更新";
		default:
			return "目标";
	}
}

/** Error-colored header label for a child failure notice, or undefined for routine notices. */
function rlmChildFailureLabel(message: InjectedPromptMessage): string | undefined {
	if (message.customType !== RLM_CHILD_FAILURE_CUSTOM_TYPE) return undefined;
	const details = message.details as RlmChildFailureDetails | undefined;
	const kind = details?.kind;
	if (!kind) return "子代理失败";
	const label = kind === "stall_killed" ? "长时间没动静，被自动终止" : kind === "aborted" ? "已中止" : "出错";
	return `子代理失败（${label}）`;
}

function compactHeartbeatSchedule(schedule: string | undefined): string {
	const trimmed = schedule?.trim();
	if (!trimmed) {
		return "prompt";
	}
	return trimmed.replace(/^(?:every\s+|每\s*)/i, "");
}

function heartbeatPromptSchedule(schedule: string | undefined): string {
	const compact = compactHeartbeatSchedule(schedule);
	return compact === "prompt" ? "定时" : `每 ${compact}`;
}

export class InjectedPromptMessageComponent extends Container implements FocusableBlock, ExpandableBlock {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private expanded = false;
	private blockFocus?: BlockFocusState;

	constructor(
		private readonly message: InjectedPromptMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	isBlockExpanded(): boolean {
		return this.expanded;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	/**
	 * What `y` copies: the card's headline and the prompt text the message holds. The rendered rows
	 * wrap both to the width, so a long prompt (a heartbeat's, a goal's) copied from them came back
	 * as one line per row with its paragraphs gone.
	 */
	getBlockCopyText(): string {
		return copyFromSource(this.headline(), readCustomText(this.message));
	}

	/** The card's own first line in plain words, whichever face it shows. */
	private headline(): string {
		const notice = this.noticeParts();
		const words = notice ? [notice.label, notice.detail].filter((part) => part !== "").join("  ") : this.headerText();
		return stripAnsi(words).replace(/\s+/g, " ").trim();
	}

	private updateDisplay(): void {
		this.content.clear();
		const toggle = () => this.setExpanded(!this.expanded);
		// v3: a routine notice is one centered faint line while collapsed. A child
		// failure keeps its loud header: it is the parent's only sign a child died.
		const notice = this.expanded ? undefined : this.noticeParts();
		if (notice) {
			this.content.addChild(new Clickable(new SystemNoticeLine(notice.label, notice.detail), toggle));
			return;
		}
		this.header.setText(this.headerText());
		this.content.addChild(new Clickable(this.header, toggle));
		if (this.expanded && this.message.customType !== IPYTHON_STATE_RESTORED_CUSTOM_TYPE) {
			this.content.addChild(
				new Markdown(readCustomText(this.message), 1, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}
	}

	/** The collapsed one-liner of a routine notice; undefined for a failure (loud header). */
	private noticeParts(): { label: string; detail: string } | undefined {
		switch (this.message.customType) {
			case AUTO_CONTINUE_CUSTOM_TYPE: {
				const details = this.message.details as AutoContinueMessageDetails | undefined;
				if (details?.reason === "child_reply_missing") {
					return { label: "↻ 自动继续", detail: "提醒把结果发给父代理" };
				}
				if (details?.reason === "finish_gate") {
					// The finish gate challenged a done-claim: not a routine continue, so it
					// must not wear the generic "自动继续" label - the owner has to see the
					// run was caught finishing without proof.
					const detail = details.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "完成声明没有证据";
					return { label: "⚠ 完成核验 · 要求给出证据", detail };
				}
				const detail = details?.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "上一步没做完";
				return { label: "↻ 自动继续", detail };
			}
			case FINISH_GATE_RELEASED_CUSTOM_TYPE: {
				// Not a continue: the gate let the claim through unproven, so the row
				// says who has to check it now.
				const details = this.message.details as FinishGateReleasedDetails | undefined;
				const claim = details?.excerpt
					? `说要「${collapseText(details.excerpt)}」的证据始终没给`
					: "完成声明始终没给出证据";
				return { label: "⚠ 完成核验 · 已放行（未验证）", detail: `${claim}，结论待你核对` };
			}
			case HEARTBEAT_PROMPT_CUSTOM_TYPE: {
				const details = this.message.details as HeartbeatPromptDetails | undefined;
				return { label: "♥ 定时任务", detail: heartbeatPromptSchedule(details?.schedule) };
			}
			case IPYTHON_STATE_RESTORED_CUSTOM_TYPE: {
				const details = this.message.details as IpythonStateRestoredDetails | undefined;
				return {
					label: details?.restored === false ? "◆ 新开了 Python 环境" : "◆ Python 环境已恢复",
					detail: "",
				};
			}
			case RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE:
				return { label: "◇ 子代理还在跑", detail: "" };
			case PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE: {
				const details = this.message.details as PythonSkillsUnavailableDetails | undefined;
				return { label: "⚠ 部分 Python 技能不可用", detail: details?.skills?.join(", ") ?? "" };
			}
			case RLM_CHILD_FAILURE_CUSTOM_TYPE:
			case RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE: {
				if (rlmChildFailureLabel(this.message)) return undefined;
				const record = boxRecordFromMessage(this.message);
				return { label: `◇ ${record?.kind === "notice" ? record.notice.text : "子代理状态"}`, detail: "" };
			}
			default: {
				const goal = this.message.details as GoalContextDetails | undefined;
				return {
					label: `◎ ${goalLabel(goal)}`,
					detail: goal?.objective ? collapseText(goal.objective) : "",
				};
			}
		}
	}

	private headerText(): string {
		if (this.message.customType === AUTO_CONTINUE_CUSTOM_TYPE) {
			// The session continued on its own: one quiet row saying why.
			const details = this.message.details as AutoContinueMessageDetails | undefined;
			if (details?.reason === "child_reply_missing") return theme.fg("dim", "自动继续：提醒把结果发给父代理");
			if (details?.reason === "finish_gate") {
				const excerpt = details.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "完成声明没有证据";
				return theme.fg("dim", truncateToWidth(`完成核验：${excerpt}，要求给出证据`, 100));
			}
			const excerpt = details?.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "上一步没做完";
			return theme.fg("dim", truncateToWidth(`自动继续：${excerpt}`, 100));
		}
		if (this.message.customType === FINISH_GATE_RELEASED_CUSTOM_TYPE) {
			const details = this.message.details as FinishGateReleasedDetails | undefined;
			const strikes =
				typeof details?.strikes === "number" && details.strikes > 1
					? `连问 ${details.strikes} 次仍无证据`
					: "始终没给出证据";
			const claim = details?.excerpt ? `说要「${collapseText(details.excerpt)}」，` : "";
			return theme.fg("dim", truncateToWidth(`完成核验：${claim}${strikes}，已放行，结论待你核对`, 100));
		}
		if (this.message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE) {
			return this.heartbeatHeaderText();
		}
		if (this.message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE) {
			const details = this.message.details as IpythonStateRestoredDetails | undefined;
			const label = details?.restored === false ? "新开了 Python 环境" : "Python 环境已恢复";
			return `${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`;
		}
		if (this.message.customType === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE) {
			// Not an error: the silence may be healthy long work. The label says what is
			// known ("still running"), and the expanded body carries the facts.
			return theme.fg("muted", "子代理仍在运行");
		}
		if (this.message.customType === PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE) {
			const details = this.message.details as PythonSkillsUnavailableDetails | undefined;
			const skills = details?.skills?.length
				? ` · ${truncateToWidth(details.skills.join(", "), Math.max(20, 90 - visibleWidth("部分 Python 技能不可用 · ")))}`
				: "";
			return theme.fg("muted", "部分 Python 技能不可用") + theme.fg("dim", skills);
		}
		if (
			this.message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			this.message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
		) {
			const failure = rlmChildFailureLabel(this.message);
			// Failure kinds (stall_killed/aborted/error) are the parent's only signal
			// that a child died; rendering them in the same muted color as a routine
			// "completed without reply" notice hides exactly the case that matters.
			if (failure) return theme.fg("error", failure);
			return theme.fg("muted", "子代理状态");
		}

		const details = this.message.details;
		const title = goalLabel(details as GoalContextDetails | undefined);
		const meta = this.metaText();
		return theme.fg("muted", title) + meta;
	}

	private heartbeatHeaderText(): string {
		const details = this.message.details as HeartbeatPromptDetails | undefined;
		const pulse = theme.fg("error", "♥");
		const schedule = theme.fg("muted", heartbeatPromptSchedule(details?.schedule));
		return `${pulse} ${theme.fg("muted", "定时任务")}${theme.fg("dim", " · ")}${schedule}`;
	}

	private metaText(): string {
		const details = this.message.details;
		const goal = details as GoalContextDetails | undefined;
		if (!goal?.objective) {
			return "";
		}
		const prefixWidth = visibleWidth("继续目标 · ");
		return theme.fg("muted", ` · ${truncateToWidth(collapseText(goal.objective), Math.max(20, 90 - prefixWidth))}`);
	}
}
