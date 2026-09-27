import type { Model, ThinkingLevelMap } from "./types.js";

/**
 * Models served through the locally installed Claude Code CLI, billed to the user's
 * Claude subscription. The ids are Claude Code's own model aliases, so each one always
 * resolves to the newest model of its family without a catalog update. They are not
 * fetched from any provider catalog, which is why they live outside models.generated.ts.
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
	{ ...claudeCodeModel("opus", "Claude Opus (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS), featured: true },
	claudeCodeModel("sonnet", "Claude Sonnet (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS),
	claudeCodeModel("fable", "Claude Fable (Claude Code)", 1_000_000, ADAPTIVE_EFFORT_LEVELS),
	claudeCodeModel("haiku", "Claude Haiku (Claude Code)", 200_000, { off: null, xhigh: null, max: null }),
];
