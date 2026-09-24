import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "../src/core/provider-fallback.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * An automatic switch (fallback chain, backup model, return to the primary) never
 * goes through model selection, so the footer kept naming the model that stopped
 * serving. The client re-reads the session's model on those events.
 */
const refreshServingModel = Reflect.get(InteractiveMode.prototype, "refreshServingModel") as (
	this: unknown,
) => Promise<void>;
const createDisplayedCustomMessageComponent = Reflect.get(
	InteractiveMode.prototype,
	"createDisplayedCustomMessageComponent",
) as (this: unknown, message: Record<string, unknown>) => { render(width: number): string[] };

const kimi = { provider: "faux", id: "faux-kimi" };
const primary = { provider: "faux", id: "faux-1" };

function fakeThis(serving: { provider: string; id: string }) {
	const connection = {
		getState: vi.fn(async () => ({
			sessionId: "s1",
			model: serving,
			serviceTier: "default",
			availableThinkingLevels: [],
		})),
	};
	return {
		agentConnection: connection,
		connectionState: { sessionId: "s1", model: kimi },
		applyModelSwitchUiState: vi.fn(),
	};
}

describe("footer model after automatic switches", () => {
	beforeAll(() => initTheme("dark"));

	test("repaints with the model the session serves now", async () => {
		const self = fakeThis(primary);
		await refreshServingModel.call(self);
		expect(self.applyModelSwitchUiState).toHaveBeenCalledWith(expect.objectContaining({ model: primary }), primary);
	});

	test("leaves the footer alone when nothing moved", async () => {
		const self = fakeThis(kimi);
		await refreshServingModel.call(self);
		expect(self.applyModelSwitchUiState).not.toHaveBeenCalled();
	});

	test("renders a fallback notice as one status row", () => {
		const row = createDisplayedCustomMessageComponent.call(
			{},
			{
				role: "custom",
				customType: PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
				content: "已切回原模型 faux-1（冷却期已过）",
				display: true,
				details: { kind: "return" },
				timestamp: 1,
			},
		);
		const text = stripAnsi(row.render(80).join("\n"));
		expect(text).toContain("已切回原模型 faux-1");
		expect(text).not.toContain(PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE);
	});
});
