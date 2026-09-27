import type { Model, ThinkingLevelMap } from "./types.js";

/**
 * Models served through the locally installed Claude Code CLI, billed to the user's
 * Claude subscription. The ids are full model ids, which Claude Code accepts for
 * `--model`, so the picker shows exactly which model runs. A new Claude release needs an
 * entry here; they are not fetched from any provider catalog, which is why they live
 * outside models.generated.ts.
 *
 * Context windows are what Claude Code reports for a subscription account (`/context`,
 * 2026-09-27). Costs are zero: usage draws from the plan, not from per-token billing.
 */
const ADAPTIVE_EFFORT_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function claudeCodeModel(
	id: string,
	name: string,
	contextWindow: number,
	thinkingLevelMap: ThinkingLevelMap,
): Model<"claude-code"> {
	return {
		id,
		name,
		api: "claude-code",
		provider: "claude-code",
		baseUrl: "",
		reasoning: true,
		thinkingLevelMap,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens: 64000,
	};
}

export const CLAUDE_CODE_MODELS: Model<"claude-code">[] = [
	{
		...claudeCodeModel("claude-opus-5-5", "Claude Opus 5.5 (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS),
		featured: true,
	},
	claudeCodeModel("claude-sonnet-5", "Claude Sonnet 5 (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS),
	claudeCodeModel("claude-fable-5-1", "Claude Fable 5.1 (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS),
	claudeCodeModel("claude-haiku-4-5", "Claude Haiku 4.5 (Claude Code)", 200_000, {
		off: null,
		xhigh: null,
		max: null,
	}),
];
