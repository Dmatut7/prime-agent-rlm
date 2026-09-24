import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { SubagentDetailOverlay } from "../src/modes/interactive/components/subagent-detail-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function child(overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {}): AgentConnectionRlmChildAgentSnapshot {
	return { id: "worker", label: "worker", status: "running", sessionDir: "/tmp/sessions/worker", ...overrides };
}

describe("SubagentDetailOverlay", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders status, model, usage, task, latest answer, and session dir from the snapshot", () => {
		const snapshot = child({
			id: "调研-云厂商",
			label: "调研-云厂商",
			sessionName: "调研-云厂商",
			model: "bailian/deepseek-v4.1",
			durationMs: 134_000,
			toolUseCount: 12,
			tokenCount: 345_600,
			repliedSinceTask: true,
			recap: "调研成都本地 GPU 厂商名单",
			answerPreview: "第一轮结论：3 家厂商符合条件",
			activity: { kind: "executing", toolName: "bash" },
			sessionDir: "/tmp/sessions/调研-云厂商",
		});
		const overlay = new SubagentDetailOverlay({ getChild: () => snapshot, onDismiss: () => {} });

		const wide = overlay.render(200);
		for (const line of wide.map(stripAnsi)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		}

		const body = overlay
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(body).toContain("子代理详情 · 调研-云厂商");
		expect(body).toContain("状态  运行 2:14 · 执行 bash");
		expect(body).toContain("模型  bailian/deepseek-v4.1");
		expect(body).toContain("用量  12 步 · 346k tok · 已回复");
		expect(body).toContain("任务  调研成都本地 GPU 厂商名单");
		expect(body).toContain("最新  第一轮结论：3 家厂商符合条件");
		expect(body).toContain("目录  /tmp/sessions/调研-云厂商");
		expect(body).toContain("关闭");
	});

	it("re-renders from the live getter, so an in-flight child updates in place", () => {
		let current: AgentConnectionRlmChildAgentSnapshot | undefined = child({ status: "running", recap: "正在调研" });
		const overlay = new SubagentDetailOverlay({ getChild: () => current, onDismiss: () => {} });

		expect(overlay.render(100).map(stripAnsi).join("\n")).toContain("运行");

		current = child({
			status: "done",
			answerPreview: "调研完成：共 5 家",
			recap: "调研成都本地 GPU 厂商名单",
		});
		const after = overlay.render(100).map(stripAnsi).join("\n");
		expect(after).toContain("完成");
		expect(after).toContain("调研完成：共 5 家");
	});

	it("shows the failed child's error block and caps long previews at eight lines", () => {
		const overlay = new SubagentDetailOverlay({
			getChild: () =>
				child({
					status: "error",
					error: "bash exited 1: no such file",
					answerPreview: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
				}),
			onDismiss: () => {},
		});
		const rendered = overlay.render(120).map(stripAnsi);

		expect(rendered.join("\n")).toContain("出错  bash exited 1: no such file");
		const previewLines = rendered.filter((line) => /line \d/.test(line));
		expect(previewLines).toHaveLength(8);
		expect(previewLines[7]).toContain("…");
	});

	it("renders the removed-state card when the child is no longer in the list", () => {
		const overlay = new SubagentDetailOverlay({ getChild: () => undefined, onDismiss: () => {} });
		const body = overlay.render(100).map(stripAnsi).join("\n");
		expect(body).toContain("子代理详情");
		expect(body).toContain("这个子代理已经不在列表里");
	});

	it("Esc dismisses the card; other escape-prefixed keys do not", () => {
		const onDismiss = vi.fn();
		const overlay = new SubagentDetailOverlay({ getChild: () => child(), onDismiss });

		overlay.handleInput("\x1b[A");
		expect(onDismiss).not.toHaveBeenCalled();

		overlay.handleInput("\x1b");
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
