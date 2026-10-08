import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { FooterComponent, quotaParkForms, renderStatusBar } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 中断-10 display half: the quota park countdown the status area renders from
 * the daemon's quota_park_status heartbeat (the connection-side forwarding is
 * pinned in agent-connection-daemon.test.ts). Also covers the 记忆-2 replay
 * hole: a stored ipython_state_pruned notice must survive transcript replay.
 */

beforeAll(() => {
	initTheme(undefined, false);
});

describe("quotaParkForms", () => {
	it("counts the wake down, fullest form first, provider only in the full form", () => {
		const forms = quotaParkForms({ remainingMs: 65 * 60 * 1000, provider: "anthropic" }).map(stripAnsi);
		expect(forms[0]).toBe("额度等待 anthropic · 1小时05分后恢复");
		expect(forms[1]).toBe("额度等待 · 1小时05分后恢复");
		expect(forms[2]).toBe("额度等待");
	});

	it("drops the duplicate full form when no provider is known", () => {
		const forms = quotaParkForms({ remainingMs: 45_000 }).map(stripAnsi);
		expect(forms).toEqual(["额度等待 · 45秒后恢复", "额度等待"]);
	});

	it("says the wake is firing instead of counting negative time", () => {
		const forms = quotaParkForms({ remainingMs: 0 }).map(stripAnsi);
		expect(forms[0]).toBe("额度等待 · 正在恢复");
	});

	it("reports an unknown wake (in-memory park) without a countdown", () => {
		const forms = quotaParkForms({}).map(stripAnsi);
		expect(forms).toEqual(["额度等待（恢复时间未知）", "额度等待"]);
	});

	it("adds the episode count on a re-park (第 N 次), provider first, count last", () => {
		const forms = quotaParkForms({ remainingMs: 65 * 60 * 1000, provider: "anthropic", parkCount: 3 }).map(stripAnsi);
		expect(forms[0]).toBe("额度等待 anthropic · 1小时05分后恢复 · 第 3 次");
		expect(forms[1]).toBe("额度等待 · 1小时05分后恢复 · 第 3 次");
		expect(forms[2]).toBe("额度等待 · 第 3 次");
	});

	it("omits the count on a first park and keeps it on an unknown wake", () => {
		expect(quotaParkForms({ remainingMs: 45_000, parkCount: 1 }).map(stripAnsi)).toEqual([
			"额度等待 · 45秒后恢复",
			"额度等待",
		]);
		expect(quotaParkForms({ parkCount: 2 }).map(stripAnsi)).toEqual([
			"额度等待（恢复时间未知） · 第 2 次",
			"额度等待 · 第 2 次",
		]);
	});

	it("keeps every status-bar layout within the width it claims (visibleWidth, narrow tier)", () => {
		const right = quotaParkForms({ remainingMs: 3_600_000, provider: "anthropic" });
		for (const width of [120, 60, 40, 24, 12]) {
			const line = renderStatusBar({ model: "glm-5.3-prime", subagents: 0, right }, width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
		}
		// A wide terminal shows the countdown; none of the forms carry a glyph
		// outside the U6 narrow-tier set (plain words and `·` only).
		const wide = stripAnsi(renderStatusBar({ model: "m", subagents: 0, right }, 120));
		expect(wide).toContain("额度等待 anthropic · 1小时00分后恢复");
		for (const form of right.map(stripAnsi)) {
			expect(form).toMatch(/^[0-9A-Za-z一-鿿·（） ]+$/);
		}
	});

	it("rides the footer status bar through the pull source", () => {
		const footer = new FooterComponent({ getGitBranch: () => null, getExtensionStatuses: () => new Map() } as never);
		footer.setStatusBarSource(() => ({
			model: "glm-5.3-prime",
			subagents: 0,
			right: quotaParkForms({ remainingMs: 90_000 }),
		}));
		const lines = footer.render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("额度等待 · 1分后恢复");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(100);
	});
});

describe("ipython_state_pruned replay", () => {
	it("pins the customType literal against the agent-session source it mirrors", () => {
		// The producer's literal is module-private in agent-session.ts; a rename
		// there must fail here instead of silently dropping the notice on replay.
		const source = readFileSync(resolve(__dirname, "../src/core/agent-session.ts"), "utf8");
		expect(source).toContain('customType: "ipython_state_pruned"');
	});

	function pruneNotice(display: boolean) {
		return {
			role: "custom" as const,
			customType: "ipython_state_pruned",
			content:
				"Kernel variables removed by the post-compaction snapshot: big_df.\n" +
				"Each exceeded the per-variable snapshot size limit, so it was deleted from the live Python kernel.",
			display,
			timestamp: Date.now(),
		};
	}

	it.each(["quiet", "legacy"] as const)("replays the prune notice instead of dropping it (%s)", (processMode) => {
		const components = buildConversationComponents([pruneNotice(true)], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode,
		});

		expect(components).toHaveLength(1);
		expect(components[0]).toBeInstanceOf(CustomMessageComponent);
		const rendered = stripAnsi(components[0]!.render(100).join("\n"));
		expect(rendered).toContain("ipython_state_pruned");
		expect(rendered).toContain("Kernel variables removed by the post-compaction snapshot: big_df.");
	});

	it("honors display:false even for the prune notice", () => {
		const components = buildConversationComponents([pruneNotice(false)], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(components).toHaveLength(0);
	});
});
