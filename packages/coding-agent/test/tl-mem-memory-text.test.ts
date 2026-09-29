import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { KernelMemoryChange } from "../src/core/kernel/shared.js";
import { cleanMemoryTitle, shortMemoryTitle } from "../src/modes/interactive/components/feed-data.js";
import { memoryBodyLines, memoryHeadLabel } from "../src/modes/interactive/components/memory-detail.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line));
const squeeze = (value: string) => value.replace(/\s+/g, "");

function change(overrides: Partial<KernelMemoryChange> = {}): KernelMemoryChange {
	return { op: "created", kind: "memory", scope: "session", title: "规则", at: 1, ...overrides };
}

describe("memory titles read as words", () => {
	const table: Array<[string, string]> = [
		[
			"prime_agent_grow批次审查_20260929_四车道_无功能p0_但发版提交打红套件_256色撞码_未授权发版已推origin",
			"prime agent grow批次审查 四车道 无功能p0 但发版提交打红套件 256色撞码 未授权发版已推origin",
		],
		["user_prefers_short_answers_2026-09-28", "user prefers short answers"],
		["go_http_请求要带_context_2026-09-28", "go http 请求要带 context"],
		["eval100_0924百轮评估场_运行状态_评估后删", "eval100 0924百轮评估场 运行状态 评估后删"],
		["tone_guidance_2026_09_01", "tone guidance"],
		["completed_without_reply", "completed without reply"],
		["Rhyme response guidance", "Rhyme response guidance"],
		["已经 有 空格 的标题", "已经 有 空格 的标题"],
		["grow 批次审查结论（2026-09-29）", "grow 批次审查结论（2026-09-29）"],
		["部署口令", "部署口令"],
		["  many   spaces \t here ", "many spaces here"],
	];

	it("turns an id standing in for a title into words and leaves a real title alone", () => {
		expect(table.length).toBeGreaterThan(0);
		for (const [raw, expected] of table) {
			expect(cleanMemoryTitle(raw), raw).toBe(expected);
		}
	});

	it("never leaves an underscore, a middle dot or a full date in an id-shaped title", () => {
		const slug = "prime_agent_grow批次审查_20260929_四车道";
		const clean = cleanMemoryTitle(slug);
		expect(clean).not.toContain("_");
		expect(clean).not.toContain(" · ");
		expect(clean).not.toContain("20260929");
	});

	it("says something for an empty title", () => {
		expect(cleanMemoryTitle("   ")).toBe("（无标题）");
	});

	it("cuts at a word and marks the cut, never past the room", () => {
		const title = "prime agent grow 批次审查 四车道 无功能p0 但发版提交打红套件";
		const widths = [10, 20, 40];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const short = shortMemoryTitle(title, width);
			expect(visibleWidth(short), `at ${width}`).toBeLessThanOrEqual(width);
			expect(short.endsWith("…"), `at ${width}`).toBe(true);
			expect(title.startsWith(short.slice(0, -1)), `at ${width}`).toBe(true);
			expect(title.charAt(short.length - 1), `at ${width}`).toBe(" ");
		}
		expect(shortMemoryTitle("短标题", 40)).toBe("短标题");
		expect(shortMemoryTitle("一条很长很长的记忆标题没有空格可以断开", 10)).toMatch(/…$/);
	});
});

describe("an opened memory shows its words in full", () => {
	const longCjk = "记".repeat(200);
	const longAscii = "word ".repeat(60).trim();
	const after = `${longCjk}\n\n${longAscii}\n第三段  带缩进的一行`;

	it("wraps a new memory as plain text: nothing cut, no `+`, blank lines kept", () => {
		const widths = [12, 24, 40, 80, 120];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const lines = plain(memoryBodyLines(change({ after }), width));
			expect(squeeze(lines.join("")), `text at ${width}`).toBe(squeeze(after));
			for (const line of lines) {
				expect(line, `ellipsis at ${width}`).not.toContain("…");
				expect(line, `plus at ${width}`).not.toMatch(/^\s*\+ /);
				expect(visibleWidth(line), `width at ${width}`).toBeLessThanOrEqual(Math.max(4, width));
			}
			expect(
				lines.some((line) => line === ""),
				`blank line at ${width}`,
			).toBe(true);
		}
	});

	it("says only the lines that changed, and a rename in words", () => {
		const lines = plain(
			memoryBodyLines(
				change({ op: "updated", previousTitle: "旧规则", title: "规则", before: "一\n二", after: "一\n三" }),
				60,
			),
		);
		const out = lines.join("\n");
		expect(out).toContain("改名  旧规则 → 规则");
		expect(out).toContain("原来");
		expect(out).toContain("− 二");
		expect(out).toContain("现在");
		expect(out).toContain("+ 三");
		expect(out).not.toContain("一\n");
	});

	it("says what a delete removed, and that a secret was not kept", () => {
		const removed = plain(memoryBodyLines(change({ op: "deleted", before: "旧的内容" }), 60)).join("\n");
		expect(removed).toContain("删掉的");
		expect(removed).toContain("− 旧的内容");
		const secret = plain(memoryBodyLines(change({ op: "updated", textOmitted: "sensitive" }), 60)).join("\n");
		expect(secret).toContain("内容没存：看起来是密钥");
		expect(plain(memoryBodyLines(change({ op: "updated" }), 60)).join("\n")).toContain("没有记录到内容");
	});

	it("heads the row by what happened and what kind of thing it was", () => {
		expect(memoryHeadLabel(change())).toBe("记住了");
		expect(memoryHeadLabel(change({ op: "updated" }))).toBe("改了记忆");
		expect(memoryHeadLabel(change({ op: "deleted" }))).toBe("删了记忆");
		expect(memoryHeadLabel(change({ kind: "skill" }))).toBe("记住了技能");
		expect(memoryHeadLabel(change({ kind: "rules_file", scope: "project", op: "updated" }))).toBe("改了项目规则");
	});
});
