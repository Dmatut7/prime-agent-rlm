// 半落地尾巴②: a finish-gate nudge is the gate challenging an unproven
// done-claim, not a routine continue - it must wear its own label in both the
// collapsed notice line and the expanded header, on the live path and on replay.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { createAutoContinueMessage } from "../src/core/messages.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import {
	FINISH_GATE_RELEASED_CUSTOM_TYPE,
	InjectedPromptMessageComponent,
} from "../src/modes/interactive/components/injected-prompt-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
	initTheme("dark");
});

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function renderLines(component: InjectedPromptMessageComponent, width = 120): string[] {
	return stripAnsi(component.render(width).join("\n"))
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function finishGateNudge(excerpt?: string) {
	return createAutoContinueMessage(
		{ reason: "finish_gate", excerpt, ordinal: 1, maxOrdinal: 4 },
		Date.parse("2026-01-01T00:00:00.000Z"),
	);
}

describe("finish-gate nudge label", () => {
	test("collapsed notice names the finish gate, not a generic auto-continue", () => {
		const component = new InjectedPromptMessageComponent(finishGateNudge("修好了"));
		const text = renderLines(component).join("\n");
		expect(text).toContain("⚠ 完成核验 · 要求给出证据");
		expect(text).toContain("刚才说要「修好了」");
		expect(text).not.toContain("自动继续");
	});

	test("collapsed notice without an excerpt still explains the challenge", () => {
		const component = new InjectedPromptMessageComponent(finishGateNudge());
		const text = renderLines(component).join("\n");
		expect(text).toContain("⚠ 完成核验 · 要求给出证据");
		expect(text).toContain("完成声明没有证据");
	});

	test("expanded header keeps the finish-gate wording above the nudge body", () => {
		const component = new InjectedPromptMessageComponent(finishGateNudge("修好了"));
		component.setExpanded(true);
		const text = renderLines(component).join("\n");
		expect(text).toContain("完成核验：刚才说要「修好了」，要求给出证据");
		expect(text).toContain("[finish gate]");
		expect(text).not.toContain("自动继续");
	});

	test("an announced-next-step continue keeps the generic auto-continue label", () => {
		const component = new InjectedPromptMessageComponent(
			createAutoContinueMessage(
				{ reason: "announced_next_step", excerpt: "接下来跑测试", ordinal: 1, maxOrdinal: 4 },
				Date.parse("2026-01-01T00:00:00.000Z"),
			),
		);
		const text = renderLines(component).join("\n");
		expect(text).toContain("↻ 自动继续");
		expect(text).not.toContain("完成核验");
	});
});

describe("finish-gate nudge on the replay path", () => {
	const options = {
		ui: { requestRender: () => {} } as never,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
	};

	test.each(["legacy", "quiet"] as const)("buildConversationComponents renders the label (%s)", (processMode) => {
		const components = buildConversationComponents([finishGateNudge("修好了")], { ...options, processMode });
		expect(components.length).toBeGreaterThan(0);
		const text = stripAnsi(components.map((component) => component.render(120).join("\n")).join("\n"));
		expect(text).toContain("⚠ 完成核验 · 要求给出证据");
		expect(text).not.toContain("自动继续");
	});
});

describe("finish-gate release notice", () => {
	const options = {
		ui: { requestRender: () => {} } as never,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
	};

	function releaseNotice(details?: { excerpt?: string; strikes?: number }, display = true) {
		return {
			role: "custom" as const,
			customType: FINISH_GATE_RELEASED_CUSTOM_TYPE,
			content: "[finish gate] released an unverified completion claim.",
			display,
			details,
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		};
	}

	test("the customType mirrors the self-recovery record kind the release branch writes", () => {
		// The literals on the producer side are module-private; a rename there must
		// fail here instead of silently dropping the notice on the floor.
		const recovery = readFileSync(resolve(__dirname, "../src/core/self-recovery.ts"), "utf8");
		expect(recovery).toContain('"finish_gate_released"');
		const session = readFileSync(resolve(__dirname, "../src/core/agent-session.ts"), "utf8");
		expect(session).toContain('"finish_gate_released"');
	});

	test("collapsed notice says the claim went out unverified, not a generic continue", () => {
		const component = new InjectedPromptMessageComponent(releaseNotice({ excerpt: "修好了", strikes: 2 }));
		const text = renderLines(component).join("\n");
		expect(text).toContain("⚠ 完成核验 · 已放行（未验证）");
		expect(text).toContain("说要「修好了」的证据始终没给");
		expect(text).toContain("结论待你核对");
		expect(text).not.toContain("自动继续");
	});

	test("collapsed notice without an excerpt still says what to check", () => {
		const component = new InjectedPromptMessageComponent(releaseNotice({ strikes: 2 }));
		const text = renderLines(component).join("\n");
		expect(text).toContain("⚠ 完成核验 · 已放行（未验证）");
		expect(text).toContain("完成声明始终没给出证据");
	});

	test("expanded header counts the ignored challenges above the notice body", () => {
		const component = new InjectedPromptMessageComponent(releaseNotice({ excerpt: "修好了", strikes: 2 }));
		component.setExpanded(true);
		const text = renderLines(component).join("\n");
		expect(text).toContain("完成核验：说要「修好了」，连问 2 次仍无证据，已放行，结论待你核对");
		expect(text).toContain("[finish gate]");
		expect(text).not.toContain("自动继续");
	});

	test.each(["legacy", "quiet"] as const)("replays the release notice instead of dropping it (%s)", (processMode) => {
		const components = buildConversationComponents([releaseNotice({ excerpt: "修好了", strikes: 2 })], {
			...options,
			processMode,
		});
		expect(components.length).toBeGreaterThan(0);
		const text = stripAnsi(components.map((component) => component.render(120).join("\n")).join("\n"));
		expect(text).toContain("⚠ 完成核验 · 已放行（未验证）");
	});

	test("honors display:false on replay", () => {
		const components = buildConversationComponents([releaseNotice(undefined, false)], { ...options });
		expect(components).toHaveLength(0);
	});

	test("stays within the terminal width on the narrow tiers (U6)", () => {
		const component = new InjectedPromptMessageComponent(releaseNotice({ excerpt: "修好了", strikes: 2 }));
		for (const width of [40, 24, 12]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});
});
