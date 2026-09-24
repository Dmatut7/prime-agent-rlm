import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	DUTY_EVENT_CUSTOM_TYPE,
	type DutyEvent,
	formatDutyDuration,
	formatDutyLog,
	parseDutyEvent,
	readDutyLogEntries,
	summarizeDutyLog,
} from "../src/core/duty-log.js";
import { DUTY_LOG_MAX_ROWS, DutyLogBlock } from "../src/modes/interactive/components/duty-log-block.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-20T00:00:00Z");
let seq = 0;

function at(ms: number): string {
	return new Date(T0 + ms).toISOString();
}

function user(ms: number, text = "去把这批活干完"): object {
	return {
		type: "message",
		id: `u${seq++}`,
		parentId: null,
		timestamp: at(ms),
		message: { role: "user", content: text, timestamp: T0 + ms },
	};
}

function assistant(
	ms: number,
	options: { text?: string; tool?: boolean; stopReason?: string; errorMessage?: string; model?: string } = {},
): object {
	const content: object[] = [];
	if (options.text) content.push({ type: "text", text: options.text });
	if (options.tool) content.push({ type: "toolCall", id: `t${seq}`, name: "ipython", arguments: { code: "1" } });
	return {
		type: "message",
		id: `a${seq++}`,
		parentId: null,
		timestamp: at(ms),
		message: {
			role: "assistant",
			content,
			stopReason: options.stopReason ?? (options.tool ? "toolUse" : "stop"),
			...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
			model: options.model ?? "glm-5.3-prime",
			timestamp: T0 + ms,
		},
	};
}

function toolResult(ms: number, text: string): object {
	return {
		type: "message",
		id: `r${seq++}`,
		parentId: null,
		timestamp: at(ms),
		message: {
			role: "toolResult",
			toolCallId: "x",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: T0 + ms,
		},
	};
}

function customMessage(ms: number, customType: string, details: object): object {
	return {
		type: "custom_message",
		id: `c${seq++}`,
		parentId: null,
		timestamp: at(ms),
		customType,
		content: "",
		details,
		display: false,
	};
}

function dutyEvent(ms: number, event: DutyEvent): object {
	return {
		type: "custom",
		id: `d${seq++}`,
		parentId: null,
		timestamp: at(ms),
		customType: DUTY_EVENT_CUSTOM_TYPE,
		data: event,
	};
}

describe("summarizeDutyLog", () => {
	it("returns undefined when nothing happened after the owner's last message", () => {
		const entries = [assistant(0, { text: "旧的回答" }), user(HOUR)];
		expect(summarizeDutyLog({ entries, now: T0 + 5 * HOUR })).toBeUndefined();
	});

	it("measures the away time from the owner's last message and counts finished turns and working time", () => {
		const entries = [
			user(0, "早先的话"),
			assistant(60_000, { text: "早先的回答" }),
			user(HOUR),
			assistant(HOUR + 60_000, { tool: true }),
			toolResult(HOUR + 120_000, "ok"),
			assistant(HOUR + 180_000, { text: "第一件做完了。" }),
			// A six-hour idle gap is not work.
			assistant(7 * HOUR, { tool: true }),
			toolResult(7 * HOUR + 60_000, "ok"),
			assistant(7 * HOUR + 120_000, { text: "第二件也做完了。" }),
		];
		const summary = summarizeDutyLog({ entries, now: T0 + 10 * HOUR });
		expect(summary).toBeDefined();
		expect(summary?.awayMs).toBe(9 * HOUR);
		expect(summary?.finishedTurns).toBe(2);
		expect(summary?.activeMs).toBe(4 * 60_000);
		expect(summary?.incidents).toEqual([]);
		expect(summary?.lastDoing).toBe("第二件也做完了。");
	});

	it("counts provider errors, their downtime and the model the run recovered on", () => {
		const entries = [
			user(0),
			assistant(60_000, { stopReason: "error", errorMessage: "500 internal_server_error", model: "glm-5.3-prime" }),
			assistant(5 * 60_000, {
				stopReason: "error",
				errorMessage: "Throttling.ServiceOverloaded",
				model: "glm-5.3-prime",
			}),
			dutyEvent(20 * 60_000, {
				kind: "model_fallback",
				from: "glm-5.3-prime",
				to: "kimi-k3",
				reason: "provider_errors",
			}),
			assistant(21 * 60_000, { text: "换了模型，继续做完了。", model: "kimi-k3" }),
		];
		const summary = summarizeDutyLog({ entries, now: T0 + HOUR });
		const provider = summary?.incidents.find((incident) => incident.kind === "provider");
		expect(provider).toMatchObject({ count: 2, handled: 2, fallbackTo: "kimi-k3" });
		expect(provider?.downtimeMs).toBe(20 * 60_000);
		expect(formatDutyLog(summary!, T0 + HOUR)[2]).toBe(
			"出问题 2 次，都已自动处理：服务器报错 2 次（停了 20 分钟，自动换到 kimi-k3）",
		);
	});

	it("reports an outage still going on as not handled", () => {
		const entries = [user(0), assistant(60_000, { stopReason: "error", errorMessage: "429 rate limit" })];
		const summary = summarizeDutyLog({ entries, now: T0 + HOUR });
		expect(summary?.incidents).toEqual([{ kind: "provider", count: 1, handled: 0 }]);
		expect(formatDutyLog(summary!, T0 + HOUR)[2]).toContain("有 1 类还没处理");
	});

	it("reads stuck steps, auto-continues and child events from duty entries and existing notices", () => {
		const entries = [
			user(0),
			assistant(60_000, { tool: true }),
			toolResult(120_000, "tool_timeout: ipython made no progress for 180s"),
			dutyEvent(130_000, { kind: "step_stuck_stopped", tool: "ipython", silentMs: 300_000 }),
			dutyEvent(140_000, { kind: "auto_continue", reason: "plan_without_action" }),
			customMessage(150_000, "rlm_child_stall_notice", { childId: "c1", sessionName: "review", silentMs: 300_000 }),
			customMessage(160_000, "rlm_child_recovery_action", { childId: "c1", sessionName: "review", action: "abort" }),
			customMessage(170_000, "rlm_child_terminal_notice", { kind: "completed_without_reply", sessionName: "docs" }),
			customMessage(175_000, "empty_response_recovery", { attempts: 3 }),
			assistant(180_000, { text: "都做完了。" }),
		];
		const summary = summarizeDutyLog({
			entries,
			now: T0 + HOUR,
			children: [
				{ name: "review", state: "done" },
				{ name: "docs", state: "done" },
				{ name: "lint", state: "stalled" },
			],
		});
		const byKind = Object.fromEntries(summary!.incidents.map((incident) => [incident.kind, incident]));
		// The timeout result and the stuck-step entry are the same stall.
		expect(byKind.stuck).toMatchObject({ count: 1, handled: 1 });
		expect(byKind.early_stop).toMatchObject({ count: 1, handled: 1 });
		expect(byKind.child_stuck).toMatchObject({ count: 1, handled: 1 });
		expect(byKind.child_silent).toMatchObject({ count: 1, handled: 1 });
		expect(byKind.empty).toMatchObject({ count: 1, handled: 1 });
		const lines = formatDutyLog(summary!, T0 + HOUR);
		expect(lines[1]).toContain("子代理 3 个（2 完成 · 1 卡住）");
		expect(lines[2]).toMatch(/^出问题 5 次，都已自动处理：/);
		expect(lines[2]).toContain("命令卡住 1 次（已停掉，AI 换了办法）");
		expect(lines[2]).toContain("提早停下 1 次（已自动继续）");
	});

	it("lists an unanswered question as a decision for the owner", () => {
		const entries = [
			user(0),
			assistant(60_000, { text: "清理做完了。旧分支 feat/x 还留着，要不要删掉？" }),
			dutyEvent(70_000, { kind: "decision_needed", question: "是否把结果推到远程" }),
		];
		const summary = summarizeDutyLog({ entries, now: T0 + 3 * HOUR });
		expect(summary?.pending.map((item) => item.question)).toEqual([
			"旧分支 feat/x 还留着，要不要删掉？",
			"是否把结果推到远程",
		]);
		const lines = formatDutyLog(summary!, T0 + 3 * HOUR);
		expect(lines).toContain("需要你拍板：2 件 —— 「旧分支 feat/x 还留着，要不要删掉？」 等（2 小时 59 分前）");
	});

	it("flags a run that ended on a plan it never carried out", () => {
		const entries = [user(0), assistant(60_000, { text: "测试都过了。接下来我把文档也更新一下。" })];
		const summary = summarizeDutyLog({ entries, now: T0 + HOUR });
		expect(summary?.unfinished).toBe("测试都过了。接下来我把文档也更新一下。");
		expect(formatDutyLog(summary!, T0 + HOUR)).toContain(
			"可能没做完：最后停在「测试都过了。接下来我把文档也更新一下。」",
		);
	});

	it("turns a stopped long-running goal into a decision", () => {
		const entries = [
			user(0),
			assistant(60_000, { text: "目标进度 80%。" }),
			{
				type: "custom",
				id: "g",
				parentId: null,
				timestamp: at(90_000),
				customType: "thread_goal_state",
				data: { status: "budget_limited" },
			},
		];
		expect(summarizeDutyLog({ entries, now: T0 + HOUR })?.pending[0]?.question).toBe("长期目标预算用完，要不要继续");
	});

	it("strips Markdown markers from the recap lines", () => {
		const entries = [user(0), assistant(60_000, { text: "**全停干净了**：`npm run check` 通过。" })];
		expect(summarizeDutyLog({ entries, now: T0 + HOUR })?.lastDoing).toBe("全停干净了：npm run check 通过。");
	});

	it("prefers the session's own status summary for what it was last doing", () => {
		const entries = [
			user(0),
			assistant(60_000, { text: "第一步好了。" }),
			{
				type: "agent_status",
				id: "s",
				parentId: null,
				timestamp: at(70_000),
				status: { summary: "在改 footer 的上下文数字", basedOnMessageCount: 3 },
			},
		];
		expect(summarizeDutyLog({ entries, now: T0 + HOUR })?.lastDoing).toBe("在改 footer 的上下文数字");
	});

	it("ignores unknown and malformed duty entries", () => {
		expect(parseDutyEvent({ kind: "nope" })).toBeUndefined();
		expect(parseDutyEvent({ kind: "model_fallback" })).toBeUndefined();
		expect(parseDutyEvent(null)).toBeUndefined();
		const entries = [
			user(0),
			{
				type: "custom",
				id: "x",
				parentId: null,
				timestamp: at(1000),
				customType: DUTY_EVENT_CUSTOM_TYPE,
				data: { kind: "nope" },
			},
			"not an entry",
			assistant(60_000, { text: "好了。" }),
		];
		expect(summarizeDutyLog({ entries, now: T0 + HOUR })?.incidents).toEqual([]);
	});
});

describe("formatDutyDuration", () => {
	it("reads in minutes, hours and days", () => {
		expect(formatDutyDuration(30_000)).toBe("不到 1 分钟");
		expect(formatDutyDuration(25 * 60_000)).toBe("25 分钟");
		expect(formatDutyDuration(3 * HOUR + 10 * 60_000)).toBe("3 小时 10 分");
		expect(formatDutyDuration(76 * HOUR)).toBe("3 天 4 小时");
	});
});

describe("readDutyLogEntries", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reads only the tail, skipping the header, a cut first line and garbage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "duty-log-"));
		dirs.push(dir);
		const file = join(dir, "s.jsonl");
		const lines = [
			JSON.stringify({ type: "session", id: "s", cwd: "/w" }),
			JSON.stringify(user(0, "x".repeat(200))),
			"{broken",
			JSON.stringify(assistant(1000, { text: "好了。" })),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);
		const all = await readDutyLogEntries(file);
		expect(all).toHaveLength(2);
		const tail = await readDutyLogEntries(file, lines[3]!.length + 20);
		expect(tail).toHaveLength(1);
	});
});

describe("DutyLogBlock", () => {
	beforeAll(() => initTheme("dark"));

	const summary = summarizeDutyLog({
		entries: [
			user(0),
			assistant(60_000, { stopReason: "error", errorMessage: "500" }),
			dutyEvent(120_000, { kind: "model_fallback", to: "kimi-k3", reason: "provider_errors" }),
			assistant(20 * 60_000, { tool: true, model: "kimi-k3" }),
			toolResult(21 * 60_000, "tool_timeout: stuck"),
			dutyEvent(22 * 60_000, { kind: "auto_continue" }),
			customMessage(23 * 60_000, "rlm_child_terminal_notice", {
				kind: "completed_without_reply",
				sessionName: "docs",
			}),
			assistant(24 * 60_000, { text: "都处理好了，旧分支 feat/x 要不要删？", model: "kimi-k3" }),
		],
		now: T0 + 76 * HOUR,
		children: [
			{ name: "a", state: "done" },
			{ name: "b", state: "stalled" },
		],
	});

	for (const width of [80, 120]) {
		it(`stays within ${width} columns and ${DUTY_LOG_MAX_ROWS} rows`, () => {
			expect(summary).toBeDefined();
			const rows = new DutyLogBlock(formatDutyLog(summary!, T0 + 76 * HOUR)).render(width);
			const content = rows.slice(0, -1);
			expect(content.length).toBeGreaterThan(3);
			expect(content.length).toBeLessThanOrEqual(DUTY_LOG_MAX_ROWS);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			const plain = content.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
			expect(plain[0]).toBe(" 值班记录 · 离开 3 天 4 小时");
			expect(plain.some((row) => row.includes("需要你拍板：1 件"))).toBe(true);
			// Chinese throughout: only model ids, branch names and "AI" stay Latin.
			expect(plain.join("").replace(/kimi-k3|glm-5\.3-prime|feat\/x/g, "")).not.toMatch(/[A-Za-z]{3,}/);
		});
	}
});
