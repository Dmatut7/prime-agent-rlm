import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { announcedNextStep, dutyEventFor } from "../src/core/self-recovery.js";

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("announcedNextStep", () => {
	it.each([
		"第一个文件看完了，接下来我去改第二个文件",
		"已经定位到原因。下一步：修改 footer.ts 并跑测试",
		"现在我来跑一遍测试",
		"Found it. Let me fix the parser next.",
		"Done with step one. I'll now update the tests:",
		"进度：\n- [x] 读代码\n- [ ] 改代码\n- [ ] 跑测试",
	])("reads %j as an announced next step", (text) => {
		expect(announcedNextStep(reply(text))).toBeDefined();
	});

	it.each([
		"改好了，所有测试都通过。",
		"结论：配置里的端口写错了，改成 8080 即可。",
		"要不要我接下来把测试也补上？",
		"子代理已派出，等待子代理回复。",
		"待命。",
		"Should I also update the docs?",
		"I checked the plan; everything below is done and verified.",
	])("leaves %j alone", (text) => {
		expect(announcedNextStep(reply(text))).toBeUndefined();
	});

	it("only looks at a clean stop", () => {
		expect(announcedNextStep(reply("接下来我去改第二个文件", "length"))).toBeUndefined();
		expect(announcedNextStep(reply("接下来我去改第二个文件", "aborted"))).toBeUndefined();
	});

	it("excerpts the announcing line", () => {
		expect(announcedNextStep(reply("分析如下。\n\n接下来我去改第二个文件"))).toBe("接下来我去改第二个文件");
	});
});

describe("dutyEventFor", () => {
	it("maps every self-recovery action to the duty-log event", () => {
		expect(
			dutyEventFor({
				kind: "stuck_step_stopped",
				toolCallId: "t",
				toolName: "ipython",
				step: "sleep 999",
				silentMs: 300_000,
				repeated: false,
				at: 1,
			}),
		).toEqual({ kind: "step_stuck_stopped", tool: "sleep 999", silentMs: 300_000 });
		expect(dutyEventFor({ kind: "auto_continue", excerpt: "接下来我去改", ordinal: 1, at: 1 })).toEqual({
			kind: "auto_continue",
			reason: "接下来我去改",
		});
		expect(dutyEventFor({ kind: "child_reply_nudge", at: 1 })).toEqual({
			kind: "auto_continue",
			reason: "child_reply_missing",
		});
	});
});
