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
	decorateFocusedBlock,
	type ExpandableBlock,
	type FocusableBlock,
	renderedCopyText,
} from "./block-focus.js";
import { SystemNoticeLine } from "./system-notice.js";

type InjectedPromptDetails =
	| AutoContinueMessageDetails
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

	getBlockCopyText(): string {
		return renderedCopyText(super.render(100));
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
					return { label: "↻ auto-continue", detail: "提醒把结果发给父代理" };
				}
				const detail = details?.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "上一步没做完";
				return { label: "↻ auto-continue", detail };
			}
			case HEARTBEAT_PROMPT_CUSTOM_TYPE: {
				const details = this.message.details as HeartbeatPromptDetails | undefined;
				return { label: "♥ heartbeat", detail: heartbeatPromptSchedule(details?.schedule) };
			}
			case IPYTHON_STATE_RESTORED_CUSTOM_TYPE: {
				const details = this.message.details as IpythonStateRestoredDetails | undefined;
				return {
					label: details?.restored === false ? "◆ new python kernel" : "◆ python kernel restored",
					detail: "",
				};
			}
			case RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE:
				return { label: "◇ subagent still running", detail: "" };
			case PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE: {
				const details = this.message.details as PythonSkillsUnavailableDetails | undefined;
				return { label: "⚠ python skills unavailable", detail: details?.skills?.join(", ") ?? "" };
			}
			case RLM_CHILD_FAILURE_CUSTOM_TYPE:
			case RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE:
				return rlmChildFailureLabel(this.message) ? undefined : { label: "◇ subagent status", detail: "" };
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
			const excerpt = details?.excerpt ? `刚才说要「${collapseText(details.excerpt)}」` : "上一步没做完";
			return theme.fg("dim", truncateToWidth(`自动继续：${excerpt}`, 100));
		}
		if (this.message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE) {
			return this.heartbeatHeaderText();
		}
		if (this.message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE) {
			const details = this.message.details as IpythonStateRestoredDetails | undefined;
			const label = details?.restored === false ? "new python kernel" : "python kernel restored";
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
		return `${pulse} ${theme.fg("muted", "heartbeat")}${theme.fg("dim", " · ")}${schedule}`;
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
