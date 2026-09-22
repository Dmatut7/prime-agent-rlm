import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../src/core/agent-messages.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementOutcomeMessage } from "../src/core/messages.js";
import type { RefinementResult } from "../src/core/refinement/refinement.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { CollapsibleErrorComponent } from "../src/modes/interactive/components/collapsible-error.js";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.js";
import { FeatureHintComponent } from "../src/modes/interactive/components/feature-hint.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { SubagentSummaryLine, TrayInfoLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// LineAggregator treats array identity as its change signal, so a leaf that
// returns a fresh array every frame forces a transcript-wide rebuild. These
// tests pin the memoization contract: same inputs -> same reference, changed
// inputs or invalidate() -> new reference with unchanged content.

describe("component render caching", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("DynamicBorder reuses lines while width holds", () => {
		const border = new DynamicBorder();
		const first = border.render(40);
		expect(border.render(40)).toBe(first);
		expect(border.render(41)).not.toBe(first);

		const resized = border.render(40);
		border.invalidate();
		const refreshed = border.render(40);
		expect(refreshed).not.toBe(resized);
		expect(refreshed).toEqual(resized);
	});

	test("CollapsibleErrorComponent reuses lines while inputs hold", () => {
		const options = { text: "boom\n  at module (/app/x.py:3)" };
		const component = new CollapsibleErrorComponent(options);
		const collapsed = component.render(60);
		expect(component.render(60)).toBe(collapsed);
		expect(collapsed).toEqual(new CollapsibleErrorComponent(options).render(60));

		component.setExpanded(true);
		const expanded = component.render(60);
		expect(expanded).not.toBe(collapsed);
		expect(component.render(60)).toBe(expanded);

		component.setExpanded(false);
		expect(component.render(60)).not.toBe(expanded);

		const recollapsed = component.render(60);
		component.invalidate();
		const refreshed = component.render(60);
		expect(refreshed).not.toBe(recollapsed);
		expect(refreshed).toEqual(recollapsed);

		const empty = new CollapsibleErrorComponent({ text: "   " });
		expect(empty.render(60)).toBe(empty.render(60));
	});

	test("FeatureHintComponent reuses lines until the frame advances", () => {
		const hint = new FeatureHintComponent("try /model to switch");
		const first = hint.render(80);
		expect(hint.render(80)).toBe(first);

		hint.advance();
		const advanced = hint.render(80);
		expect(advanced).not.toBe(first);
		expect(hint.render(80)).toBe(advanced);

		hint.invalidate();
		const refreshed = hint.render(80);
		expect(refreshed).not.toBe(advanced);
		expect(refreshed).toEqual(advanced);
	});

	test("SubagentSummaryLine keys the cache on values, not setter identity", () => {
		const line = new SubagentSummaryLine();
		const first = line.render(120);
		expect(line.render(120)).toBe(first);

		// A fresh counts object with equal values must not miss the cache.
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		const withCounts = line.render(120);
		expect(withCounts).not.toBe(first);
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		expect(line.render(120)).toBe(withCounts);

		line.setSubagentCounts({ total: 3, running: 2, idle: 1, inactive: 0 });
		expect(line.render(120)).not.toBe(withCounts);

		const relabeled = line.render(120);
		line.focused = true;
		expect(line.render(120)).not.toBe(relabeled);

		const focused = line.render(120);
		line.invalidate();
		const refreshed = line.render(120);
		expect(refreshed).not.toBe(focused);
		expect(refreshed).toEqual(focused);
	});

	test("TrayInfoLine re-renders its getters on every frame (no cache)", () => {
		let contextLabel: string | undefined = "518k/1M (49%)";
		const line = new TrayInfoLine(
			() => undefined,
			() => contextLabel,
			() => undefined,
		);
		const first = line.render(120);
		expect(first.join("")).toContain("518k/1M (49%)");

		// Labels come from getters and can drift without any setter call.
		contextLabel = "530k/1M (51%)";
		expect(line.render(120)[0]).not.toBe(first[0]);
		expect(line.render(120).join("")).toContain("530k/1M (51%)");
	});

	test("FooterComponent returns a stable empty array", () => {
		const footer = new FooterComponent({} as ReadonlyFooterDataProvider);
		const first = footer.render(80);
		expect(first).toEqual([]);
		expect(footer.render(80)).toBe(first);
	});

	test("AgentMessageComponent body keeps a stable identity while expanded", () => {
		const message = createAgentSessionMessage({
			id: "agentmsg_cache",
			source: AGENT_MESSAGE_SOURCE,
			message: "multi-line\nbody content",
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		});
		// suppressLeadingSpace drops the Spacer child: pi-tui's Spacer is not yet
		// memoized and would mask the body component's identity at this level.
		const component = new AgentMessageComponent(message, undefined, { suppressLeadingSpace: true });
		component.setExpanded(true);
		const first = component.render(100);
		expect(component.render(100)).toBe(first);

		component.invalidate();
		const refreshed = component.render(100);
		expect(refreshed).not.toBe(first);
		expect(refreshed).toEqual(first);
	});

	test("RefinementOutcomeMessageComponent keeps a stable identity while collapsed", () => {
		const result: RefinementResult = {
			id: "refine-cache",
			summary: "Added local guidance.",
			rationale: "Requested.",
			expectedOutcome: "Responses rhyme.",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness/state.json",
			scope: "local",
		};
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result));
		const first = component.render(120);
		expect(component.render(120)).toBe(first);

		component.invalidate();
		const refreshed = component.render(120);
		expect(refreshed).not.toBe(first);
		expect(refreshed).toEqual(first);
	});
});
