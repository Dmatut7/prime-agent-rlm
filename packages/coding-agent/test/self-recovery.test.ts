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
		"测试都过了。接下来我把文档也更新一下。",
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
		"改好了，测试全部通过。接下来我可以帮你把文档也补上。",
		"结论如上。如需要，我再把脚本整理成命令。",
		"Fixed and verified. If you want, I can also add a regression test.",
		"All tests pass. I'll push to origin/main once you approve.",
		"I will run it against production after your go-ahead.",
		"I'll wait for your confirmation before deleting the old branch.",
		"Rewritten history is ready; I will not force-push until you say so.",
		"测试都过了。我会在你批准后推送到 main。",
		"迁移脚本写好了，你确认后我就对生产库执行。",
		"旧分支清单列好了，等你点头我再删。",
		"- self-recovery.ts：检测三类故障（工具步骤卡死、刚宣布还有下一步就停轮、子代理干完活不回话），每个动作落成会话条目供 duty-log 事后汇报。",
		"Should I also update the docs?",
		"I checked the plan; everything below is done and verified.",
	])("leaves %j alone", (text) => {
		expect(announcedNextStep(reply(text))).toBeUndefined();
	});

	// Each misfire costs the owner a paid turn and a false "提早停下" duty-log line; each miss leaves
	// an unattended run parked on a plan it never carried out.
	it.each([
		["a past-tense report after 我先/然后我", "我先检查了日志，然后我修改了配置文件。"],
		["a finished answer that says 现在我已经", "全部完成。现在我已经把所有测试跑通了。"],
		["a summary that follows 让我总结一下", "所有步骤都完成了。让我总结一下：改了三个文件。"],
		["the owner's own to-do list", "- [ ] 配置 API key"],
		["an owner to-do list with its intro", "代码已经改好。你需要自己完成：\n- [ ] 配置 API key\n- [ ] 重启服务"],
		["a step the owner takes next", "迁移脚本写好了。接下来你需要在服务器上执行它。"],
		["a future tense that promises no work", "I will keep this in mind."],
		["an English summary", "All done. Let me summarize: three files changed."],
		["the owner's next step in English", "The patch is in. Next step is for you to run the migration."],
	])("does not misfire on %s", (_name, text) => {
		expect(announcedNextStep(reply(text))).toBeUndefined();
	});

	it.each([
		["a plan with a self-check", "我先跑一下测试，看看是否需要进一步修改。"],
		["a plan with no pronoun", "开始修复这个问题。"],
		["an English next step", "Next step is updating the docs."],
		["a plan whose steps follow a colon", "定位好了。接下来我会：\n1. 改 footer.ts\n2. 跑测试"],
		["a plan that mentions an earlier past step", "日志看完了，接下来我去改配置。"],
	])("catches %s", (_name, text) => {
		expect(announcedNextStep(reply(text))).toBeDefined();
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
