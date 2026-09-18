import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import type { SpendPriceRates } from "../src/core/spend-pricing.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * The fullscreen top bar publishes the session's whole spend from the context
 * tree's own total (`totalUsage`), which is the money recorded on the messages.
 * A corrected rate has to reach that figure too: a user who fixed a price and
 * still sees the old number in the header has not been given the fix.
 */

const MODELS_JSON_RATES: SpendPriceRates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 };

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** A session whose child (kimi-k3) spent 1M input recorded at models.json's rate of 1. */
function sessionTree(): ContextTreeNode {
	const child: ContextTreeNode = {
		id: "sub-1",
		label: "worker",
		status: "done",
		model: { provider: "bailian", id: "kimi-k3" },
		ownUsage: usage(1_000_000, 0, 1),
		totalUsage: usage(1_000_000, 0, 1),
		children: [],
	};
	return {
		id: "root",
		label: "main agent",
		status: "active",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		ownUsage: usage(900, 100, 0.01),
		totalUsage: usage(1_000_900, 100, 1.01),
		children: [child],
	};
}

function createRefreshHarness(priceOverrides: Record<string, { input?: number; output?: number }>) {
	const tree = sessionTree();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		topBarCostRefresh: { generation: 0, lastSuccessGeneration: 0 },
		connectionState: { sessionId: "session-1" },
		agentConnection: { getContextTree: vi.fn(async () => tree) },
		uiServices: {
			// The real seam: the refresh reads the price book from here.
			settingsManager: { getSubagentSpendCellPriceOverrides: () => priceOverrides },
			modelRegistry: { find: vi.fn(() => ({ cost: MODELS_JSON_RATES })) },
		},
		ui: { requestRender: vi.fn() },
	});
	const refresh = Reflect.get(InteractiveMode.prototype, "refreshTopBarCost") as (this: typeof mode) => void;
	return { mode, refresh };
}

function reportedCost(mode: InteractiveMode & Record<string, unknown>): unknown {
	return Reflect.get(mode, "topBarCost");
}

describe("top bar spend under a price override", () => {
	it("adds the override's correction to the session total", async () => {
		const { mode, refresh } = createRefreshHarness({ "bailian/kimi-k3": { input: 7 } });
		refresh.call(mode);

		// Recorded 1.01 + (child corrected to 7 - recorded 1) = 7.01.
		await vi.waitFor(() => {
			expect(reportedCost(mode)).toEqual({ sessionId: "session-1", total: 7.01 });
		});
	});

	it("publishes the recorded total untouched while nothing is overridden", async () => {
		const { mode, refresh } = createRefreshHarness({});
		refresh.call(mode);

		await vi.waitFor(() => {
			expect(reportedCost(mode)).toEqual({ sessionId: "session-1", total: 1.01 });
		});
	});
	it("clamps the header at zero when the correction outruns an attribution-gap total", async () => {
		// Attribution-gap tree: the child's recorded money never reached
		// root.totalUsage (parent lookup miss), so zeroing its rate makes the
		// additive correction -5 against a recorded 0.01. Publishing -4.99
		// would show wrong money; the header clamps at zero instead.
		const child: ContextTreeNode = {
			id: "sub-gap",
			label: "worker",
			status: "done",
			model: { provider: "bailian", id: "kimi-k3" },
			ownUsage: usage(1_000_000, 0, 5),
			totalUsage: usage(1_000_000, 0, 5),
			children: [],
		};
		const tree: ContextTreeNode = {
			id: "root",
			label: "main agent",
			status: "active",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			ownUsage: usage(900, 100, 0.01),
			totalUsage: usage(900, 100, 0.01),
			children: [child],
		};
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			topBarCostRefresh: { generation: 0, lastSuccessGeneration: 0 },
			connectionState: { sessionId: "session-gap" },
			agentConnection: { getContextTree: vi.fn(async () => tree) },
			uiServices: {
				settingsManager: { getSubagentSpendCellPriceOverrides: () => ({ "bailian/kimi-k3": { input: 0 } }) },
				modelRegistry: { find: vi.fn(() => ({ cost: MODELS_JSON_RATES })) },
			},
			ui: { requestRender: vi.fn() },
		});
		const refresh = Reflect.get(InteractiveMode.prototype, "refreshTopBarCost") as (this: typeof mode) => void;
		refresh.call(mode);
		await vi.waitFor(() => {
			expect(reportedCost(mode)).toEqual({ sessionId: "session-gap", total: 0 });
		});
	});
});
