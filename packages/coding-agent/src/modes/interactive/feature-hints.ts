import type { AppKeybinding } from "../../core/keybindings.js";

export interface FeatureHintContext {
	getKeybinding(action: AppKeybinding): string | undefined;
	isResidentSession: boolean;
}

interface FeatureHintDefinition {
	id: string;
	getText(context: FeatureHintContext): string | undefined;
}

export interface FeatureHint {
	id: string;
	text: string;
}

export const FEATURE_HINTS: readonly FeatureHintDefinition[] = [
	{
		id: "side-question",
		getText: () => "用 /btw <问题> 随时插问，不打断正在工作的代理。",
	},
	{
		id: "prompt-stash",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.prompt.stash");
			return key ? `按 ${key} 暂存当前输入，之后可恢复。` : undefined;
		},
	},
	{
		id: "follow-up",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.message.followUp");
			return key ? `按 ${key} 在代理完成后接着发消息。` : undefined;
		},
	},
	{
		id: "heartbeat",
		getText: () => "用 /heartbeat every 10m <指令> 按周期重复执行任务。",
	},
	{
		id: "subagents",
		getText: () => "可把任务拆给子代理并行执行，代理之间能互发消息协作。",
	},
	{
		id: "agents-view",
		getText: ({ getKeybinding, isResidentSession }) => {
			if (!isResidentSession) return undefined;
			const key = getKeybinding("app.agents.back");
			return key ? `按 ${key} 打开会话视图：查看运行中/空闲/不活跃会话。` : undefined;
		},
	},
	{
		id: "session-rewind",
		getText: () => "用 /tree 打开会话树，回到任意历史消息继续。",
	},
	{
		id: "steering",
		getText: () => "代理工作时随时发消息即可转向调整当前任务。",
	},
	{
		id: "goal",
		getText: () => "用 /goal <目标> 让代理持续工作直到目标完成。",
	},
	{
		id: "refine",
		getText: () => "用 /refine 把经验沉淀成可复用的技能、记忆与提示词。",
	},
	{
		id: "trace-sharing",
		getText: () => "用 /traces on 分享轨迹给 Prime Intellect，训练开源模型。",
	},
	{
		id: "persistent-ipython",
		getText: () => "压缩会清掉超 16 MiB 的内核变量，更小的状态会保留。",
	},
	{
		id: "context-usage",
		getText: () => "用 /context 查看用量、成本与剩余上下文。",
	},
	{
		id: "session-fork",
		getText: () => "用 /fork 从任意历史提示词分叉出新会话。",
	},
	{
		id: "compaction",
		getText: () => "用 /compact <指引> 压缩旧消息释放上下文；超长会话也会自动压缩。",
	},
	{
		id: "background-running",
		getText: ({ isResidentSession }) => (isResidentSession ? "可以关掉终端，代理会在后台继续运行。" : undefined),
	},
] as const;

export class FeatureHintDeck {
	private remaining: FeatureHint[] = [];
	private previousId: string | undefined;

	next(context: FeatureHintContext): FeatureHint | undefined {
		if (this.remaining.length === 0) {
			this.refill(context);
		}
		const hint = this.remaining.pop();
		if (hint) {
			this.previousId = hint.id;
		}
		return hint;
	}

	private refill(context: FeatureHintContext): void {
		const hints = FEATURE_HINTS.flatMap((hint) => {
			const text = hint.getText(context);
			return text ? [{ id: hint.id, text }] : [];
		});
		for (let index = hints.length - 1; index > 0; index--) {
			const target = Math.floor(Math.random() * (index + 1));
			[hints[index], hints[target]] = [hints[target]!, hints[index]!];
		}
		if (hints.length > 1 && hints[hints.length - 1]?.id === this.previousId) {
			[hints[0], hints[hints.length - 1]] = [hints[hints.length - 1]!, hints[0]!];
		}
		this.remaining = hints;
	}
}
